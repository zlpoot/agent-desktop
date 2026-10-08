import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join as joinPath } from 'node:path';
import { test } from 'node:test';
import { managementFixture } from './fixtures/app-management.js';
import { taskAppFixture } from './fixtures/task-app-onboarding.js';
import { createDashboardServer } from '../src/app/server.js';
import { AppManagement } from '../src/app/app-management.js';
import type { EnvironmentAppBinding } from '../src/contracts/environment-apps.js';
import type { AppConfirmationDisplay } from '../src/contracts/app-launch.js';
import type { DiscoveredApp } from '../src/contracts/app-discovery.js';
type Fixture = Awaited<ReturnType<typeof managementFixture>>;
type View = { sessionId: string; revision: number; desktopTarget: { providerId: string; environmentId: string };
  registered: EnvironmentAppBinding[]; candidates: DiscoveredApp[]; confirmation?: AppConfirmationDisplay;
  report?: { status: string; installationOrigin: string }; readiness: { controlledLaunch: boolean; businessCapable: boolean; blockedReason?: string } };
const target = (f: Fixture, index = 0) => ({ providerId: f.scopes[index].providerId, environmentId: f.scopes[index].environmentId });
async function open(f: Fixture, index = 0): Promise<View> {
  const response = await f.post({ action: 'open', desktopTarget: target(f, index) });
  assert.equal(response.status, 200); return response.json();
}
const request = (view: View, action: string, extra = {}) => ({ action, desktopTarget: view.desktopTarget,
  sessionId: view.sessionId, revision: view.revision, requestId: randomUUID(), ...extra });
async function act(f: Fixture, view: View, action: string, extra = {}): Promise<View> {
  const response = await f.post(request(view, action, extra)); assert.equal(response.status, 200, await response.clone().text()); return response.json();
}
async function prepare(f: Fixture, view: View) {
  const scanned = await act(f, view, 'scan');
  return act(f, scanned, 'prepare', { candidateId: scanned.candidates[0].candidateId, candidateRevision: scanned.candidates[0].revision });
}

test('production composition defaults off; no selected environment, private origins and typed HTTP negative cases make zero effects', async () => {
  const f = await managementFixture(false);
  try {
    assert.equal((await f.post({ action: 'open', desktopTarget: target(f) })).status, 409);
    assert.equal((await f.post({ action: 'scan' })).status, 409);
    assert.equal((await f.post({ action: 'open', desktopTarget: target(f) }, null)).status, 403);
    assert.equal((await f.post({ action: 'open', desktopTarget: target(f) }, 'http://evil.example')).status, 403);
    assert.equal((await fetch(`${f.base}/api/desktop/apps`)).status, 405);
    assert.equal((await f.post({ action: 'open', desktopTarget: target(f), path: 'C:\\Synthetic\\Music.exe' })).status, 409);
    assert.equal((await f.post({ action: 'open', desktopTarget: target(f), padding: 'x'.repeat(5000) })).status, 409);
    assert.deepEqual(f.counts(), { models: 0, runtime: 0, leases: 0 });
    assert.ok(f.backends.every(backend => backend.starts === 0 && backend.scans === 0));
  } finally { await f.close(); }
});

