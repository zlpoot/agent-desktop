import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvironmentAppScope, EnvironmentAppBinding, AppLaunchSpec } from '../src/contracts/environment-apps.js';
import type { AppInstanceEvidence, AppLaunchExecution, AppRuntimeContext, ManagedAppLaunchBackend } from '../src/contracts/app-launch.js';
import { ScopedAppDiscovery } from '../src/environment-apps/discovery.js';
import { SqliteEnvironmentAppStore } from '../src/environment-apps/sqlite-registry.js';
import { ControlledAppLauncher, AppLaunchError } from '../src/environment-apps/launcher.js';
import { AppOnboardingService } from '../src/environment-apps/onboarding.js';
import { composeEnvironmentApps } from '../src/composition/environment-apps.js';
import { GuestAppLaunchTransport, LocalWorkspaceAppLaunchBackend, RpcAppLaunchBackend } from '../src/environment-apps/launch-adapters.js';
import { createServer } from 'node:http';
import { modelAppView } from '../src/environment-apps/validation.js';

const host: EnvironmentAppScope = { providerId: 'physical', environmentId: 'current-interactive-desktop', installationScopeId: 'synthetic-host' };
const vmA = { providerId: 'hyper-v', environmentId: 'vm:a', installationScopeId: 'synthetic-a' };
const vmB = { ...vmA, environmentId: 'vm:b', installationScopeId: 'synthetic-b' };
const local = { ...host, providerId: 'local-workspace', environmentId: 'hidden' };
const spec: AppLaunchSpec = { kind: 'exe', executable: 'C:\\Synthetic\\Music.exe', args: ['--literal=a b'], workingDirectory: 'C:\\Synthetic' };
const identity = { productId: 'synthetic-music', version: '1.0', fingerprint: 'synthetic-fingerprint' };
class FakeLaunchBackend implements ManagedAppLaunchBackend {
  scans = 0; inspections = 0; opens = 0; starts = 0; cleanups: string[] = []; closes = 0;
  installed = { ...identity }; running = false; unknown = false; offline = false; cleanupFail = false;
  mutate?: (value: AppInstanceEvidence) => AppInstanceEvidence;
  beforeStart?: () => void; beforeObserve?: () => Promise<void>;
  constructor(readonly scope = host) {}
  async inspect(launchSpec: AppLaunchSpec) { this.inspections++;
    if (this.offline) throw new AppLaunchError('unavailable', 'synthetic-offline');
    return { scope: this.scope, launchSpec, identity: { ...this.installed } }; }
  async open(signal: AbortSignal): Promise<AppLaunchExecution> {
    if (this.offline) throw new AppLaunchError('unavailable', 'synthetic-offline');
    const sequence = ++this.opens;
    const context: AppRuntimeContext = { scope: this.scope, sessionId: `session-${sequence}`, instanceId: `instance-${sequence}`,
      windowsSessionId: 1, desktop: this.scope.providerId === 'local-workspace' ? 'WinSta0\\Hidden' : 'WinSta0\\Default' };
    const instance = (profile: EnvironmentAppBinding) => {
      if (!this.running || this.unknown) return [];
      const launch = profile.launchSpec;
      if (launch.kind === 'package') throw Error('unsupported');
      const value: AppInstanceEvidence = { ...context, targetToken: `opaque-target-${sequence}`, identity: { ...this.installed },
        executable: launch.executable, args: [...launch.args], workingDirectory: launch.workingDirectory,
        processOwnedByInstallation: true, windowOwnedByProcess: true, sameUser: true, permissionsCompatible: true };
      return [this.mutate ? this.mutate(value) : value];
    };
    return { context, assertCurrent: async () => { if (signal.aborted) throw new AppLaunchError('unavailable', 'synthetic-cancelled'); },
      inspect: value => this.inspect(value), instances: async profile => instance(profile),
      start: async () => { this.beforeStart?.(); if (signal.aborted) throw new AppLaunchError('unavailable', 'synthetic-cancelled');
        this.starts++; this.running = true; return `owned-${sequence}`; },
      observe: async profile => { await this.beforeObserve?.(); return instance(profile); },
      cleanupOwned: async token => { this.cleanups.push(token); if (this.cleanupFail) throw Error('no-ack'); this.running = false; },
      close: async () => { this.closes++; } };
  }
}
function fixture(scope = host, store = new SqliteEnvironmentAppStore(':memory:')) {
  const backend = new FakeLaunchBackend(scope), registry = store.bind(scope);
  const discovery = new ScopedAppDiscovery(scope, { scope,
    collect: async () => { backend.scans++; return { scope, entries: [{ displayName: 'AA音乐', aliases: ['音乐'], launchSpec: spec,
      source: 'synthetic-menu', version: '1.0', publisher: 'Synthetic Publisher', contentFingerprint: identity.fingerprint }],
      coverage: [{ source: 'synthetic-menu', status: 'complete', inspected: 1, rejected: 0 }] }; },
    inspectPath: async () => { throw Error('must-not-rescan'); } });
  const launcher = new ControlledAppLauncher(backend), service = new AppOnboardingService(registry, discovery, launcher);
  const prepare = async () => { const snapshot = (await discovery.scan()).snapshots[0];
    return service.prepare({ candidateId: snapshot.candidateId, candidateRevision: snapshot.revision }); };
  const first = async () => { const display = await prepare(); const result = await service.confirm({ confirmationId: display.confirmationId, digest: display.digest }, 'operator');
    return { display, result, app: registry.get(display.appBindingId)! }; };
  return { store, backend, registry, discovery, launcher, service, prepare, first };
}

