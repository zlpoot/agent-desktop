import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import type { AppCandidate, AppLaunchVerification, EnvironmentAppBinding, EnvironmentAppRegistry,
  EnvironmentAppScope, AppLaunchSpec } from '../src/contracts/environment-apps.js';
import { SqliteEnvironmentAppStore } from '../src/environment-apps/sqlite-registry.js';
import { importLegacyApps } from '../src/environment-apps/legacy-import.js';
import { modelAppView, profileDigest } from '../src/environment-apps/validation.js';
import { composeEnvironmentApps } from '../src/composition/environment-apps.js';
import { createRootAssembly } from '../src/composition/root.js';
import { assertDesktopCapabilities } from '../src/desktop-provider/admission.js';

const time = '2026-10-07T05:00:00.000Z';
const physical: EnvironmentAppScope = { providerId: 'physical', environmentId: 'host', installationScopeId: 'synthetic-user-domain' };
const local: EnvironmentAppScope = { ...physical, providerId: 'local-workspace', environmentId: 'hidden' };
const vmA: EnvironmentAppScope = { providerId: 'hyper-v', environmentId: 'vm-a', installationScopeId: 'synthetic-vm-a' };
const vmB: EnvironmentAppScope = { ...vmA, environmentId: 'vm-b', installationScopeId: 'synthetic-vm-b' };

function candidate(scope = physical, installationId = 'install-one', launchSpec?: AppLaunchSpec): AppCandidate {
  return { scope, installationId, applicationId: 'qq-music', displayName: 'QQ音乐', aliases: ['音乐'],
    launchSpec: launchSpec ?? { kind: 'exe', executable: resolve('synthetic-app', `${installationId}.exe`), args: ['--synthetic'] },
    identity: { productId: 'synthetic-qq', version: '1.0', fingerprint: `synthetic-content:${installationId}` },
    source: { kind: 'discovery', reference: 'fake-adapter', observedAt: time } };
}
function confirm(registry: EnvironmentAppRegistry, app: EnvironmentAppBinding): EnvironmentAppBinding {
  return registry.confirm({ appBindingId: app.appBindingId, expectedRevision: app.revision,
    profileDigest: app.profileDigest, operatorId: 'synthetic-operator' });
}
function receipt(app: EnvironmentAppBinding): AppLaunchVerification {
  return { scope: app.scope, profileRevision: app.profileRevision, profileDigest: app.profileDigest,
    checkedAt: time, result: 'verified', identity: app.identity, processOwnershipVerified: true,
    windowOwnershipVerified: true, evidence: 'fake-process-and-window-identity' };
}
function verified(registry: EnvironmentAppRegistry): EnvironmentAppBinding {
  const app = confirm(registry, registry.discover(candidate(registry.scope)));
  return registry.recordVerification(app.appBindingId, app.revision, receipt(app));
}

test('no environment rejects before adapter calls; same-name apps in Host/VM-A/VM-B never overlap', () => {
  const store = new SqliteEnvironmentAppStore(':memory:', () => time);
  try {
    let scans = 0;
    const services = composeEnvironmentApps(store, [physical, vmA, vmB].map(scope => ({ scope,
      discovery: { scope, async scan() { scans++; return { status: 'complete' as const, candidates: [] }; },
        async inspect() { throw new Error('not-called'); } } })));
    for (const target of [undefined, {}, { providerId: '', environmentId: 'host' }]) {
      assert.throws(() => services.forEnvironment(target as never), /invalid-desktop-target/);
    }
    assert.throws(() => store.bind({ ...physical, installationScopeId: '' }), /invalid-app-text/);
    assert.equal(scans, 0);
    const registries = [physical, vmA, vmB].map(scope => services.forEnvironment(scope).registry);
    const apps = registries.map(registry => registry.discover(candidate(registry.scope)));
    assert.equal(new Set(apps.map(app => app.appBindingId)).size, 3);
    registries.forEach((registry, index) => {
      assert.equal(registry.list().length, 1);
      assert.equal(registry.get(apps[(index + 1) % 3].appBindingId), undefined);
      assert.throws(() => registry.confirm({ appBindingId: apps[(index + 1) % 3].appBindingId,
        expectedRevision: 1, profileDigest: apps[index].profileDigest, operatorId: 'fake' }), /not-found/);
      assert.throws(() => registry.discover(candidate(apps[(index + 1) % 3].scope)), /environment-mismatch/);
    });
    assert.equal(scans, 0);
  } finally { store.close(); }
});