test('production HTTP single candidate needs selection and trusted digest/launch permission; duplicate confirmation starts once and leaks no runtime receipt', async () => {
  const f = await managementFixture();
  try {
    let view = await open(f); assert.equal(f.backends[0].scans, 0);
    view = await prepare(f, view); const display = view.confirmation!;
    assert.equal(f.backends[0].starts, 0); assert.equal(view.registered[0].trust, 'discovered');
    const confirm = request(view, 'confirm', { confirmationId: display.confirmationId, digest: display.digest, allowLaunch: true });
    for (const patch of [{ allowLaunch: false }, { digest: 'forged' }, { operatorId: 'evil' }, { launchSpec: { executable: 'evil' } },
      { desktopTarget: target(f, 1) }, { revision: -1 }]) assert.equal((await f.post({ ...confirm, requestId: randomUUID(), ...patch })).status, 409);
    const [one, two] = await Promise.all([f.post(confirm), f.post(confirm)]);
    assert.equal(one.status, 200); assert.equal(two.status, 200);
    view = await one.json(); assert.deepEqual(await two.json(), view);
    assert.equal(f.backends[0].starts, 1); assert.equal(view.registered[0].confirmations.length, 1);
    assert.equal(view.readiness.businessCapable, false);
    assert.doesNotMatch(JSON.stringify(view), /private-synthetic-target|targetToken|synthetic-reservation/);
    const old = view.registered[0];
    view = await act(f, view, 'verify', { appBindingId: old.appBindingId, expectedRevision: old.revision, allowLaunch: true });
    assert.equal(f.backends[0].starts, 1); assert.equal(f.backends[0].scans, 1); assert.equal(view.registered[0].confirmations.length, 1);
    assert.equal((await f.post(request(view, 'prepare', { candidateId: view.candidates[0].candidateId, candidateRevision: view.candidates[0].revision }))).status, 409);
    assert.equal(f.backends[0].starts, 1);
    view = await act(f, view, 'revoke', { appBindingId: old.appBindingId, expectedRevision: view.registered[0].revision });
    assert.equal(view.registered[0].validity, 'revoked'); assert.equal(f.backends[0].running, true); assert.equal(f.backends[0].cleanups, 0);
    assert.equal((await f.post(confirm)).status, 200); // Receipt returns current revoked view, never obsolete success or another launch.
    assert.equal((await (await f.post(confirm)).json()).registered[0].validity, 'revoked');
    assert.equal(f.backends[0].starts, 1);
    assert.equal((await f.post(request(view, 'verify', { appBindingId: old.appBindingId, expectedRevision: view.registered[0].revision, allowLaunch: true }))).status, 409);
    assert.deepEqual(f.counts(), { models: 0, runtime: 0, leases: 0 });
  } finally { await f.close(); }
});

test('two same-name VMs, shared host installation domain, stale candidates, profile revisions and scope incarnation stay isolated', async () => {
  const f = await managementFixture();
  try {
    let a = await prepare(f, await open(f)), b = await act(f, await open(f, 1), 'scan');
    assert.equal((await f.post(request(b, 'prepare', { candidateId: a.candidates[0].candidateId, candidateRevision: a.candidates[0].revision }))).status, 409);
    b = await act(f, b, 'prepare', { candidateId: b.candidates[0].candidateId, candidateRevision: b.candidates[0].revision });
    assert.notEqual(a.confirmation!.appBindingId, b.confirmation!.appBindingId);
    const stale = request(a, 'confirm', { confirmationId: a.confirmation!.confirmationId, digest: a.confirmation!.digest, allowLaunch: true });
    a = await act(f, a, 'scan'); assert.equal((await f.post(stale)).status, 409);
    assert.equal(f.backends[0].starts, 0); assert.equal(f.backends[1].starts, 0);
    const host = await act(f, await open(f, 2), 'scan'), local = await act(f, await open(f, 3), 'scan');
    assert.equal(local.report!.installationOrigin, 'shared-host-os');
    assert.equal(local.readiness.controlledLaunch, false); assert.equal(host.readiness.controlledLaunch, false);
    assert.match(host.readiness.blockedReason!, /physical-generic.*dispatch-fence/);
    assert.match(local.readiness.blockedReason!, /managed-backend-owned-hidden/);
    const registry = f.assembly.environmentApps.forEnvironment(target(f, 2)).registry;
    const registered = registry.discover(host.candidates[0].candidate);
    const revoked = await act(f, host, 'revoke', { appBindingId: registered.appBindingId, expectedRevision: registered.revision });
    assert.equal(revoked.registered[0].validity, 'revoked'); assert.equal(f.backends[2].starts, 0);
    assert.equal((await f.post(request(local, 'prepare', { candidateId: host.candidates[0].candidateId, candidateRevision: host.candidates[0].revision }))).status, 409);
    const oldRegistry = f.assembly.environmentApps.forEnvironment(target(f)).registry;
    // Existing P7-A store incarnation invalidation exercised through the HTTP service handle.
    const { SqliteEnvironmentAppStore } = await import('../src/environment-apps/sqlite-registry.js');
    const store = new SqliteEnvironmentAppStore(joinPath(f.dir, 'environment-apps.sqlite'));
    try { store.bind({ ...f.scopes[0], installationScopeId: 'replacement-synthetic-domain' });
      assert.throws(() => oldRegistry.list()); assert.equal((await f.post(request(a, 'list'))).status, 409);
    } finally { store.close(); }
  } finally { await f.close(); }
});

