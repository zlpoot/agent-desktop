import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvironmentAppScope } from '../src/contracts/environment-apps.js';
import type { AppCollection, AppDiscoveryCollector, CollectedApp, ReadonlyAppDiscovery } from '../src/contracts/app-discovery.js';
import { ScopedAppDiscovery, modelDiscoveredApp, queryEnvironmentApps } from '../src/environment-apps/discovery.js';
import { GuestAppCollector, WindowsAppCollector } from '../src/environment-apps/collectors.js';
import { discoveredEnvironment, sharedHostDiscovery } from '../src/composition/app-discovery.js';
import { composeEnvironmentApps } from '../src/composition/environment-apps.js';
import { SqliteEnvironmentAppStore } from '../src/environment-apps/sqlite-registry.js';

const host: EnvironmentAppScope = { providerId: 'physical', environmentId: 'host', installationScopeId: 'synthetic-host' };
const vmA: EnvironmentAppScope = { providerId: 'hyper-v', environmentId: 'vm:a', installationScopeId: 'synthetic-vm-a' };
const vmB: EnvironmentAppScope = { ...vmA, environmentId: 'vm:b', installationScopeId: 'synthetic-vm-b' };
const local: EnvironmentAppScope = { ...host, providerId: 'local-workspace', environmentId: 'hidden' };
const limits = { maxEntries: 20, maxDepth: 2, timeoutMs: 1000 };
const entry = (path = 'C:\\Synthetic\\Music.exe', displayName = 'QQ音乐'): CollectedApp => ({
  displayName, aliases: [], launchSpec: { kind: 'exe', executable: path, args: [] },
  source: 'app-paths-hkcu', contentFingerprint: 'synthetic-file-digest', version: '1.0', publisher: 'Synthetic Publisher' });
function collection(scope = host, entries = [entry()]): AppCollection {
  return { scope, entries, coverage: [{ source: 'app-paths-hkcu', status: 'complete', inspected: entries.length, rejected: 0 }] };
}
function fixture(scope = host, value = collection(scope)) {
  const calls: Array<{ operation: string; path?: string }> = [];
  const collector: AppDiscoveryCollector = { scope,
    async collect() { calls.push({ operation: 'scan' }); return structuredClone(value); },
    async inspectPath(path) { calls.push({ operation: 'inspect', path }); return structuredClone(value); } };
  return { collector, calls };
}

test('missing/unconfigured environment makes zero scanner calls; Host and two VMs stay scoped', async () => {
  const store = new SqliteEnvironmentAppStore(':memory:');
  try {
    const fixtures = [host, vmA, vmB].map(scope => fixture(scope, collection(scope, [entry(`C:\\${scope.installationScopeId}\\Music.exe`)])));
    const services = composeEnvironmentApps(store, fixtures.map(item => discoveredEnvironment(item.collector.scope, item.collector, limits)));
    await assert.rejects(queryEnvironmentApps(services, undefined as never, 'QQ音乐'), /invalid-desktop-target/);
    await assert.rejects(queryEnvironmentApps(services, { providerId: 'physical', environmentId: 'other' }, 'QQ音乐'), /unavailable/);
    assert.equal(fixtures.reduce((n, item) => n + item.calls.length, 0), 0);
    for (const scope of [host, vmA, vmB]) {
      const result = await queryEnvironmentApps(services, scope, 'QQ音乐');
      assert.equal(result.kind, 'found'); assert.deepEqual(result.matches[0].candidate.scope, scope);
      assert.match(JSON.stringify(result.matches[0].candidate.launchSpec), new RegExp(scope.installationScopeId));
      assert.equal(services.forEnvironment(scope).registry.list().length, 0);
    }
  } finally { store.close(); }
});