test('shared installation domain does not share Physical/Local Workspace confirmation or verification', () => {
  const store = new SqliteEnvironmentAppStore(':memory:', () => time);
  try {
    const a = store.bind(physical), b = store.bind(local);
    const first = verified(a), second = b.discover(candidate(local));
    assert.equal(first.trust, 'verified'); assert.equal(second.trust, 'discovered');
    assert.notEqual(first.profileDigest, second.profileDigest);
    assert.throws(() => b.requireLaunchProfile(second.appBindingId, second.revision), /not-reusable/);
    const confirmed = confirm(b, second);
    assert.throws(() => b.recordVerification(confirmed.appBindingId, confirmed.revision, receipt(first)), /verification-mismatch/);
    assert.equal(b.get(second.appBindingId)!.verifications.length, 0);
  } finally { store.close(); }
});

test('same names and aliases preserve distinct installations and return ambiguity instead of first match', () => {
  const store = new SqliteEnvironmentAppStore(':memory:', () => time);
  try {
    const registry = store.bind(physical);
    const a = confirm(registry, registry.discover(candidate()));
    const next = { ...candidate(physical, 'portable-two'), identity: { productId: 'synthetic-qq', version: '2.0', fingerprint: 'second' } };
    const b = confirm(registry, registry.discover(next));
    assert.notEqual(a.appBindingId, b.appBindingId);
    for (const name of ['QQ音乐', '音乐', 'qq-music']) assert.equal(registry.resolveName(name).kind, 'ambiguous');
    assert.equal(registry.resolveName('unknown').kind, 'not-found');
    registry.revoke(b.appBindingId, b.revision, 'operator-revoked');
    assert.equal(registry.resolveName('音乐').kind, 'unique');
  } finally { store.close(); }
});

test('trust progresses explicitly, confirmation is revision/digest bound and never triggers a launcher', () => {
  const store = new SqliteEnvironmentAppStore(':memory:', () => time);
  try {
    let launches = 0;
    const registry = composeEnvironmentApps(store, [{ scope: physical, launcher: { scope: physical,
      async verify() { launches++; throw new Error('must-not-launch'); } } }]).forEnvironment(physical).registry;
    const discovered = registry.discover(candidate());
    assert.equal(discovered.trust, 'discovered'); assert.equal(registry.resolveName('音乐').kind, 'not-found');
    assert.throws(() => registry.requireLaunchProfile(discovered.appBindingId, 1), /not-reusable/);
    assert.throws(() => registry.recordVerification(discovered.appBindingId, 1, receipt(discovered)), /not-reusable/);
    assert.throws(() => registry.confirm({ appBindingId: discovered.appBindingId, expectedRevision: 1,
      profileDigest: 'different-display', operatorId: 'operator' }), /confirmation-mismatch/);
    const app = confirm(registry, discovered);
    assert.equal(app.trust, 'confirmed'); assert.equal(app.verifications.length, 0);
    assert.throws(() => confirm(registry, discovered), /revision-conflict/);
    assert.throws(() => confirm(registry, app), /confirmation-mismatch/);
    const result = registry.recordVerification(app.appBindingId, app.revision, receipt(app));
    assert.equal(result.trust, 'verified'); assert.equal(launches, 0);
    assert.throws(() => assertDesktopCapabilities(['input.semantic'], { providerId: physical.providerId,
      environmentKind: 'physical', application: result.applicationId, applicationVersion: result.identity!.version,
      targetRole: 'editor', action: 'edit', mechanism: 'uia' }, { provider: {}, session: {}, target: {} },
      { session: {}, target: {} }), /missing/);
  } finally { store.close(); }
});

