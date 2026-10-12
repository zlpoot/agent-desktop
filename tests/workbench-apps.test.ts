import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createRootAssembly } from '../src/composition/root.js';
import { WorkbenchApps, NativeWorkbenchAppClient, workbenchAppConfig, loadWorkbenchAppConfig } from '../src/desktop-provider/workbench-apps.js';
import { config, scope, FakeWorkbenchClient } from './fixtures/workbench-apps.js';

test('opening B while A runs preserves A, its preview and lease; B failures release only B reservations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-cross-app-')), client = new FakeWorkbenchClient();
  const root = await createRootAssembly({ rootDir: dir, workbenchApps: new WorkbenchApps(undefined, scope.installationScopeId, client, true),
    model: { createModel() { throw Error('no-model'); } } });
  const target = { providerId: scope.providerId, environmentId: scope.environmentId };
  let view: any = await root.controller.manageApps({ action: 'open', desktopTarget: target });
  const act = async (action: string, fields = {}) => view = await root.controller.manageApps({ action, desktopTarget: target,
    sessionId: view.sessionId, revision: view.revision, requestId: crypto.randomUUID(), ...fields });
  const selected = (id: string) => view.registered.find((app: any) => app.appBindingId === id);
  const open = (id: string) => act('verify', { appBindingId: id, expectedRevision: selected(id).revision, allowLaunch: true });
  const stop = (id: string) => act('stop', { appBindingId: id, expectedRevision: selected(id).revision });
  const preview = (id: string) => root.controller.manageApps({ action: 'preview', desktopTarget: target,
    sessionId: view.sessionId, revision: view.revision, requestId: crypto.randomUUID(), appBindingId: id, expectedRevision: selected(id).revision });
  try {
    for (const path of ['C:\\Synthetic\\Editor.exe', 'D:\\Synthetic\\Viewer.exe']) await act('path', { path, save: true });
    const [a, b] = view.registered;
    await open(a.appBindingId);
    const reservation = client.reservationId, expires = client.expiresAt, before = client.calls.length;
    await open(b.appBindingId);
    assert.equal(selected(b.appBindingId).verifications.at(-1).reason, 'workbench-app-in-use');
    assert.equal(client.starts, 1); assert.equal(client.active, true); assert.equal(client.activeProfile?.appBindingId, a.appBindingId);
    assert.equal(client.reservationId, reservation); assert.equal(client.expiresAt, expires); assert.equal(client.allocations, 1);
    assert.equal(client.releasedReservations.length, 0); assert.equal(client.stops, 0);
    assert.ok(!client.calls.slice(before).some(method => ['close', 'cleanup', 'fit'].includes(method)));
    assert.equal(view.liveStatus[a.appBindingId].state, 'window-confirmed');
    const frameA: any = await preview(a.appBindingId); assert.equal(frameA.appBindingId, a.appBindingId);
    await open(a.appBindingId); assert.equal(client.starts, 1); assert.equal(client.expiresAt, expires);
    await stop(a.appBindingId); await open(b.appBindingId);
    assert.equal(client.starts, 2); assert.equal(client.activeProfile?.appBindingId, b.appBindingId); assert.equal(client.allocations, 2);
    const frameB: any = await preview(b.appBindingId); assert.equal(frameB.appBindingId, b.appBindingId);
    await stop(b.appBindingId);
    client.windowFailure = 'workbench-main-window-ambiguous-or-unsupported';
    await open(b.appBindingId);
    assert.equal(client.starts, 3); assert.equal(client.active, false); assert.equal(client.releasedReservations.length, 1);
    assert.ok(client.calls.includes('cleanup')); assert.equal(client.reservationId, undefined);
    client.windowFailure = undefined; client.conflict = true;
    await open(b.appBindingId);
    assert.equal(client.starts, 3); assert.equal(client.releasedReservations.length, 2, 'pre-dispatch failure must release its newly created Job/Desktop');
    assert.equal(client.reservationId, undefined);
  } finally { await root.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test('cancellation after this request starts still releases its own reservation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-cancel-')), client = new FakeWorkbenchClient();
  let release = () => {};
  const held = new Promise<void>(done => { release = done; }); client.beforeStart = () => held;
  const root = await createRootAssembly({ rootDir: dir, workbenchApps: new WorkbenchApps(undefined, scope.installationScopeId, client, true),
    model: { createModel() { throw Error('no-model'); } } });
  const target = { providerId: scope.providerId, environmentId: scope.environmentId };
  let view: any = await root.controller.manageApps({ action: 'open', desktopTarget: target });
  const body = (action: string, fields = {}) => ({ action, desktopTarget: target, sessionId: view.sessionId,
    revision: view.revision, requestId: crypto.randomUUID(), ...fields });
  try {
    view = await root.controller.manageApps(body('path', { path: 'C:\\Synthetic\\Editor.exe', save: true }));
    const app = view.registered[0];
    const opening = root.controller.manageApps(body('verify', { appBindingId: app.appBindingId, expectedRevision: app.revision, allowLaunch: true }));
    const rejected = assert.rejects(opening, /closed|expired|cancel/);
    const until = Date.now() + 3000;
    while (!client.active && Date.now() < until) await new Promise(done => setTimeout(done, 10));
    assert.equal(client.active, true);
    await root.controller.manageApps(body('cancel')); release(); await rejected;
    assert.equal(client.active, false); assert.equal(client.reservationId, undefined);
    assert.equal(client.releasedReservations.length, 1); assert.ok(client.calls.includes('release'));
    assert.equal(client.starts, 1);
  } finally { release(); await root.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test('failed own cleanup remains unknown and blocks another launch without releasing other resources', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-cleanup-failure-')), client = new FakeWorkbenchClient();
  client.windowFailure = 'workbench-main-window-ambiguous-or-unsupported'; client.cleanupFailure = true;
  const root = await createRootAssembly({ rootDir: dir, workbenchApps: new WorkbenchApps(undefined, scope.installationScopeId, client, true),
    model: { createModel() { throw Error('no-model'); } } });
  const target = { providerId: scope.providerId, environmentId: scope.environmentId };
  let view: any = await root.controller.manageApps({ action: 'open', desktopTarget: target });
  const act = async (action: string, fields = {}) => view = await root.controller.manageApps({ action, desktopTarget: target,
    sessionId: view.sessionId, revision: view.revision, requestId: crypto.randomUUID(), ...fields });
  try {
    await act('path', { path: 'C:\\Synthetic\\Editor.exe', save: true });
    const app = view.registered[0];
    await act('verify', { appBindingId: app.appBindingId, expectedRevision: app.revision, allowLaunch: true });
    assert.equal(view.registered[0].verifications.at(-1).reason, 'launch-result-unknown:app-launch-cleanup-unconfirmed');
    assert.equal(view.liveStatus[app.appBindingId].state, 'unknown'); assert.equal(client.starts, 1);
    assert.equal(client.releasedReservations.length, 0); assert.ok(client.reservationId);
    await assert.rejects(act('verify', { appBindingId: app.appBindingId, expectedRevision: view.registered[0].revision, allowLaunch: true }), /resource-blocked/);
    assert.equal(client.starts, 1);
    await assert.rejects(root.environmentApps.forEnvironment(target).onboarding!.close(), /cleanup-unconfirmed/);
  } finally { await root.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test('explicit stop is scoped, revision fenced and idempotent; retains saved configuration and launch history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-stop-')), client = new FakeWorkbenchClient();
  const root = await createRootAssembly({ rootDir: dir, workbenchApps: new WorkbenchApps(undefined, scope.installationScopeId, client, true),
    model: { createModel() { throw Error('no-model'); } } });
  const target = { providerId: scope.providerId, environmentId: scope.environmentId };
  let view: any = await root.controller.manageApps({ action: 'open', desktopTarget: target });
  const body = (action: string, fields = {}) => ({ action, desktopTarget: target, sessionId: view.sessionId, revision: view.revision, requestId: crypto.randomUUID(), ...fields });
  const act = async (action: string, fields = {}) => view = await root.controller.manageApps(body(action, fields));
  try {
    for (const path of ['C:\\Synthetic\\Editor.exe', 'D:\\Synthetic\\Viewer.exe']) await act('path', { path, save: true });
    const [a, b] = view.registered;
    await act('verify', { appBindingId: a.appBindingId, expectedRevision: a.revision, allowLaunch: true });
    const current = view.registered.find((app: any) => app.appBindingId === a.appBindingId);
    await assert.rejects(root.controller.manageApps(body('stop', { appBindingId: b.appBindingId, expectedRevision: b.revision })), /original-profile-required/);
    await assert.rejects(root.controller.manageApps(body('stop', { appBindingId: a.appBindingId, expectedRevision: current.revision - 1 })), /profile-conflict/);
    await assert.rejects(root.controller.manageApps({ ...body('stop', { appBindingId: a.appBindingId, expectedRevision: current.revision }), desktopTarget: { ...target, environmentId: 'other' } }), /session-target-mismatch/);
    assert.equal(client.stops, 0); assert.equal(client.active, true);
    const stop = body('stop', { appBindingId: a.appBindingId, expectedRevision: current.revision });
    view = await root.controller.manageApps(stop); await root.controller.manageApps(stop);
    assert.equal(client.stops, 1); assert.equal(client.starts, 1); assert.equal(client.active, false);
    assert.equal(view.liveStatus[a.appBindingId].reason, 'workbench-operator-closed');
    assert.equal(view.registered.length, 2); assert.deepEqual(view.registered.find((app: any) => app.appBindingId === a.appBindingId).verifications, current.verifications);
    await act('verify', { appBindingId: a.appBindingId, expectedRevision: current.revision, allowLaunch: true });
    assert.equal(client.starts, 2); client.stopFailure = true;
    await assert.rejects(act('stop', { appBindingId: a.appBindingId, expectedRevision: view.registered.find((app: any) => app.appBindingId === a.appBindingId).revision }), /cleanup-unconfirmed/);
    assert.equal(client.stops, 2); assert.equal(client.starts, 2);
  } finally { await root.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test('ordinary Root wires configured App service and App-only environment without task/model/input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-wiring-')), client = new FakeWorkbenchClient(); let models = 0;
  const provider = new WorkbenchApps(config, scope.installationScopeId, client, true);
  const root = await createRootAssembly({ rootDir: dir, workbenchApps: provider, model: { createModel() { models++; throw Error('no-model'); } } });
  try {
    const option = (await root.controller.desktopOptions()).find(item => item.providerId === scope.providerId)!;
    assert.equal(option.executable, false); await assert.rejects(provider.open(), /no-task-runtime/);
    const target = { providerId: scope.providerId, environmentId: scope.environmentId };
    let view: any = await root.controller.manageApps({ action: 'open', desktopTarget: target });
    assert.equal(view.configuredAppList, true); assert.equal(view.readiness.controlledLaunch, true); assert.equal(client.starts, 0);
    const act = async (action: string, fields = {}) => view = await root.controller.manageApps({ action, desktopTarget: target,
      sessionId: view.sessionId, revision: view.revision, requestId: crypto.randomUUID(), ...fields });
    await act('scan'); assert.equal(view.candidates[0].candidate.displayName, '网易云音乐'); assert.equal(client.starts, 0);
    await act('prepare', { candidateId: view.candidates[0].candidateId, candidateRevision: view.candidates[0].revision });
    assert.equal(client.starts, 0); await act('confirm', { confirmationId: view.confirmation.confirmationId, digest: view.confirmation.digest, allowLaunch: true });
    assert.equal(client.starts, 1); assert.equal(view.registered[0].trust, 'verified');
    assert.doesNotMatch(JSON.stringify(view), /private-owned-app|WinSta0/);
    await act('verify', { appBindingId: view.registered[0].appBindingId, expectedRevision: view.registered[0].revision, allowLaunch: true });
    assert.equal(client.starts, 1); assert.equal(models, 0);
    client.changed = true;
    await act('verify', { appBindingId: view.registered[0].appBindingId, expectedRevision: view.registered[0].revision, allowLaunch: true });
    assert.equal(view.registered[0].verifications.at(-1).result, 'unavailable'); assert.equal(client.active, true); assert.equal(client.starts, 1);
    assert.equal(client.releasedReservations.length, 0, 'failed re-observation cannot release a borrowed execution');
  } finally { await root.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test('legacy seed accepts ordinary EXEs and probed versions; rejects wrappers, malformed paths and authority', () => {
  assert.equal(workbenchAppConfig({ ...config, path: 'D:\\Synthetic\\Editor.exe', version: '2.0' }).version, '2.0');
  for (const invalid of [{ ...config, path: 'C:\\Windows\\cmd.exe' }, { ...config, path: '\\\\server\\cloudmusic.exe' },
    { ...config, version: '' }, { ...config, sha256: 'not-a-pin' }, { ...config, allowLaunch: true }]) assert.throws(() => workbenchAppConfig(invalid));
  const dir = mkdtempSync(join(tmpdir(), 'workbench-config-'));
  try { assert.equal(loadWorkbenchAppConfig(dir), undefined); assert.throws(() => loadWorkbenchAppConfig(dir, join(dir, 'missing.json'))); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});


test('manual imports persist two paths/names across Root restart without scan/start/model; polling cannot launch or consume receipts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'manual-app-import-'));
  let client = new FakeWorkbenchClient(), models = 0;
  const assemble = () => createRootAssembly({ rootDir: dir, workbenchApps: new WorkbenchApps(undefined, scope.installationScopeId, client, true),
    model: { createModel() { models++; throw Error('no-model'); } } });
  let root = await assemble();
  const target = { providerId: scope.providerId, environmentId: scope.environmentId };
  let view: any;
  const act = async (action: string, fields = {}) => view = await root.controller.manageApps({ action, desktopTarget: target,
    sessionId: view.sessionId, revision: view.revision, requestId: crypto.randomUUID(), ...fields });
  try {
    view = await root.controller.manageApps({ action: 'open', desktopTarget: target });
    for (const [path, displayName] of [['C:\\Synthetic\\Editor.exe', '编辑器'], ['D:\\Synthetic\\Viewer.exe', '查看器']]) {
      await act('path', { path, displayName, save: true });
    }
    assert.deepEqual(new Set(view.registered.map((app: any) => app.displayName)), new Set(['编辑器', '查看器']));
    assert.equal(client.starts, 0); assert.ok(!client.calls.includes('reserve')); assert.equal(models, 0);
    const oldSession = view.sessionId;
    await root.dispose(); client = new FakeWorkbenchClient(); root = await assemble();
    view = await root.controller.manageApps({ action: 'open', desktopTarget: target });
    assert.equal(view.registered.length, 2); assert.ok(Object.values(view.liveStatus).every((live: any) => live.state === 'saved'));
    await assert.rejects(root.controller.manageApps({ action: 'list', desktopTarget: target, sessionId: oldSession, revision: 0, requestId: crypto.randomUUID() }), /session-target-mismatch/);
    const app = view.registered[0];
    await act('verify', { appBindingId: app.appBindingId, expectedRevision: app.revision, allowLaunch: true });
    assert.equal(client.starts, 1); assert.equal(view.liveStatus[app.appBindingId].state, 'window-confirmed');
    const frame: any = await root.controller.manageApps({ action: 'preview', desktopTarget: target, sessionId: view.sessionId,
      revision: view.revision, requestId: crypto.randomUUID(), appBindingId: app.appBindingId, expectedRevision: view.registered[0].revision });
    assert.equal(frame.frame.width, 1); assert.equal(frame.appBindingId, app.appBindingId); assert.equal(client.starts, 1);
    await assert.rejects(root.controller.manageApps({ action: 'preview', desktopTarget: { ...target, environmentId: 'another' }, sessionId: view.sessionId,
      revision: view.revision, requestId: crypto.randomUUID(), appBindingId: app.appBindingId, expectedRevision: view.registered[0].revision }), /session-target-mismatch/);
    // Poll more than the operation-receipt limit, without launches or a lease extension.
    for (let i = 0; i < 130; i++) await act('list');
    assert.equal(client.starts, 1);
    client.active = false; client.ended = true;
    await act('list'); assert.equal(view.liveStatus[app.appBindingId].state, 'exited');
    await assert.rejects(root.controller.manageApps({ action: 'preview', desktopTarget: target, sessionId: view.sessionId,
      revision: view.revision, requestId: crypto.randomUUID(), appBindingId: app.appBindingId, expectedRevision: view.registered[0].revision }), /original-window-unavailable/);
    assert.equal(view.registered[0].verifications.at(-1).result, 'verified', 'audit is historical; live exit is separate');
    client.unknown = true;
    await act('list'); assert.equal(view.liveStatus[app.appBindingId].state, 'unknown'); assert.equal(client.starts, 1);
    await assert.rejects(act('path', { path: 'C:\\Windows\\cmd.exe', displayName: 'shell', save: true }), /wrapper/);
    assert.equal(client.starts, 1); assert.equal(models, 0);
  } finally { await root.dispose(); rmSync(dir, { recursive: true, force: true }); }
});


test('ordinary dashboard CLI needs neither APP JSON nor model keys; empty scoped list uses a synthetic identity only', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ordinary-app-start-'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'scripts/dashboard-app-identity.py'), `import json\nprint(json.dumps({'installationScopeId':'${scope.installationScopeId}'}))\n`.replaceAll('\\n', '\n'));
  const listener = createServer(); await new Promise<void>(done => listener.listen(0, '127.0.0.1', done));
  const port = (listener.address() as { port: number }).port; await new Promise<void>(done => listener.close(() => done()));
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(COMPUTER_USE_|AGENT_DESKTOP_|JEV_|NETEASE_APP_PATH$)/.test(key)) delete environment[key];
  const child = spawn(process.execPath, ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
    resolve('src/app/start.ts'), '--port', String(port)], { cwd: dir, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data.toString(); }); child.stderr.on('data', data => { output += data.toString(); });
  try {
    const until = Date.now() + 15000;
    while (!output.includes(`http://127.0.0.1:${port}`) && child.exitCode === null && Date.now() < until) await new Promise(done => setTimeout(done, 25));
    assert.match(output, new RegExp(`http://127.0.0.1:${port}`), output);
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(base)).status, 200);
    const response = await fetch(`${base}/api/desktop/apps`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ action: 'open', desktopTarget: { providerId: scope.providerId, environmentId: scope.environmentId } }) });
    assert.equal(response.status, 200);
    const view: any = await response.json(); assert.equal(view.registered.length, 0); assert.equal(view.readiness.controlledLaunch, true);
    assert.equal(view.scope.installationScopeId, scope.installationScopeId);
    assert.equal((await fetch(`${base}/workbench-app-launcher.js`)).status, 200);
    assert.ok(!output.includes('Workbench native'), 'empty console must not initialize a native APP worker');
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise<void>(done => child.once('exit', () => done())); }
    rmSync(dir, { recursive: true, force: true });
  }
});