test('Local Workspace uses only explicit same-OS installation mapping, no lifecycle/input ports', async () => {
  const item = fixture(), infrastructure = sharedHostDiscovery(local, item.collector, limits);
  assert.throws(() => sharedHostDiscovery({ ...local, installationScopeId: 'other-user' }, item.collector), /mismatch/);
  assert.throws(() => sharedHostDiscovery(local, fixture(vmA).collector), /mismatch/);
  const report = await (infrastructure.discovery as ReadonlyAppDiscovery).scan();
  assert.equal(item.calls.length, 1); assert.equal(report.installationOrigin, 'shared-host-os');
  assert.deepEqual(report.candidates[0].scope, local);
  assert.match(report.snapshots[0].limitation!, /workspace-launch-and-operation-not-proven/);
  assert.equal(report.snapshots[0].trust, 'discovered'); assert.equal(infrastructure.launcher, undefined);
});

test('duplicates dedupe by resolved target + arguments + directory; same-name installations remain ambiguous', async () => {
  const exe = entry(), shortcut = { ...entry(), source: 'start-menu-user', launchSpec: {
    kind: 'shortcut' as const, shortcutPath: 'C:\\Synthetic\\Menu\\Music.lnk', executable: 'c:\\synthetic\\MUSIC.exe', args: [] } };
  const duplicate = { ...shortcut, source: 'start-menu-public', launchSpec: { ...shortcut.launchSpec, shortcutPath: 'C:\\Synthetic\\Common\\Music.lnk' } };
  const beta = entry('C:\\SyntheticBeta\\Music.exe'), portable = entry('D:\\Portable\\Music.exe');
  const alternate = { ...exe, launchSpec: { ...exe.launchSpec, kind: 'exe' as const, executable: 'C:\\Synthetic\\Music.exe', args: ['--beta'] } };
  const discovery = new ScopedAppDiscovery(host, fixture(host, collection(host, [exe, shortcut, duplicate, beta, portable, alternate])).collector, limits);
  const result = await discovery.query('QQ音乐');
  assert.equal(result.kind, 'ambiguous'); assert.equal(result.matches.length, 4);
  assert.equal(result.matches[0].sources.length, 3);
  assert.equal(new Set(result.matches.map(item => item.candidate.installationId)).size, 4);
  assert.ok(result.matches.every(item => item.trust === 'discovered' && !item.candidate.identity));
});

test('scan reports distinguish complete negative, incomplete coverage, valid partial matches and unavailable', async () => {
  const make = (value: AppCollection) => new ScopedAppDiscovery(host, fixture(host, value).collector, limits);
  assert.equal((await make(collection(host, [])).query('Missing')).kind, 'not-found-within-scanned-sources');
  for (const status of ['unavailable', 'timeout', 'truncated'] as const) {
    const report = { ...collection(host, []), coverage: [{ source: 'start-menu-user', status, inspected: 0, rejected: 0, reason: 'synthetic-limit-or-permission' }] };
    const result = await make(report).query('Missing');
    assert.equal(result.kind, 'unavailable'); assert.notEqual(result.report.status, 'complete');
    assert.deepEqual(result.nextActions, ['specify-path', 'rescan-after-install', 'cancel']);
  }
  const value = { ...collection(), coverage: [...collection().coverage,
    { source: 'start-menu-public', status: 'unavailable' as const, inspected: 0, rejected: 0, reason: 'permission-denied' }] };
  const partial = await make(value).query('QQ音乐');
  assert.equal(partial.kind, 'found'); assert.equal(partial.report.status, 'incomplete');
});

test('deadline aborts a stuck collector; oversized or cross-environment replies are never candidates', async () => {
  let aborted = false;
  const hanging: AppDiscoveryCollector = { scope: host,
    collect: async (_limits, signal) => { signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); },
    inspectPath: async () => collection() };
  const discovery = new ScopedAppDiscovery(host, hanging, { ...limits, timeoutMs: 20 });
  const result = await discovery.query('QQ音乐');
  assert.equal(result.kind, 'unavailable'); assert.equal(result.report.reason, 'app-scan-timeout'); assert.equal(aborted, true);
  for (const value of [collection(vmA), collection(host, Array.from({ length: 21 }, () => entry()))]) {
    const report = await new ScopedAppDiscovery(host, fixture(host, value).collector, limits).scan();
    assert.equal(report.status, 'unavailable'); assert.deepEqual(report.candidates, []);
  }
});