test('verification requires exact identity/version, process and window ownership and fresh confirmation', () => {
  const store = new SqliteEnvironmentAppStore(':memory:', () => time);
  try {
    const registry = store.bind(physical), app = confirm(registry, registry.discover(candidate()));
    for (const wrong of [
      { ...receipt(app), processOwnershipVerified: false },
      { ...receipt(app), windowOwnershipVerified: false },
      { ...receipt(app), identity: { ...app.identity!, version: '2.0' } },
      { ...receipt(app), identity: { ...app.identity!, fingerprint: 'replaced-file' } },
      { ...receipt(app), identity: undefined },
      { ...receipt(app), checkedAt: '2026-10-06T00:00:00Z' },
      { ...receipt(app), sessionId: 'must-not-persist' },
    ]) assert.throws(() => registry.recordVerification(app.appBindingId, app.revision, wrong));
    assert.equal(registry.get(app.appBindingId)!.revision, app.revision);
    assert.equal(registry.get(app.appBindingId)!.verifications.length, 0);
  } finally { store.close(); }
});

test('configuration/identity drift is stale, old confirmation cannot authorize new profile', () => {
  for (const change of [
    (c: AppCandidate) => ({ ...c, launchSpec: { kind: 'exe' as const, executable: resolve('synthetic-replacement.exe'), args: [] } }),
    (c: AppCandidate) => ({ ...c, launchSpec: { kind: 'exe' as const, executable: resolve('synthetic-app/install-one.exe'), args: ['--changed'] } }),
    (c: AppCandidate) => ({ ...c, identity: { ...c.identity!, version: '2.0' } }),
    (c: AppCandidate) => ({ ...c, identity: { ...c.identity!, fingerprint: 'changed-signature-or-permissions' } }),
    (c: AppCandidate) => ({ ...c, displayName: 'Changed displayed name' }),
  ]) {
    const store = new SqliteEnvironmentAppStore(':memory:', () => time);
    try {
      const registry = store.bind(physical), old = verified(registry);
      assert.throws(() => registry.discover(change(candidate())), /revision-conflict/);
      const drifted = registry.discover(change(candidate()), old.revision);
      assert.equal(drifted.validity, 'stale'); assert.equal(drifted.trust, 'discovered');
      assert.equal(drifted.profileRevision, old.profileRevision + 1);
      assert.equal(drifted.confirmations.length, 1); assert.equal(drifted.verifications.length, 1);
      assert.throws(() => registry.requireLaunchProfile(drifted.appBindingId, drifted.revision), /not-reusable/);
      assert.throws(() => registry.confirm({ appBindingId: old.appBindingId, expectedRevision: drifted.revision,
        profileDigest: old.profileDigest, operatorId: 'operator' }), /confirmation-mismatch/);
      const reconfirmed = confirm(registry, drifted);
      assert.equal(reconfirmed.trust, 'confirmed'); assert.equal(reconfirmed.validity, 'current');
      assert.equal(reconfirmed.confirmations.length, 2);
      assert.equal(registry.history(old.appBindingId).length, 5);
    } finally { store.close(); }
  }
});