test('first explicit confirmation verifies; repeat confirmation/submit starts once; reuse inspects without scanning or confirming', async () => {
  const f = fixture();
  try {
    const display = await f.prepare();
    assert.equal(f.backend.starts, 0); assert.equal(f.backend.opens, 0);
    assert.equal(f.registry.get(display.appBindingId)!.trust, 'discovered');
    assert.throws(() => f.service.reuse({ appBindingId: display.appBindingId, expectedRevision: 1, operationId: 'discovered' }, 'operator'), /not-reusable/);
    assert.equal(display.effect, 'confirm-and-verify-launch'); assert.equal(display.version, '1.0');
    assert.deepEqual(display.scope, host); assert.deepEqual(display.launchSpec, spec); assert.deepEqual(display.sources, ['synthetic-menu']);
    const request = { confirmationId: display.confirmationId, digest: display.digest };
    const [one, two] = await Promise.all([f.service.confirm(request, 'operator'), f.service.confirm(request, 'operator')]);
    assert.deepEqual(one, two); assert.equal(f.backend.starts, 1);
    const app = f.registry.get(display.appBindingId)!;
    assert.equal(app.trust, 'verified'); assert.equal(app.confirmations.length, 1);
    const repeat = { appBindingId: app.appBindingId, expectedRevision: app.revision, operationId: 'normal-use' };
    const [again, duplicate] = await Promise.all([f.service.reuse(repeat, 'operator'), f.service.reuse(repeat, 'operator')]);
    assert.deepEqual(again, duplicate); assert.notEqual(again.target!.targetToken, one.target!.targetToken);
    assert.notEqual(again.target!.sessionId, one.target!.sessionId);
    assert.equal(f.backend.starts, 1); assert.equal(f.backend.scans, 1);
    assert.equal(f.registry.get(app.appBindingId)!.confirmations.length, 1);
    assert.equal(JSON.stringify(f.registry.get(app.appBindingId)).includes('opaque-target'), false);
    assert.equal(JSON.stringify(modelAppView(app)).includes('C:\\\\Synthetic'), false);
  } finally { await f.service.close(); f.store.close(); }
});

test('unknown, changed, expired, cancelled, cross-environment and forged confirmation requests make no start', async () => {
  const f = fixture(), other = fixture(vmA);
  try {
    const display = await f.prepare();
    for (const value of [{ confirmationId: 'unknown', digest: display.digest }, { confirmationId: display.confirmationId, digest: 'substituted' },
      { confirmationId: display.confirmationId, digest: display.digest, confirmed: true },
      { confirmationId: display.confirmationId, digest: display.digest, executable: 'C:\\evil.exe' }]) {
      assert.throws(() => f.service.confirm(value, 'operator'), /mismatch|invalid-app-management/);
    }
    assert.throws(() => other.service.confirm({ confirmationId: display.confirmationId, digest: display.digest }, 'operator'), /mismatch/);
    await f.discovery.scan();
    assert.throws(() => f.service.confirm({ confirmationId: display.confirmationId, digest: display.digest }, 'operator'), /stale-or-unknown/);
    const cancel = await f.prepare(); f.service.cancel({ operationId: cancel.confirmationId });
    assert.throws(() => f.service.confirm({ confirmationId: cancel.confirmationId, digest: cancel.digest }, 'operator'), /expired-or-mismatch/);
    const revision = await f.prepare(), app = f.registry.get(revision.appBindingId)!;
    f.registry.markStale(app.appBindingId, app.revision, 'synthetic-change');
    assert.throws(() => f.service.confirm({ confirmationId: revision.confirmationId, digest: revision.digest }, 'operator'), /revision-conflict/);
    assert.equal(f.backend.starts, 0); assert.equal(other.backend.starts, 0);
  } finally { await f.service.close(); await other.service.close(); f.store.close(); other.store.close(); }
});