test('manual paths are inspected only in the chosen environment; injection and wrappers never reach execution', async () => {
  const item = fixture(vmA, collection(vmA)), discovery = new ScopedAppDiscovery(vmA, item.collector, limits);
  for (const path of ['\\\\server\\share\\app.exe', 'C:relative.exe', 'C:\\app.exe & calc', 'C:\\app.exe:stream', 'C:\\"app.exe']) {
    assert.notEqual((await discovery.inspectPath(path)).status, 'candidate');
  }
  assert.equal(item.calls.length, 0);
  const result = await discovery.inspectPath('C:\\GuestOnly\\Music.exe');
  assert.equal(result.status, 'candidate'); assert.deepEqual(result.snapshot!.candidate.scope, vmA);
  assert.equal(result.snapshot!.candidate.source.kind, 'manual');
  assert.deepEqual(item.calls, [{ operation: 'inspect', path: 'C:\\GuestOnly\\Music.exe' }]);
  await assert.rejects(discovery.inspect({ kind: 'exe', executable: 'C:\\Synthetic\\Music.exe', args: ['--injected'] }), /definition-mismatch/);
  for (const executable of ['C:\\cmd.exe', 'C:\\python.exe', '\\\\server\\Music.exe']) {
    const malicious = entry(executable, 'untrusted & text');
    const report = await new ScopedAppDiscovery(host, fixture(host, collection(host, [malicious])).collector, limits).scan();
    assert.equal(report.status, 'unavailable'); assert.equal(report.snapshots.length, 0);
  }
});

test('rescan invalidates candidate revisions and never revives confirmed/revoked Registry trust', async () => {
  const store = new SqliteEnvironmentAppStore(':memory:');
  try {
    const item = fixture(), services = composeEnvironmentApps(store, [discoveredEnvironment(host, item.collector, limits)]);
    const discovery = services.forEnvironment(host).discovery as ReadonlyAppDiscovery;
    const first = (await discovery.query('QQ音乐')).matches[0];
    const registry = services.forEnvironment(host).registry, app = registry.discover(first.candidate);
    const confirmed = registry.confirm({ appBindingId: app.appBindingId, expectedRevision: app.revision,
      profileDigest: app.profileDigest, operatorId: 'synthetic-user' });
    const revoked = registry.revoke(confirmed.appBindingId, confirmed.revision, 'synthetic-revocation');
    const second = (await discovery.query('QQ音乐')).matches[0];
    assert.ok(second.revision > first.revision); assert.notEqual(second.candidateId, first.candidateId);
    assert.throws(() => discovery.candidate(first.candidateId, first.revision), /stale-or-unknown/);
    assert.throws(() => discovery.candidate(second.candidateId, first.revision), /stale-or-unknown/);
    assert.deepEqual(discovery.candidate(second.candidateId, second.revision), second);
    assert.deepEqual(registry.get(app.appBindingId), revoked);
    assert.throws(() => registry.discover(second.candidate, revoked.revision), /app-revoked/);
    store.bind({ ...host, installationScopeId: 'replacement' });
    const count = item.calls.length;
    await assert.rejects(queryEnvironmentApps(services, host, 'QQ音乐'), /installation-scope-changed/);
    assert.equal(item.calls.length, count);
  } finally { store.close(); }
});