test('offline/permission failure preserves trust and audit; availability cannot clear stale or revoked', () => {
  const store = new SqliteEnvironmentAppStore(':memory:', () => time);
  try {
    const registry = store.bind(physical), app = verified(registry);
    const unavailable = registry.recordVerification(app.appBindingId, app.revision, {
      ...receipt(app), result: 'unavailable', identity: undefined, processOwnershipVerified: false,
      windowOwnershipVerified: false, reason: 'permission-denied' });
    assert.equal(unavailable.trust, 'verified'); assert.equal(unavailable.validity, 'current');
    assert.equal(unavailable.lastError, 'permission-denied'); assert.equal(unavailable.confirmations.length, 1);
    assert.throws(() => registry.requireLaunchProfile(app.appBindingId, unavailable.revision), /not-reusable/);
    const online = registry.setAvailability(app.appBindingId, unavailable.revision, true);
    assert.equal(registry.requireLaunchProfile(app.appBindingId, online.revision).confirmations.length, 1);
    const stale = registry.markStale(app.appBindingId, online.revision, 'identity-unavailable');
    const available = registry.setAvailability(app.appBindingId, stale.revision, true);
    assert.equal(available.validity, 'stale'); assert.equal(available.lastError, 'identity-unavailable');
    assert.throws(() => registry.requireLaunchProfile(app.appBindingId, available.revision), /not-reusable/);
    const staleOffline = registry.setAvailability(app.appBindingId, available.revision, false, 'environment-offline');
    assert.equal(staleOffline.validity, 'stale'); assert.equal(staleOffline.lastError, 'environment-offline');
    assert.equal(registry.history(app.appBindingId).some(snapshot => snapshot.lastError === 'identity-unavailable'), true);
    const revoked = registry.revoke(app.appBindingId, staleOffline.revision, 'operator-revoked');
    assert.throws(() => registry.setAvailability(app.appBindingId, revoked.revision, true), /revoked/);
    assert.throws(() => registry.discover(candidate(), revoked.revision), /revoked/);
    assert.throws(() => confirm(registry, revoked), /revoked/);
    assert.equal(registry.history(app.appBindingId).at(-1)!.validity, 'revoked');
  } finally { store.close(); }
});

test('mismatch receipts retain independent history and invalidate reuse until a new candidate is confirmed', () => {
  const store = new SqliteEnvironmentAppStore(':memory:', () => time);
  try {
    const registry = store.bind(physical), app = verified(registry);
    const mismatch = registry.recordVerification(app.appBindingId, app.revision, { ...receipt(app), result: 'mismatch',
      identity: { ...app.identity!, fingerprint: 'replacement' }, reason: 'ownership-mismatch' });
    assert.equal(mismatch.validity, 'stale'); assert.equal(mismatch.verifications.length, 2);
    assert.throws(() => confirm(registry, mismatch), /confirmation-mismatch/);
    const refreshed = registry.discover(candidate(), mismatch.revision);
    assert.equal(refreshed.trust, 'discovered');
    assert.equal(confirm(registry, refreshed).trust, 'confirmed');
  } finally { store.close(); }
});