test('opaque permits cannot be fabricated/copied, used with another profile or consumed twice', async () => {
  const f = fixture();
  try {
    const { app } = await f.first();
    const permit = f.launcher.authorize(f.registry, app.appBindingId, app.revision, new AbortController().signal, () => {});
    await assert.rejects(f.launcher.verify(permit.profile, { ...permit.permission }), /permit-invalid/);
    await f.launcher.verify(permit.profile, permit.permission);
    await assert.rejects(f.launcher.verify(permit.profile, permit.permission), /permit-invalid/);
    const next = f.launcher.authorize(f.registry, app.appBindingId, app.revision, new AbortController().signal, () => {});
    await assert.rejects(f.launcher.verify({ ...app, launchSpec: { kind: 'exe', executable: 'C:\\Substitution.exe', args: [] } }, next.permission), /permit-invalid/);
    assert.equal(f.backend.starts, 1);
  } finally { await f.service.close(); f.store.close(); }
});

test('expired confirmation and installation-generation replacement cannot revive approval', async () => {
  const f = fixture(); let now = Date.now();
  const service = new AppOnboardingService(f.registry, f.discovery, f.launcher, () => now);
  try {
    const snapshot = (await f.discovery.scan()).snapshots[0];
    const display = await service.prepare({ candidateId: snapshot.candidateId, candidateRevision: snapshot.revision });
    now += 300001;
    assert.throws(() => service.confirm({ confirmationId: display.confirmationId, digest: display.digest }, 'operator'), /expired/);
    f.store.bind({ ...host, installationScopeId: 'replacement-host' });
    assert.throws(() => f.service.confirm({ confirmationId: display.confirmationId, digest: display.digest }, 'operator'), /scope-changed/);
    assert.equal(f.backend.starts, 0);
  } finally { await service.close(); await f.service.close(); f.store.close(); }
});

test('file replacement between discovery and confirmation requires a fresh candidate, with zero Registry writes/start', async () => {
  const f = fixture();
  try {
    const snapshot = (await f.discovery.scan()).snapshots[0]; f.backend.installed.fingerprint = 'replaced-binary';
    await assert.rejects(f.service.prepare({ candidateId: snapshot.candidateId, candidateRevision: snapshot.revision }), /candidate-installation-changed/);
    assert.equal(f.registry.list().length, 0); assert.equal(f.backend.opens, 0); assert.equal(f.backend.starts, 0);
  } finally { await f.service.close(); f.store.close(); }
});

test('Host, two Guests and same-installation Local Workspace keep independent confirmations and launches', async () => {
  const store = new SqliteEnvironmentAppStore(':memory:'), values = [host, vmA, vmB, local].map(scope => fixture(scope, store));
  try {
    const ids = [];
    for (const f of values) { const { app, result } = await f.first(); ids.push(app.appBindingId);
      assert.deepEqual(result.target!.scope, f.registry.scope); }
    assert.equal(new Set(ids).size, 4);
    for (const f of values) { assert.equal(f.registry.list().length, 1); assert.equal(f.backend.starts, 1); }
  } finally { for (const f of values) await f.service.close(); store.close(); }
});

for (const [label, mutate] of [
  ['same-title other Desktop', (v: AppInstanceEvidence) => ({ ...v, desktop: 'WinSta0\\Another' })],
  ['same PID new Session', (v: AppInstanceEvidence) => ({ ...v, windowsSessionId: 2 })],
  ['wrong executable', (v: AppInstanceEvidence) => ({ ...v, executable: 'C:\\Other\\Music.exe' })],
  ['unproven launcher ownership', (v: AppInstanceEvidence) => ({ ...v, processOwnedByInstallation: false })],
  ['window not owned by process', (v: AppInstanceEvidence) => ({ ...v, windowOwnedByProcess: false })],
  ['different user', (v: AppInstanceEvidence) => ({ ...v, sameUser: false })],
  ['elevated target', (v: AppInstanceEvidence) => ({ ...v, permissionsCompatible: false })],
] as const) test(`${label} does not verify, launch another process or clean the user instance`, async () => {
  const f = fixture(); f.backend.running = true; f.backend.mutate = mutate;
  try { const { app, result } = await f.first();
    assert.equal(result.verification.result, 'unavailable'); assert.equal(result.target, undefined);
    assert.equal(app.trust, 'confirmed'); assert.equal(f.backend.starts, 0); assert.deepEqual(f.backend.cleanups, []);
  } finally { await f.service.close(); f.store.close(); }
});