test('synthetic shared OS catalog never transfers Physical confirmation or verification to Local Workspace', async () => {
  const f = await managementFixture(true, true); // Explicit Fake backend; no native availability claim.
  try {
    let host = await prepare(f, await open(f, 2)), local = await act(f, await open(f, 3), 'scan');
    host = await act(f, host, 'confirm', { confirmationId: host.confirmation!.confirmationId, digest: host.confirmation!.digest, allowLaunch: true });
    assert.equal(host.registered[0].trust, 'verified'); assert.equal(local.registered.length, 0); assert.equal(f.backends[3].starts, 0);
    local = await act(f, local, 'prepare', { candidateId: local.candidates[0].candidateId, candidateRevision: local.candidates[0].revision });
    assert.equal(local.registered[0].trust, 'discovered'); assert.equal(local.registered[0].confirmations.length, 0);
    assert.equal(local.registered[0].installationId, host.registered[0].installationId);
    assert.notEqual(local.registered[0].appBindingId, host.registered[0].appBindingId);
    local = await act(f, local, 'confirm', { confirmationId: local.confirmation!.confirmationId, digest: local.confirmation!.digest, allowLaunch: true });
    assert.equal(local.registered[0].trust, 'verified'); assert.equal(local.registered[0].confirmations.length, 1);
    assert.equal(local.registered[0].verifications[0].scope.providerId, 'local-workspace');
    assert.equal(local.readiness.businessCapable, false); assert.equal(f.backends[2].starts, 1); assert.equal(f.backends[3].starts, 1);
  } finally { await f.close(); }
});

test('editing launch arguments produces a new discovered profile with zero inherited confirmation/verification; deleted installation fails closed', async () => {
  const f = await managementFixture();
  try {
    let view = await prepare(f, await open(f));
    view = await act(f, view, 'confirm', { confirmationId: view.confirmation!.confirmationId, digest: view.confirmation!.digest, allowLaunch: true });
    const app = view.registered[0], backend = f.backends[0];
    backend.entries = backend.entries.map(item => ({ ...item, launchSpec: { kind: 'exe', executable: 'C:\\Synthetic\\Music.exe', args: ['--new-profile'] } }));
    view = await prepare(f, view); const changed = view.registered.find(item => item.appBindingId === view.confirmation!.appBindingId)!;
    assert.notEqual(changed.appBindingId, app.appBindingId); assert.equal(changed.trust, 'discovered');
    assert.equal(changed.confirmations.length, 0); assert.equal(changed.verifications.length, 0); assert.equal(backend.starts, 1);
    backend.entries = [];
    view = await act(f, view, 'verify', { appBindingId: app.appBindingId, expectedRevision: app.revision, allowLaunch: true });
    assert.equal(view.registered.find(item => item.appBindingId === app.appBindingId)!.validity, 'stale');
    assert.equal(backend.starts, 1); assert.equal(view.readiness.businessCapable, false);
    view = await act(f, view, 'scan'); assert.equal(view.candidates.length, 0);
  } finally { await f.close(); }
});