test('reopen reuses private configuration; runtime identities are rejected and scope replacement never revives old trust', () => {
  const dir = mkdtempSync(join(tmpdir(), 'app-reopen-')), path = join(dir, 'apps.sqlite');
  let store = new SqliteEnvironmentAppStore(path, () => time);
  try {
    const registry = store.bind(vmA), app = verified(registry);
    store.close(); store = new SqliteEnvironmentAppStore(path, () => time);
    const reopened = store.bind(vmA);
    assert.equal(reopened.requireLaunchProfile(app.appBindingId, app.revision).trust, 'verified');
    for (const key of ['sessionId', 'instanceId', 'pid', 'hwnd', 'targetBinding', 'observation', 'authority']) {
      assert.throws(() => reopened.discover({ ...candidate(vmA), [key]: 'runtime' }, app.revision), /invalid-app-fields/);
    }
    const replaced = store.bind({ ...vmA, installationScopeId: 'new-vm-entity-same-environment-name' });
    assert.throws(() => reopened.list(), /installation-scope-changed/);
    assert.equal(replaced.get(app.appBindingId)!.validity, 'stale');
    assert.throws(() => replaced.requireLaunchProfile(app.appBindingId, app.revision + 1), /scope-changed/);
    const fresh = replaced.discover(candidate(replaced.scope));
    assert.notEqual(fresh.appBindingId, app.appBindingId); assert.equal(fresh.trust, 'discovered');
    const restored = store.bind(vmA);
    assert.throws(() => reopened.list(), /installation-scope-changed/);
    assert.throws(() => replaced.list(), /installation-scope-changed/);
    const historical = restored.get(app.appBindingId)!;
    assert.equal(historical.validity, 'stale');
    assert.throws(() => restored.requireLaunchProfile(app.appBindingId, historical.revision), /installation-scope-changed/);
    assert.throws(() => confirm(restored, historical), /installation-scope-changed/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('two SQLite writers enforce revision conflicts and snapshots are detached from caller mutations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'app-cas-')), path = join(dir, 'apps.sqlite');
  const first = new SqliteEnvironmentAppStore(path, () => time), second = new SqliteEnvironmentAppStore(path, () => time);
  try {
    const a = first.bind(physical), b = second.bind(physical), app = a.discover(candidate());
    const changed = confirm(b, app);
    assert.throws(() => a.revoke(app.appBindingId, app.revision, 'old-write'), /revision-conflict/);
    assert.equal(a.get(app.appBindingId)!.revision, changed.revision);
    (changed.aliases as string[]).push('mutated-in-memory');
    assert.equal(a.get(app.appBindingId)!.aliases.includes('mutated-in-memory'), false);
    const source = candidate(physical, 'other'); const inserted = a.discover(source);
    assert.equal(source.launchSpec.kind, 'exe');
    if (source.launchSpec.kind === 'exe') (source.launchSpec.args as string[]).push('not-persisted');
    const persisted = b.get(inserted.appBindingId)!.launchSpec;
    assert.equal(persisted.kind, 'exe');
    if (persisted.kind === 'exe') assert.deepEqual(persisted.args, ['--synthetic']);
  } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('A -> B -> A rediscovery creates a new binding without old confirmations or verifications', () => {
  const dir = mkdtempSync(join(tmpdir(), 'app-incarnation-')), path = join(dir, 'apps.sqlite');
  let store = new SqliteEnvironmentAppStore(path, () => time);
  try {
    const first = store.bind(vmA), old = verified(first);
    const replacement = store.bind({ ...vmA, installationScopeId: 'synthetic-replacement-domain' });
    const reincarnated = store.bind(vmA), historical = reincarnated.get(old.appBindingId)!;
    // This is the same current-list/CAS lookup used by the legacy importer.
    const previous = reincarnated.list().find(app => app.installationId === old.installationId);
    const fresh = reincarnated.discover(candidate(vmA), previous?.revision);
    assert.notEqual(fresh.appBindingId, old.appBindingId);
    assert.equal(fresh.trust, 'discovered');
    assert.deepEqual(fresh.confirmations, []); assert.deepEqual(fresh.verifications, []);
    assert.notEqual(fresh.profileDigest, old.profileDigest);
    assert.equal(reincarnated.get(old.appBindingId)!.validity, 'stale');
    assert.throws(() => first.list(), /installation-scope-changed/);
    assert.throws(() => replacement.list(), /installation-scope-changed/);
    assert.throws(() => reincarnated.requireLaunchProfile(old.appBindingId, historical.revision), /installation-scope-changed/);
    assert.throws(() => confirm(reincarnated, historical), /installation-scope-changed/);
    assert.throws(() => reincarnated.setAvailability(old.appBindingId, historical.revision, true), /installation-scope-changed/);
    assert.throws(() => reincarnated.recordVerification(old.appBindingId, historical.revision, receipt(old)), /installation-scope-changed/);
    const confirmed = confirm(reincarnated, fresh);
    assert.equal(confirmed.trust, 'confirmed');
    assert.throws(() => reincarnated.recordVerification(confirmed.appBindingId, confirmed.revision, receipt(old)), /verification-mismatch/);
    assert.equal(reincarnated.requireLaunchProfile(confirmed.appBindingId, confirmed.revision).appBindingId, fresh.appBindingId);
    const history = reincarnated.history(old.appBindingId);
    assert.equal(history.length, 4); assert.equal(history.at(-1)!.validity, 'stale');
    assert.equal(history.at(-1)!.confirmations.length, 1); assert.equal(history.at(-1)!.verifications.length, 1);
    store.close(); store = new SqliteEnvironmentAppStore(path, () => time);
    const reopened = store.bind(vmA);
    assert.deepEqual(reopened.requireLaunchProfile(confirmed.appBindingId, confirmed.revision), confirmed);
    assert.deepEqual(reopened.discover(candidate(vmA), confirmed.revision), confirmed);
    assert.deepEqual(reopened.history(old.appBindingId), history);
    assert.throws(() => reopened.requireLaunchProfile(old.appBindingId, historical.revision), /installation-scope-changed/);
    const db = new DatabaseSync(path);
    try {
      assert.equal((db.prepare('SELECT scope_revision FROM app_environments').get() as { scope_revision: number }).scope_revision, 3);
      assert.equal((db.prepare('SELECT scope_revision FROM environment_apps WHERE app_binding_id=?')
        .get(old.appBindingId) as { scope_revision: number }).scope_revision, 1);
      assert.equal((db.prepare('SELECT scope_revision FROM environment_apps WHERE app_binding_id=?')
        .get(fresh.appBindingId) as { scope_revision: number }).scope_revision, 3);
    } finally { db.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('A -> B -> A revoked historical binding does not block registration in the new incarnation', () => {
  const store = new SqliteEnvironmentAppStore(':memory:', () => time);
  try {
    const first = store.bind(vmA), old = first.discover(candidate(vmA));
    const revoked = first.revoke(old.appBindingId, old.revision, 'operator-revoked');
    assert.throws(() => first.discover(candidate(vmA), revoked.revision), /app-revoked/);
    store.bind({ ...vmA, installationScopeId: 'synthetic-replacement-domain' });
    const reincarnated = store.bind(vmA);
    const previous = reincarnated.list().find(app => app.installationId === old.installationId);
    const fresh = reincarnated.discover(candidate(vmA), previous?.revision);
    assert.notEqual(fresh.appBindingId, old.appBindingId);
    assert.equal(fresh.trust, 'discovered'); assert.deepEqual(fresh.confirmations, []);
    assert.equal(reincarnated.get(old.appBindingId)!.validity, 'revoked');
    assert.equal(reincarnated.history(old.appBindingId).at(-1)!.lastError, 'operator-revoked');
    assert.throws(() => confirm(reincarnated, revoked), /installation-scope-changed/);
    assert.equal(confirm(reincarnated, fresh).trust, 'confirmed');
  } finally { store.close(); }
});

test('old-schema migration preserves known generation 1 and quarantines ambiguous legacy incarnations', () => {
  for (const generation of [1, 3]) {
    const dir = mkdtempSync(join(tmpdir(), 'app-generation-migration-')), path = join(dir, 'apps.sqlite');
    const synthetic = new SqliteEnvironmentAppStore(':memory:', () => time);
    const source = verified(synthetic.bind(vmA)); synthetic.close();
    const digest = profileDigest(candidate(vmA));
    const old = { ...source, profileDigest: digest,
      confirmations: source.confirmations.map(item => ({ ...item, profileDigest: digest })),
      verifications: source.verifications.map(item => ({ ...item, profileDigest: digest })) };
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE app_environments (provider_id TEXT, environment_id TEXT, installation_scope_id TEXT,
      scope_revision INTEGER, PRIMARY KEY(provider_id, environment_id));
      CREATE TABLE environment_apps (provider_id TEXT, environment_id TEXT, installation_scope_id TEXT,
      installation_id TEXT, app_binding_id TEXT, data_json TEXT,
      PRIMARY KEY(provider_id, environment_id, app_binding_id),
      UNIQUE(provider_id, environment_id, installation_scope_id, installation_id));
      CREATE TABLE environment_app_history (provider_id TEXT, environment_id TEXT, app_binding_id TEXT,
      revision INTEGER, data_json TEXT, PRIMARY KEY(provider_id, environment_id, app_binding_id, revision));`);
    db.prepare('INSERT INTO app_environments VALUES (?, ?, ?, ?)')
      .run(vmA.providerId, vmA.environmentId, vmA.installationScopeId, generation);
    db.prepare('INSERT INTO environment_apps VALUES (?, ?, ?, ?, ?, ?)')
      .run(vmA.providerId, vmA.environmentId, vmA.installationScopeId, old.installationId, old.appBindingId, JSON.stringify(old));
    db.prepare('INSERT INTO environment_app_history VALUES (?, ?, ?, ?, ?)')
      .run(vmA.providerId, vmA.environmentId, old.appBindingId, old.revision, JSON.stringify(old));
    db.close();
    let store = new SqliteEnvironmentAppStore(path, () => time);
    try {
      const registry = store.bind(vmA);
      if (generation === 1) {
        assert.deepEqual(registry.requireLaunchProfile(old.appBindingId, old.revision), old);
        assert.deepEqual(registry.discover(candidate(vmA), old.revision), old);
      } else {
        assert.equal(registry.get(old.appBindingId)!.lastError, 'installation-generation-unproven');
        assert.throws(() => registry.requireLaunchProfile(old.appBindingId, old.revision + 1), /installation-scope-changed/);
        const fresh = registry.discover(candidate(vmA));
        assert.notEqual(fresh.appBindingId, old.appBindingId);
        assert.deepEqual(registry.history(old.appBindingId)[0], old);
      }
      store.close(); store = new SqliteEnvironmentAppStore(path, () => time); store.bind(vmA);
      const check = new DatabaseSync(path);
      try {
        assert.equal((check.prepare('SELECT scope_revision FROM app_environments').get() as { scope_revision: number }).scope_revision, generation);
        assert.equal((check.prepare('SELECT scope_revision FROM environment_apps WHERE app_binding_id=?')
          .get(old.appBindingId) as { scope_revision: number }).scope_revision, generation === 1 ? 1 : 0);
      } finally { check.close(); }
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test('structured exe/shortcut/package specs preserve arguments; shell strings, runtime fields and relative paths reject', () => {
  const store = new SqliteEnvironmentAppStore(':memory:', () => time);
  try {
    const registry = store.bind(physical);
    const specs: AppLaunchSpec[] = [
      { kind: 'exe', executable: resolve('synthetic.exe'), args: ['a b', '--literal=$()'], workingDirectory: resolve('synthetic-dir') },
      { kind: 'shortcut', shortcutPath: resolve('synthetic.lnk'), executable: resolve('synthetic.exe'), args: ['one'] },
      { kind: 'package', packageFamilyName: 'synthetic-family', applicationUserModelId: 'synthetic-family!app' },
    ];
    specs.forEach((spec, index) => assert.deepEqual(registry.discover(candidate(physical, `spec-${index}`, spec)).launchSpec, spec));
    for (const spec of [
      { kind: 'shell', command: 'start app' }, { kind: 'exe', executable: 'relative.exe', args: [] },
      { ...specs[0], command: 'untrusted' }, { ...specs[0], args: 'shell string' },
      { ...specs[0], workingDirectory: 'relative' }, { ...specs[2], args: [] },
    ]) assert.throws(() => registry.discover(candidate(physical, 'bad', spec as AppLaunchSpec)));
  } finally { store.close(); }
});

test('model projection excludes private paths/args/receipts and exposes only confirmed aliases', () => {
  const store = new SqliteEnvironmentAppStore(':memory:', () => time);
  try {
    const registry = store.bind(physical), app = registry.discover(candidate());
    assert.deepEqual(modelAppView(app).aliases, []);
    const json = JSON.stringify(modelAppView(confirm(registry, app)));
    for (const value of ['executable', 'launchSpec', '--synthetic', 'fingerprint', 'installationScopeId', 'operatorId',
      'sessionId', 'instanceId', 'authority', 'evidence', 'source']) assert.equal(json.includes(value), false);
    assert.equal(json.includes('音乐'), true);
  } finally { store.close(); }
});

test('legacy import is explicit, one-way and discovered only; window hints do not verify identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'app-import-'));
  mkdirSync(join(dir, 'config'));
  const data = JSON.stringify([{ id: 'music', name: 'QQ音乐', executable: resolve('synthetic.exe'), args: [], windowTitle: 'QQ音乐' }]);
  writeFileSync(join(dir, 'apps.local.json'), data); writeFileSync(join(dir, 'config/agent-desktop-apps.json'), data);
  const store = new SqliteEnvironmentAppStore(':memory:', () => time);
  try {
    const host = store.bind(physical), guest = store.bind(vmA);
    await assert.rejects(importLegacyApps('nonexistent-synthetic-root', 'apps.local.json', undefined as never), /invalid-app-fields/);
    const [a] = await importLegacyApps(dir, 'apps.local.json', host);
    const [b] = await importLegacyApps(dir, 'config/agent-desktop-apps.json', guest);
    assert.notEqual(a.appBindingId, b.appBindingId);
    for (const app of [a, b]) {
      assert.equal(app.trust, 'discovered'); assert.equal(app.identity, undefined);
      assert.equal(app.confirmations.length, 0); assert.equal(app.verifications.length, 0);
    }
    assert.equal((await importLegacyApps(dir, 'apps.local.json', host))[0].revision, a.revision);
    const confirmed = confirm(host, a);
    assert.throws(() => host.recordVerification(a.appBindingId, confirmed.revision, receipt(confirmed)), /identity-not-verified/);
    assert.equal(readFileSync(join(dir, 'apps.local.json'), 'utf8'), data);
    writeFileSync(join(dir, 'apps.local.json'), data.replace('synthetic.exe', 'synthetic-changed.exe'));
    const [changed] = await importLegacyApps(dir, 'apps.local.json', host);
    assert.equal(changed.appBindingId, a.appBindingId); assert.equal(changed.validity, 'stale');
    await assert.rejects(importLegacyApps(dir, '../other.json' as never, host), /unknown-legacy/);
    writeFileSync(join(dir, 'apps.local.json'), '[{"id":"invalid"}]');
    await assert.rejects(importLegacyApps(dir, 'apps.local.json', host));
    assert.equal(host.list().length, 1);
    const empty = store.bind(local);
    writeFileSync(join(dir, 'apps.local.json'), JSON.stringify([
      { id: 'good', name: 'Valid', executable: resolve('synthetic.exe'), args: [] },
      { id: 'bad', name: 'Invalid', executable: resolve('synthetic.exe'), args: ['line\nbreak'] },
    ]));
    await assert.rejects(importLegacyApps(dir, 'apps.local.json', empty), /invalid-app-args/);
    assert.equal(empty.list().length, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('composition rejects mismatched scopes/duplicates and has no unconfigured fallback', () => {
  const store = new SqliteEnvironmentAppStore(':memory:');
  try {
    const discovery = { scope: vmA, async scan() { assert.fail('must-not-scan'); }, async inspect() { assert.fail('must-not-inspect'); } };
    assert.throws(() => composeEnvironmentApps(store, [{ scope: physical, discovery }]), /port-environment-mismatch/);
    assert.throws(() => composeEnvironmentApps(store, [{ scope: physical }, { scope: physical }]), /duplicate-app-environment/);
    assert.throws(() => composeEnvironmentApps(store).forEnvironment(physical), /service-unavailable/);
    assert.throws(() => composeEnvironmentApps(store, [{ scope: physical }]).forEnvironment(vmA), /service-unavailable/);
    assert.notEqual(profileDigest(candidate()), profileDigest(candidate(local)));
  } finally { store.close(); }
});

test('Root mounts independent registry ports, persists configuration and closes storage on dispose/init failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'app-root-'));
  const model = { createModel() { assert.fail('no-model'); } };
  let assembly = await createRootAssembly({ rootDir: dir, model, environmentApps: [{ scope: physical }] });
  try {
    const registry = assembly.environmentApps.forEnvironment(physical).registry;
    const app = confirm(registry, registry.discover(candidate()));
    assert.equal(assembly.inspect().plugins.some(plugin => plugin.services.includes('environmentApps')), true);
    await assembly.dispose(); assert.throws(() => registry.list(), /not open/);
    assembly = await createRootAssembly({ rootDir: dir, model, environmentApps: [{ scope: physical }] });
    assert.equal(assembly.environmentApps.forEnvironment(physical).registry.get(app.appBindingId)!.trust, 'confirmed');
    await assembly.dispose();
    await assert.rejects(createRootAssembly({ rootDir: dir, model, environmentApps: [{ scope: physical }],
      extraPlugins: [{ name: 'fake-failure', apply() { throw new Error('synthetic-init-failure'); } }] }), /synthetic-init-failure/);
    assembly = await createRootAssembly({ rootDir: dir, model });
    assert.throws(() => assembly.environmentApps.forEnvironment(physical), /service-unavailable/);
  } finally { await assembly.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