test('installation/version drift before dispatch goes stale; offline retains confirmation and recovers without rescan', async () => {
  const f = fixture();
  try {
    const { app } = await f.first(); f.backend.offline = true;
    const offline = await f.service.reuse({ appBindingId: app.appBindingId, expectedRevision: app.revision, operationId: 'offline' }, 'operator');
    assert.equal(offline.verification.result, 'unavailable');
    let current = f.registry.get(app.appBindingId)!;
    assert.equal(current.trust, 'verified'); assert.equal(current.confirmations.length, 1); assert.equal(current.validity, 'current');
    f.backend.offline = false;
    assert.equal((await f.service.reuse({ appBindingId: app.appBindingId, expectedRevision: current.revision, operationId: 'reconnect' }, 'operator')).verification.result, 'verified');
    current = f.registry.get(app.appBindingId)!; f.backend.installed.version = '2.0';
    const upgrade = await f.service.reuse({ appBindingId: app.appBindingId, expectedRevision: current.revision, operationId: 'upgrade' }, 'operator');
    assert.equal(upgrade.verification.result, 'mismatch'); assert.equal(f.registry.get(app.appBindingId)!.validity, 'stale');
    assert.equal(f.backend.starts, 1); assert.equal(f.backend.scans, 1);
  } finally { await f.service.close(); f.store.close(); }
});

test('unknown window outcome cleans only the owned token; explicit subsequent use observes without another start', async () => {
  const f = fixture(); f.backend.unknown = true;
  try {
    const { app, result } = await f.first();
    assert.equal(result.failureKind, 'unknown'); assert.match(app.lastError!, /launch-result-unknown/);
    assert.equal(f.backend.starts, 1); assert.deepEqual(f.backend.cleanups, ['owned-1']);
    const again = await f.service.reuse({ appBindingId: app.appBindingId, expectedRevision: app.revision, operationId: 'reconcile' }, 'operator');
    assert.equal(again.verification.result, 'unavailable'); assert.equal(f.backend.starts, 1);
    let current = f.registry.get(app.appBindingId)!; f.backend.offline = true;
    await f.service.reuse({ appBindingId: app.appBindingId, expectedRevision: current.revision, operationId: 'unknown-then-offline' }, 'operator');
    current = f.registry.get(app.appBindingId)!; f.backend.offline = false;
    await f.service.reuse({ appBindingId: app.appBindingId, expectedRevision: current.revision, operationId: 'unknown-after-reconnect' }, 'operator');
    assert.equal(f.backend.starts, 1, 'offline must not erase the unresolved launch boundary');
  } finally { await f.service.close(); f.store.close(); }
});

test('cancel/revoke during launch prevents verified result and cleans only this operation; cleanup failure blocks new admission', async () => {
  for (const mode of ['cancel', 'revoke', 'cleanup-failure']) {
    const f = fixture();
    try {
      const display = await f.prepare();
      f.backend.beforeObserve = async () => {
        if (mode === 'cancel') f.service.cancel({ operationId: display.confirmationId });
        if (mode === 'revoke') { const app = f.registry.get(display.appBindingId)!;
          f.service.revoke({ appBindingId: app.appBindingId, expectedRevision: app.revision }, 'operator-revoked'); }
      };
      if (mode === 'cleanup-failure') { f.backend.unknown = true; f.backend.cleanupFail = true; }
      const operation = f.service.confirm({ confirmationId: display.confirmationId, digest: display.digest }, 'operator');
      if (mode === 'revoke') await assert.rejects(operation, /revoked|not-reusable|revision-conflict|no-longer-current/);
      else { const result = await operation; assert.equal(result.target, undefined); assert.notEqual(result.verification.result, 'verified'); }
      assert.deepEqual(f.backend.cleanups, ['owned-1']); assert.equal(f.backend.closes, 1);
      const app = f.registry.get(display.appBindingId)!;
      assert.notEqual(app.trust, 'verified');
      if (mode === 'cleanup-failure') await assert.rejects(f.service.reuse({ appBindingId: app.appBindingId, expectedRevision: app.revision, operationId: 'blocked' }, 'operator'), /resource-blocked/);
    } finally { await f.service.close().catch(error => assert.match(String(error), /cleanup-unconfirmed/)); f.store.close(); }
  }
});