test('manual path/multiple candidates, rejected and incomplete/offline scans provide honest recovery without an automatic launch', async () => {
  const f = await managementFixture();
  try {
    let view = await open(f); const backend = f.backends[0], original = backend.entries;
    backend.entries = original.flatMap(item => [item, { ...item, version: '2', launchSpec: { kind: 'exe', executable: 'D:\\Synthetic\\Music.exe', args: [] } }]);
    view = await act(f, view, 'scan'); assert.equal(view.candidates.length, 2); assert.equal(view.confirmation, undefined);
    view = await act(f, view, 'path', { path: 'D:\\Synthetic\\Music.exe' }); assert.equal(view.candidates.length, 1);
    view = await act(f, view, 'path', { path: 'C:\\Synthetic\\Absent.exe' }); assert.equal(view.report!.status, 'unavailable');
    backend.entries = []; view = await act(f, view, 'scan'); assert.equal(view.report!.status, 'complete');
    backend.incomplete = true; view = await act(f, view, 'scan'); assert.equal(view.report!.status, 'incomplete');
    backend.offline = true; view = await act(f, view, 'scan'); assert.equal(view.report!.status, 'unavailable');
    backend.offline = backend.incomplete = false; backend.entries = original;
    view = await prepare(f, view); await act(f, view, 'cancel');
    assert.equal((await f.post(request(view, 'confirm', { confirmationId: view.confirmation!.confirmationId, digest: view.confirmation!.digest, allowLaunch: true }))).status, 409);
    assert.equal(backend.starts, 0);
  } finally { await f.close(); }
});

test('offline preserves confirmation, identity/launch-argument drift requires fresh confirmation, unknown launch refuses blind retry', async () => {
  const f = await managementFixture();
  try {
    let view = await prepare(f, await open(f));
    view = await act(f, view, 'confirm', { confirmationId: view.confirmation!.confirmationId, digest: view.confirmation!.digest, allowLaunch: true });
    const backend = f.backends[0], app = view.registered[0]; backend.offline = true;
    view = await act(f, view, 'verify', { appBindingId: app.appBindingId, expectedRevision: app.revision, allowLaunch: true });
    assert.equal(view.registered[0].availability, 'unavailable'); assert.equal(view.registered[0].confirmations.length, 1);
    backend.offline = false;
    view = await act(f, view, 'verify', { appBindingId: app.appBindingId, expectedRevision: view.registered[0].revision, allowLaunch: true });
    assert.equal(view.registered[0].trust, 'verified'); assert.equal(backend.starts, 1);
    backend.installed = { ...backend.installed, version: '2', fingerprint: 'replacement-contents' };
    view = await act(f, view, 'verify', { appBindingId: app.appBindingId, expectedRevision: view.registered[0].revision, allowLaunch: true });
    assert.equal(view.registered[0].validity, 'stale'); assert.equal(view.readiness.businessCapable, false);
    backend.entries = backend.entries.map(item => ({ ...item, version: '2', contentFingerprint: 'replacement-contents' }));
    view = await prepare(f, view); assert.equal(view.registered[0].trust, 'discovered');
    assert.ok(view.registered[0].profileRevision > app.profileRevision);
    view = await act(f, view, 'confirm', { confirmationId: view.confirmation!.confirmationId, digest: view.confirmation!.digest, allowLaunch: true });
    assert.equal(view.readiness.businessCapable, false);
    backend.running = false; backend.unknown = true;
    view = await act(f, view, 'verify', { appBindingId: app.appBindingId, expectedRevision: view.registered[0].revision, allowLaunch: true });
    assert.match(view.registered[0].verifications.at(-1)!.reason!, /launch-result-unknown/);
    const starts = backend.starts;
    view = await act(f, view, 'verify', { appBindingId: app.appBindingId, expectedRevision: view.registered[0].revision, allowLaunch: true });
    assert.equal(backend.starts, starts); assert.equal(view.registered[0].availability, 'unavailable');
  } finally { await f.close(); }
});

