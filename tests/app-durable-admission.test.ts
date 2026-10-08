import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteEnvironmentAppStore } from '../src/environment-apps/sqlite-registry.js';
import { assertAppAdmission } from '../src/environment-apps/admission-gate.js';
import { ControlledAppLauncher } from '../src/environment-apps/launcher.js';
import { AppOnboardingService } from '../src/environment-apps/onboarding.js';
import type { EnvironmentAppScope, AppCandidate } from '../src/contracts/environment-apps.js';
import type { ManagedAppLaunchBackend } from '../src/contracts/app-launch.js';
import { appTaskBridgeFixture } from './fixtures/app-task-bridge.js';
import { taskAppFixture } from './fixtures/task-app-onboarding.js';

const time = '2026-10-08T07:00:00.000Z';
const scope: EnvironmentAppScope = { providerId: 'physical', environmentId: 'synthetic-host', installationScopeId: 'synthetic-domain' };
const candidate: AppCandidate = { scope, installationId: 'synthetic-install', applicationId: 'synthetic-music',
  displayName: 'Synthetic Music', aliases: [], launchSpec: { kind: 'exe', executable: 'C:\\Synthetic\\Music.exe', args: [] },
  identity: { productId: 'synthetic-product', version: '1', fingerprint: 'synthetic-fingerprint' },
  source: { kind: 'manual', reference: 'synthetic-only', observedAt: time } };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'app-denial-')), path = join(dir, 'apps.sqlite');
  const store = new SqliteEnvironmentAppStore(path, () => time), registry = store.bind(scope);
  const found = registry.discover(candidate);
  const confirmed = registry.confirm({ appBindingId: found.appBindingId, expectedRevision: found.revision,
    profileDigest: found.profileDigest, operatorId: 'synthetic-operator' });
  const app = registry.recordVerification(confirmed.appBindingId, confirmed.revision, { scope, profileRevision: confirmed.profileRevision,
    profileDigest: confirmed.profileDigest, checkedAt: time, result: 'verified', identity: candidate.identity,
    processOwnershipVerified: true, windowOwnershipVerified: true, evidence: 'synthetic-only' });
  return { dir, path, store, registry, app, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('disk denial is visible to existing and fresh connections without changing Registry validity; all writers stay closed', () => {
  const f = fixture();
  const other = new SqliteEnvironmentAppStore(f.path), registry = other.bind(scope);
  try {
    assertAppAdmission(f.registry, f.app.appBindingId);
    registry.requireLaunchProfile(f.app.appBindingId, f.app.revision);
    f.store.beginAppDenial(scope, f.app.appBindingId, f.app.revision, 'synthetic-revoke');
    assert.equal(registry.get(f.app.appBindingId)!.validity, 'current');
    for (const view of [f.registry, registry]) {
      assert.throws(() => assertAppAdmission(view, f.app.appBindingId), /denied-pending/);
      assert.throws(() => view.requireLaunchProfile(f.app.appBindingId, f.app.revision), /denied-pending/);
      assert.throws(() => view.setAvailability(f.app.appBindingId, f.app.revision, true), /denied-pending/);
      assert.throws(() => view.markStale(f.app.appBindingId, f.app.revision, 'synthetic-change'), /denied-pending/);
      assert.throws(() => view.revoke(f.app.appBindingId, f.app.revision, 'synthetic-change'), /denied-pending/);
      assert.throws(() => view.confirm({ appBindingId: f.app.appBindingId, expectedRevision: f.app.revision,
        profileDigest: f.app.profileDigest, operatorId: 'synthetic' }), /denied-pending/);
      assert.throws(() => view.recordVerification(f.app.appBindingId, f.app.revision, f.app.verifications[0]), /denied-pending/);
      assert.throws(() => view.discover({ ...candidate, installationId: 'new-install', identity: { ...candidate.identity!, version: '2' } }), /denied-pending/);
    }
    assert.throws(() => other.bind({ ...scope, installationScopeId: 'new-domain' }), /scope-change/);
    assert.equal(registry.history(f.app.appBindingId).length, 3);
  } finally { other.close(); f.close(); }
});

test('committed disk intent survives abrupt writer process exit; fresh launcher and reuse cannot mint any permit or target', async () => {
  const f = fixture(); f.store.close();
  const script = `import { SqliteEnvironmentAppStore } from './src/environment-apps/sqlite-registry.ts';
    const store = new SqliteEnvironmentAppStore(process.env.APP_DENIAL_TEST_DB);
    const scope = ${JSON.stringify(scope)};
    const app = store.bind(scope).list()[0];
    store.beginAppDenial(scope, app.appBindingId, app.revision, 'synthetic-crash');
    process.exit(0); // no store.close(), no native ACK or final Registry write`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
    { cwd: process.cwd(), env: { ...process.env, APP_DENIAL_TEST_DB: f.path }, encoding: 'utf8' });
  const reopened = new SqliteEnvironmentAppStore(f.path), registry = reopened.bind(scope);
  try {
    assert.equal(child.status, 0, child.stderr);
    assert.equal(registry.get(f.app.appBindingId)!.validity, 'current');
    let inspections = 0, opens = 0;
    const backend: ManagedAppLaunchBackend = { scope, inspect: async launchSpec => {
      inspections++; return { scope, launchSpec, identity: candidate.identity! };
    }, open: async () => { opens++; throw new Error('must-not-open'); } };
    const launcher = new ControlledAppLauncher(backend);
    assert.throws(() => launcher.authorize(registry, f.app.appBindingId, f.app.revision, new AbortController().signal, () => {}), /denied-pending/);
    const service = new AppOnboardingService(registry, { scope } as never, launcher);
    assert.throws(() => service.reuse({ appBindingId: f.app.appBindingId, expectedRevision: f.app.revision,
      operationId: 'fresh-host-reuse' }, 'synthetic'), /denied-pending/);
    await service.close();
    assert.equal(inspections, 0); assert.equal(opens, 0);
  } finally { reopened.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('failed denial commit and unreadable journal refuse admission; damaged existing journal is never silently recreated', () => {
  const f = fixture(), sql = new DatabaseSync(f.path), other = new SqliteEnvironmentAppStore(f.path);
  const otherRegistry = other.bind(scope);
  try {
    sql.exec("CREATE TRIGGER synthetic_write_failure BEFORE INSERT ON private_app_denials BEGIN SELECT RAISE(ABORT, 'synthetic-no-write'); END");
    assert.throws(() => f.store.beginAppDenial(scope, f.app.appBindingId, f.app.revision, 'synthetic-revoke'), /synthetic-no-write/);
    assert.equal((sql.prepare('SELECT count(*) AS n FROM private_app_denials').get() as { n: number }).n, 0);
    assert.equal(f.registry.get(f.app.appBindingId)!.validity, 'current');
    assert.throws(() => assertAppAdmission(f.registry, f.app.appBindingId), /storage-unavailable/);
    sql.exec('DROP TABLE private_app_denials');
    assert.throws(() => assertAppAdmission(otherRegistry, f.app.appBindingId), /no such table/);
    assert.throws(() => new SqliteEnvironmentAppStore(f.path), /storage-incomplete/);
  } finally { other.close(); sql.close(); f.close(); }
});

test('persistent gate wins a claimed bridge handoff status await without creating any Worker', async () => {
  const f = await appTaskBridgeFixture();
  try {
    f.hooks.status = async () => {
      f.store.beginAppDenial(f.scope, f.profile.appBindingId, f.profile.revision, 'synthetic-revoke');
      return { state: 'open', readiness: {} };
    };
    await assert.rejects(f.bridge.connectAppRuntime(f.session, '', f.binding()), /denied-pending/);
    assert.equal('appTrustFence' in f.bridge, false);
    assert.equal(f.counters.starts, 0);
  } finally { await f.close(); }
});

test('new Task and resumed input admission both reject a disk-pending profile with zero new leases/models/business effects', async () => {
  const f = await taskAppFixture();
  try {
    const first = f.submit(), waiting = await f.wait(first, state => state.appOnboarding?.state === 'candidates');
    const app = waiting.appOnboarding!, pick = app.candidates[0];
    await f.controller.onboardApp(first, { desktopTarget: f.target, interactionId: app.interactionId, action: 'confirm',
      candidateId: pick.candidateId, candidateRevision: pick.candidateRevision });
    await f.wait(first, state => state.appOnboarding?.state === 'ready' && !!state.observation && state.status === 'waiting_user');
    const profile = f.apps.forEnvironment(f.target).registry.list()[0], before = { ...f.counters };
    f.store.beginAppDenial(f.scope, profile.appBindingId, profile.revision, 'synthetic-revoke');
    const second = f.submit();
    await f.wait(second, state => state.appOnboarding?.state === 'unavailable' || state.appOnboarding?.state === 'new_task_required');
    // A ready old Task must not acquire fresh input/model authority on continuation.
    f.controller.resume(first, { approved: true });
    await f.wait(first, state => state.status === 'failed' || state.status === 'waiting_user' && !!state.error);
    assert.equal(f.counters.leases, before.leases); assert.equal(f.counters.models, before.models);
    assert.equal(f.counters.businessEffects, before.businessEffects); assert.equal(f.counters.starts, before.starts);
    assert.equal(f.counters.genericRuntime, 0);
  } finally { await f.close(); }
});

test('copied or legacy Registry facades cannot bypass the persistent Task/input gate', () => {
  const f = fixture();
  try {
    const copy = Object.freeze({ ...f.registry });
    assert.throws(() => assertAppAdmission(copy, f.app.appBindingId), /storage-unavailable/);
    assertAppAdmission(f.registry, f.app.appBindingId);
    f.store.beginAppDenial(scope, f.app.appBindingId, f.app.revision, 'synthetic-revoke');
    assert.throws(() => copy.requireLaunchProfile(f.app.appBindingId, f.app.revision), /denied-pending/);
    assert.throws(() => assertAppAdmission(copy, f.app.appBindingId), /storage-unavailable/);
  } finally { f.close(); }
});