test('package metadata remains unsupported launch information and snapshot copies cannot be mutated', async () => {
  const packaged: CollectedApp = { ...entry(), launchSpec: { kind: 'package', packageFamilyName: 'Synthetic_family', applicationUserModelId: 'Synthetic!App' } };
  const discovery = new ScopedAppDiscovery(host, fixture(host, collection(host, [packaged])).collector, limits);
  const item = (await discovery.scan()).snapshots[0];
  assert.equal(item.limitation, 'package-launch-not-implemented');
  const model = modelDiscoveredApp(item);
  assert.deepEqual(Object.keys(model).sort(), ['aliases', 'candidateId', 'displayName', 'revision', 'trust']);
  assert.doesNotMatch(JSON.stringify(model), /fingerprint|publisher|packageFamilyName|launchSpec|scope/);
  (item.candidate.aliases as string[]).push('mutated');
  assert.deepEqual(discovery.candidate(item.candidateId, item.revision).candidate.aliases, []);
});

test('Host helper receives expected installation identity before scanning and is bounded without a shell', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'app-collector-fake-')), script = join(dir, 'fake-scanner.py');
  try {
    // This helper is a synthetic protocol fixture; never reads registry/menu/user data.
    writeFileSync(script, `import json, sys\nrequest = json.load(sys.stdin)\nassert request['installationScopeId'] == 'synthetic-host'\nassert request['operation'] == 'inspect'\nassert request['path'] == 'C:\\\\Synthetic\\\\Music.exe'\nprint(json.dumps({'installationScopeId':'synthetic-host','entries':[],'coverage':[{'source':'manual-path','status':'unavailable','inspected':1,'rejected':1,'reason':'FileNotFoundError'}]}))\n`);
    const discovery = new ScopedAppDiscovery(host, new WindowsAppCollector(host, 'python', script), limits);
    const result = await discovery.inspectPath('C:\\Synthetic\\Music.exe');
    assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'FileNotFoundError');
    writeFileSync(script, `import json, sys\njson.load(sys.stdin)\nprint(json.dumps({'installationScopeId':'different-user','entries':[],'coverage':[]}))\n`);
    assert.match((await discovery.query('QQ音乐')).report.reason!, /identity-mismatch/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Guest negotiation is authenticated and pinned; old Guest, wrong environment and reply drift fail closed', async () => {
  let state: unknown = { vm_id: 'a', app_discovery: { protocolVersion: 1, scope: vmA } };
  let reply: unknown = { protocolVersion: 1, ...collection(vmA) }, requests = 0;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer synthetic-token');
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/state') { response.end(JSON.stringify(state)); return; }
    assert.equal(request.url, '/apps/query'); requests++;
    let body = ''; for await (const chunk of request) body += String(chunk);
    const payload = JSON.parse(body); assert.deepEqual(payload.scope, vmA); assert.equal(payload.protocolVersion, 1);
    assert.deepEqual(Object.keys(payload).sort(), payload.operation === 'inspect' ? ['limits', 'operation', 'path', 'protocolVersion', 'scope'] : ['limits', 'operation', 'protocolVersion', 'scope']);
    response.end(JSON.stringify(reply));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const collector = new GuestAppCollector(vmA, `http://127.0.0.1:${address.port}`, 'synthetic-token', 'a');
    const discovery = new ScopedAppDiscovery(vmA, collector, limits);
    assert.equal((await discovery.query('QQ音乐')).kind, 'found');
    assert.equal((await discovery.inspectPath('C:\\Guest\\Music.exe')).status, 'candidate');
    assert.equal(requests, 2);
    for (const invalid of [{ vm_id: 'a' }, { vm_id: 'b', app_discovery: { protocolVersion: 1, scope: vmB } },
      { vm_id: 'a', app_discovery: { protocolVersion: 2, scope: vmA } }, { vm_id: 'a', app_discovery: { protocolVersion: 1, scope: vmB } }]) {
      state = invalid; assert.equal((await discovery.query('QQ音乐')).kind, 'unavailable');
    }
    assert.equal(requests, 2);
    state = { vm_id: 'a', app_discovery: { protocolVersion: 1, scope: vmA } };
    reply = { protocolVersion: 1, ...collection(vmB) };
    const result = await discovery.query('QQ音乐'); assert.equal(result.kind, 'unavailable'); assert.equal(result.matches.length, 0);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