test('page close cancels inflight launch and late discovery; Host restart preserves profiles but rejects stale sessions and confirmation', async () => {
  const f = await managementFixture();
  try {
    let view = await prepare(f, await open(f)), release!: () => void, entered!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    f.backends[0].beforeObserve = async () => { entered(); await new Promise<void>(done => { release = done; }); };
    const pending = f.post(request(view, 'confirm', { confirmationId: view.confirmation!.confirmationId, digest: view.confirmation!.digest, allowLaunch: true }));
    await started; await act(f, view, 'close'); release(); assert.equal((await pending).status, 409);
    assert.equal(f.backends[0].cleanups, 1);
    f.backends[0].beforeObserve = undefined;
    f.backends[0].entries = f.backends[0].entries.map(item => ({ ...item, launchSpec: { kind: 'exe', executable: 'D:\\Synthetic\\Music.exe', args: [] } }));
    view = await prepare(f, await open(f));
    const stale = request(view, 'confirm', { confirmationId: view.confirmation!.confirmationId, digest: view.confirmation!.digest, allowLaunch: true });
    const starts = f.backends[0].starts;
    await f.restart(); assert.equal((await f.post(stale)).status, 409); assert.equal(f.backends[0].starts, starts);
    const fresh = await open(f); assert.ok(fresh.registered.length > 0); assert.equal(fresh.confirmation, undefined);
    let scanEntered!: () => void, scanRelease!: () => void;
    const waiting = new Promise<void>(done => { scanEntered = done; });
    f.backends[0].beforeScan = async () => { scanEntered(); await new Promise<void>(done => { scanRelease = done; }); };
    const scan = f.post(request(fresh, 'scan')); await waiting; await act(f, fresh, 'close'); scanRelease();
    assert.equal((await scan).status, 409); assert.equal(f.backends[1].starts, 0);
  } finally { await f.close(); }
});

test('management and P7-D card share registry; second Task reuses QQ音乐 with no confirmation, revocation keeps old Task audit', async () => {
  const f = await taskAppFixture();
  try {
    const manager = new AppManagement(f.apps, () => f.controller.desktopOptions());
    let view = await manager.act({ action: 'open', desktopTarget: f.target }) as View;
    view = await manager.act(request(view, 'scan')) as View;
    view = await manager.act(request(view, 'prepare', { candidateId: view.candidates[0].candidateId, candidateRevision: view.candidates[0].revision })) as View;
    view = await manager.act(request(view, 'confirm', { confirmationId: view.confirmation!.confirmationId, digest: view.confirmation!.digest, allowLaunch: true })) as View;
    const id = f.controller.submit('使用 QQ音乐 搜索合成歌曲', { desktopTarget: f.target });
    await f.wait(id, state => state.appOnboarding?.state === 'ready' && !!state.observation);
    assert.equal(f.counters.scans, 1); assert.equal(f.counters.starts, 1);
    assert.equal(f.apps.forEnvironment(f.target).registry.list()[0].confirmations.length, 1);
    const app = f.apps.forEnvironment(f.target).registry.list()[0];
    view = await manager.act(request(view, 'list')) as View;
    await manager.act(request(view, 'revoke', { appBindingId: app.appBindingId, expectedRevision: app.revision }));
    assert.ok(f.trace.events(id).some(event => event.node === 'app_profile_reused'));
    const second = f.submit(); await f.wait(second, state => state.appOnboarding?.state === 'candidates');
    assert.equal(f.counters.starts, 1); assert.equal(f.counters.businessEffects, 0);
    await manager.close();
  } finally { await f.close(); }
});