test('ordinary store restart keeps confirmed configuration; reuse creates a fresh runtime target', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p7c-reopen-')), path = join(dir, 'apps.sqlite');
  let store = new SqliteEnvironmentAppStore(path), f = fixture(host, store);
  try {
    const { app, result } = await f.first(); await f.service.close(); store.close();
    store = new SqliteEnvironmentAppStore(path); f = fixture(host, store);
    f.backend.running = true;
    const again = await f.service.reuse({ appBindingId: app.appBindingId, expectedRevision: app.revision, operationId: 'reopened' }, 'operator');
    assert.equal(again.verification.result, 'verified'); assert.equal(f.backend.scans, 0); assert.equal(f.backend.starts, 0);
    assert.equal(f.registry.get(app.appBindingId)!.confirmations.length, 1);
    assert.equal(result.target!.identity.version, again.target!.identity.version);
  } finally { await f.service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Local Workspace refuses an unmapped app/package before opening any backend and rejects Default Desktop evidence', async () => {
  const backend = new FakeLaunchBackend(local);
  const adapter = new LocalWorkspaceAppLaunchBackend(backend, []);
  await assert.rejects(adapter.inspect(spec, new AbortController().signal), /workspace-app-launch-unsupported/);
  assert.equal(backend.opens, 0); assert.equal(backend.inspections, 0);
  assert.throws(() => new LocalWorkspaceAppLaunchBackend(backend, [{ mechanism: 'qqmusic' as never, launchSpec: spec }]), /invalid-workspace/);
  const f = fixture(local); f.backend.running = true; f.backend.mutate = value => ({ ...value, desktop: 'WinSta0\\Default' });
  try { assert.equal((await f.first()).result.target, undefined); assert.equal(f.backend.starts, 0); }
  finally { await f.service.close(); f.store.close(); }
});

test('composition checks exact scopes; default is disabled; managed lifecycle closes before storage', async () => {
  const f = fixture();
  try {
    const services = composeEnvironmentApps(f.store, [{ scope: host, discovery: f.discovery, launchBackend: f.backend }]);
    assert.ok(services.forEnvironment(host).onboarding);
    assert.throws(() => services.forEnvironment(vmA), /unavailable/);
    assert.throws(() => composeEnvironmentApps(f.store).forEnvironment(host), /unavailable/);
    assert.throws(() => composeEnvironmentApps(f.store, [{ scope: host, discovery: f.discovery, launchBackend: new FakeLaunchBackend(vmA) }]), /port-environment-mismatch/);
    await services.close();
    await assert.rejects(services.forEnvironment(host).onboarding!.prepare({ candidateId: 'old', candidateRevision: 1 }), /onboarding-closed/);
    assert.doesNotThrow(() => f.registry.list());
  } finally { await f.service.close(); f.store.close(); }
});

test('Guest transport negotiates scope/version, never stats Host paths, and only sends staged IDs for start', async () => {
  let advertised = true, drift = false; const calls: any[] = [];
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== 'Bearer synthetic-token') { res.writeHead(401).end('{}'); return; }
    if (req.headers['x-agent-desktop-app-launch-key'] !== 'synthetic-management-key-32-characters') { res.writeHead(403).end('{}'); return; }
    if (req.url === '/state') { res.end(JSON.stringify({ vm_id: 'a', ...(advertised ? { app_launch: { protocolVersion: 1, scope: vmA } } : {}) })); return; }
    let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
      const request = JSON.parse(body); calls.push(request);
      const result = request.operation === 'reserve' ? { reservationId: 'reserved', context: { scope: vmA, sessionId: 's', instanceId: 'i', windowsSessionId: 1, desktop: 'WinSta0\\Default' } } :
        request.operation === 'stage' ? { stageId: 'staged', permitId: 'opaque-permit' } : request.operation === 'start' ? 'owned' : [];
      res.end(JSON.stringify({ protocolVersion: 1, scope: drift ? vmB : vmA, result })); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('test-server-unavailable');
  const transport = new GuestAppLaunchTransport(vmA, `http://127.0.0.1:${address.port}`, 'synthetic-token', 'a', 'synthetic-management-key-32-characters');
  const f = fixture(vmA);
  try {
    const { app } = await f.first(); const backend = new RpcAppLaunchBackend(vmA, transport, async () => {});
    const execution = await backend.open(new AbortController().signal); await execution.instances(app); await execution.start(app); await execution.close();
    const start = calls.find(value => value.operation === 'start'); assert.equal(start.stageId, 'staged');
    for (const key of ['executable', 'launchSpec', 'profile', 'confirmed', 'identity']) assert.equal(key in start, false);
    advertised = false; await assert.rejects(backend.open(new AbortController().signal), /unsupported-or-identity-mismatch/);
    advertised = true; drift = true; await assert.rejects(backend.open(new AbortController().signal), /identity-changed/);
  } finally { await f.service.close(); f.store.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