test('native preview transport uses bounded opaque private PNG files, checks digest/geometry and never raises stdio limits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'app-preview-transport-'));
  const workerDir = join(dir, 'src/desktop-provider'); mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, 'workbench_app_worker.py'), String.raw`import json,sys,uuid,base64,hashlib
from pathlib import Path
root=Path(__file__).resolve().parents[2]
nonce='b'*32
folder=root/'.artifacts/workbench-app-preview'/nonce
folder.mkdir(parents=True)
png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4AWPQaDoBAAJIAXNHdacMAAAAAElFTkSuQmCC')
for line in sys.stdin:
    value=json.loads(line);method=value['method'];fields=value.get('fields',{})
    if method=='init': result={'initialized':True,'previewDirectory':nonce}
    elif method=='preview':
        mode=fields.get('case');token=uuid.uuid4().hex
        path=folder/(token+'.png');path.write_bytes(png if mode!='oversize' else b'x'*4194305)
        result={'token':token,'sha256':hashlib.sha256(png).hexdigest(),'width':1,'height':1,'capturedAt':'2090-01-01T00:00:00Z','expiresAt':'2099-01-01T00:00:00Z'}
        from datetime import datetime,timezone
        result['capturedAt']=datetime.now(timezone.utc).isoformat()
        if mode=='traversal':result['token']='../private'
        if mode=='hash':result['sha256']='0'*64
        if mode=='geometry':result['width']=2
        if mode=='expired':result['expiresAt']='2000-01-01T00:00:00Z'
    else:result={'cleaned':True}
    print(json.dumps({'id':value['id'],'result':result}),flush=True)
`);
  const client = new NativeWorkbenchAppClient(undefined, scope, join(dir, 'synthetic.sqlite'), dir);
  try {
    const frame: any = await client.call('preview'); assert.equal(frame.width, 1); assert.ok(frame.png.startsWith('iVBOR'));
    const { readdirSync } = await import('node:fs');
    assert.equal(readdirSync(join(dir, '.artifacts/workbench-app-preview', 'b'.repeat(32))).length, 0, 'received PNG removed');
    for (const invalid of ['hash', 'geometry', 'expired', 'oversize', 'traversal']) await assert.rejects(client.call('preview', { case: invalid }), /preview-/);
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});