test('HTTP revoke fences an admitted Task at effect time; earlier effects and audit survive without cleanup or replay', { timeout: 20000 }, async () => {
  for (const committedBeforeRevoke of [0, 1]) {
    const f = await taskAppFixture({ management: true, actions: [
      { kind: 'keypress', keys: 'CTRL+F' }, { kind: 'keypress', keys: 'ESC' },
    ] });
    const server = createDashboardServer(f.dir, f.controller);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); if (!address || typeof address === 'string') throw Error('missing address');
    const base = `http://127.0.0.1:${address.port}`;
    const post = (body: unknown) => fetch(`${base}/api/desktop/apps`, { method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let release!: () => void, entered!: () => void, dispatches = 0;
    const blocked = new Promise<void>(done => { release = done; });
    const admitted = new Promise<void>(done => { entered = done; });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      f.beforeDispatch(async () => { if (++dispatches === committedBeforeRevoke + 1) { entered(); await blocked; } });
      const id = f.submit(); await f.wait(id, state => state.appOnboarding?.state === 'candidates');
      const app = f.trace.load(id)!.appOnboarding!, candidate = app.candidates[0];
      const confirmation = { desktopTarget: f.target, interactionId: app.interactionId, action: 'confirm' as const,
        candidateId: candidate.candidateId, candidateRevision: candidate.candidateRevision };
      await f.controller.onboardApp(id, confirmation);
      await Promise.race([admitted, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(Error('Task never reached blocked dispatch')), 5000);
      })]);
      clearTimeout(timeout);
      assert.equal(f.counters.businessEffects, committedBeforeRevoke);
      assert.equal(f.counters.runtime, 1); assert.equal(f.counters.leases, 1);
      assert.equal(f.counters.genericRuntime, 0); assert.equal(f.counters.starts, 1);
      assert.ok(f.trace.load(id)!.inFlightAction, 'Task must be admitted and blocked at dispatch, not setup');
      const history = f.trace.events(id), before = f.trace.load(id)!;
      const response = await post({ action: 'open', desktopTarget: f.target }); assert.equal(response.status, 200);
      let view = await response.json() as View;
      const profile = view.registered[0]; assert.equal(profile.validity, 'current'); assert.equal(profile.trust, 'verified');
      const revoke = request(view, 'revoke', { appBindingId: profile.appBindingId, expectedRevision: profile.revision });
      const acknowledged = await post(revoke); assert.equal(acknowledged.status, 200, await acknowledged.clone().text());
      view = await acknowledged.json() as View;
      assert.equal(view.registered[0].validity, 'revoked');
      assert.deepEqual(f.trace.load(id), before, 'revoke preserves the Task record');
      assert.deepEqual(f.trace.events(id), history);
      assert.equal(f.counters.businessEffects, committedBeforeRevoke, 'no committed effect while dispatch is blocked');
      release();
      const terminal = await f.wait(id, state => ['paused', 'failed'].includes(state.status));
      assert.equal(f.counters.businessEffects, committedBeforeRevoke, 'zero new effects after acknowledged revoke');
      assert.ok(f.trace.events(id).some(event => /app-onboarding-profile-no-longer-current/.test(event.state.error ?? '')));
      assert.deepEqual(f.trace.events(id).slice(0, history.length), history, 'prior audit remains unchanged');
      assert.ok(f.trace.events(id).some(event => event.node === 'queued'));
      assert.equal(f.trace.events(id).filter(event => event.node === 'queued').length, 1);
      assert.equal(f.counters.cleanups, 0); assert.equal(f.running(), true, 'user-owned running process is preserved');
      assert.equal(f.counters.starts, 1); assert.equal(f.counters.runtime, 1); assert.ok(f.counters.releases >= 1);
      if (terminal.status === 'paused') {
        f.controller.continue(id);
        await f.wait(id, state => /app-onboarding-new-task-required/.test(state.error ?? ''));
        assert.equal(f.counters.businessEffects, committedBeforeRevoke);
        assert.equal(f.counters.runtime, 1); assert.equal(f.counters.starts, 1);
      }
      // Replays and revalidation cannot restore the revoked binding or launch a new process.
      const repeated = await post(revoke); assert.equal(repeated.status, 200);
      assert.equal((await repeated.json()).registered[0].validity, 'revoked');
      assert.equal((await post(request(view, 'verify', { appBindingId: profile.appBindingId,
        expectedRevision: view.registered[0].revision, allowLaunch: true }))).status, 409);
      assert.throws(() => f.apps.forEnvironment(f.target).registry.confirm({ appBindingId: profile.appBindingId,
        expectedRevision: view.registered[0].revision, profileDigest: profile.profileDigest, operatorId: 'synthetic' }), /app-revoked/);
      const second = f.submit(); await f.wait(second, state => state.appOnboarding?.state === 'candidates');
      assert.equal(f.counters.starts, 1); assert.equal(f.counters.runtime, 1);
      assert.equal(f.counters.businessEffects, committedBeforeRevoke); assert.equal(f.counters.cleanups, 0);
      assert.equal(f.apps.forEnvironment(f.target).registry.get(profile.appBindingId)!.validity, 'revoked');
      assert.deepEqual(f.apps.forEnvironment(f.target).registry.get(profile.appBindingId)!.verifications, profile.verifications);
    } finally {
      clearTimeout(timeout); release();
      await new Promise<void>(done => server.close(() => done())); await f.close();
    }
  }
});
