import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { preflightFixture } from './fixtures/dashboard-preflight.js';
import { readDashboardInstallationIdentity } from '../src/composition/dashboard-discovery.js';

test('A2 P7 collector is explicit, selected and read-only; Host/Workspace origins never become Guest inventory or launch trust', async () => {
  const f = await preflightFixture({ mode: 'a2' });
  const target = (i: number) => ({ providerId: f.scopes[i].providerId, environmentId: f.scopes[i].environmentId });
  try {
    assert.equal(f.assembly.view.mode, 'a2'); assert.equal(f.identityReads(), 1); assert.deepEqual(f.calls, []);
    assert.equal((await f.post({ action: 'scan', desktopTarget: target(0) })).status, 409);
    let host = await (await f.post({ action: 'open', desktopTarget: target(0) })).json();
    const workspace = await (await f.post({ action: 'open', desktopTarget: target(1) })).json();
    const guest = await (await f.post({ action: 'open', desktopTarget: target(2) })).json();
    assert.deepEqual(f.calls, []); assert.equal(host.readiness.discovery, true);
    assert.equal(workspace.readiness.controlledLaunch, false); assert.equal(guest.readiness.discovery, false);
    assert.match(guest.preflight.discoveryReason, /不会扫描本机/);
    assert.notEqual(guest.scope.installationScopeId, host.scope.installationScopeId);
    const act = async (view: typeof host, action: string, extra = {}) => f.post({ action, desktopTarget: view.desktopTarget,
      sessionId: view.sessionId, revision: view.revision, requestId: crypto.randomUUID(), ...extra });
    host = await (await act(host, 'scan')).json();
    assert.equal(f.calls.length, 1); assert.equal(host.report.status, 'complete');
    assert.equal(host.report.installationOrigin, 'selected-environment');
    assert.deepEqual(host.candidates[0].candidate.scope, host.scope); assert.deepEqual(host.registered, []);
    assert.equal(host.candidates[0].trust, 'discovered'); assert.equal(host.readiness.taskCompatibility, false);
    const local = await (await act(workspace, 'scan')).json();
    assert.equal(local.report.installationOrigin, 'shared-host-os');
    assert.deepEqual(local.candidates[0].candidate.scope, workspace.scope);
    assert.notEqual(local.candidates[0].candidateId, host.candidates[0].candidateId);
    assert.match(local.candidates[0].limitation, /workspace-launch-and-operation-not-proven/);
    assert.equal((await act(guest, 'scan')).status, 409); assert.equal(f.calls.length, 2);
    for (const action of ['prepare', 'confirm', 'verify', 'revoke']) {
      const response = await act(host, action); assert.equal(response.status, 409);
      assert.equal((await response.json()).error, 'preflight-a2-operation-disabled');
      await assert.rejects(f.assembly.controller.manageApps!({ action }), /preflight-a2-operation-disabled/);
    }
    assert.equal((await f.post({ action: 'scan', desktopTarget: target(1), sessionId: host.sessionId,
      revision: host.revision, requestId: 'cross-environment' })).status, 409);
    assert.equal((await act(host, 'path', { path: '\\\\untrusted\\app.exe' })).status, 200);
    assert.equal(f.calls.length, 2, 'unsupported paths must not reach collector');
    const inspected = await (await act(local, 'path', { path: 'C:\\Synthetic\\Music.exe' })).json();
    assert.equal(inspected.candidates.length, 1); assert.equal(inspected.report.installationOrigin, 'shared-host-os');
    for (const route of ['/api/tasks', '/api/desktop/control', '/api/desktop/vm/start']) {
      assert.equal((await fetch(`${f.base}${route}?mode=a1`, { method: 'POST' })).status, 403);
    }
    assert.equal((await f.post({ action: 'open', desktopTarget: target(0) }, 'http://untrusted.invalid')).status, 403);
    assert.throws(() => f.assembly.controller.submit('task'), /preflight-a2-operation-disabled/);
    assert.equal(f.opens(), 0); assert.deepEqual(readdirSync(f.dir), ['operator.json']);
  } finally { await f.close(); }
});

test('A2 documented CLI serves discovery mode using fixed synthetic helpers, with no app read before the operator click', { timeout: 30000 }, async () => {
  const f = await preflightFixture(), identity = `windows:${'b'.repeat(64)}`;
  mkdirSync(join(f.dir, 'scripts')); mkdirSync(join(f.dir, 'guest'));
  // Node acts as trusted fake Python here. Neither helper reads any real OS identity or app source.
  writeFileSync(join(f.dir, 'scripts/dashboard-app-identity.py'), `console.log(JSON.stringify({installationScopeId:'${identity}'}));`);
  writeFileSync(join(f.dir, 'guest/app_discovery.py'), `const fs=require('node:fs');let data='';process.stdin.on('data',chunk=>data+=chunk);process.stdin.on('end',()=>{
    const request=JSON.parse(data);if(request.installationScopeId!=='${identity}'||request.operation!=='scan')process.exit(1);
    fs.writeFileSync('synthetic-click-record.json',JSON.stringify(request));
    console.log(JSON.stringify({installationScopeId:'${identity}',entries:[],coverage:[{source:'app-paths-hkcu',status:'complete',inspected:0,rejected:0}]}));});`);
  const reservation = createServer(); await new Promise<void>(done => reservation.listen(0, '127.0.0.1', done));
  const address = reservation.address(); if (!address || typeof address === 'string') throw new Error('missing port');
  await new Promise<void>(done => reservation.close(() => done()));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(AGENT_DESKTOP_|COMPUTER_USE_|JEV_|NETEASE_APP_PATH$)/.test(key)) delete env[key];
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), resolve('src/app/start-preflight.ts'),
    '--readonly-discovery', '--config', f.config, '--port', String(address.port), '--python', process.execPath],
    { cwd: f.dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>(done => child.on('exit', done));
  try {
    await new Promise<void>((done, reject) => {
      let output = ''; child.stdout.on('data', data => { output += data.toString(); if (output.includes('Ctrl+C')) done(); });
      child.once('error', reject); child.once('exit', code => reject(new Error(`startup exited: ${code}`)));
    });
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await (await fetch(`${base}/api/dashboard/preflight`)).json()).mode, 'a2');
    const target = { providerId: 'physical', environmentId: 'current-interactive-desktop' };
    const post = (body: object) => fetch(`${base}/api/desktop/apps`, { method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const view = await (await post({ action: 'open', desktopTarget: target })).json();
    assert.equal(view.readiness.discovery, true); assert.equal(existsSync(join(f.dir, 'synthetic-click-record.json')), false);
    const scanned = await (await post({ action: 'scan', desktopTarget: target, sessionId: view.sessionId,
      revision: view.revision, requestId: 'operator-click' })).json();
    assert.equal(scanned.report.status, 'complete'); assert.equal(scanned.candidates.length, 0);
    assert.equal(existsSync(join(f.dir, 'synthetic-click-record.json')), true);
    assert.equal((await fetch(`${base}/api/tasks`, { method: 'POST' })).status, 403);
  } finally { child.kill('SIGTERM'); await exited; await f.close(); }
});

test('A2 installation identity failure cannot fall back to an unverified Host or Workspace list', async () => {
  for (const identity of [new Error('synthetic-unavailable'), 'synthetic-unverified-identity']) {
    const f = await preflightFixture({ mode: 'a2', identity });
    try {
      const target = { providerId: 'physical', environmentId: 'synthetic-host' };
      const view = await (await f.post({ action: 'open', desktopTarget: target })).json();
      assert.equal(view.readiness.discovery, false); assert.match(view.preflight.discoveryReason, /无法核对.*不表示未安装/);
      assert.equal((await f.post({ action: 'scan', desktopTarget: target, sessionId: view.sessionId,
        revision: view.revision, requestId: 'no-identity' })).status, 409);
      assert.deepEqual(f.calls, []); assert.equal(f.opens(), 0);
    } finally { await f.close(); }
  }
});

test('A2 identity helper reply is bounded, failures masked and identity data validated without scanning', async () => {
  const f = await preflightFixture(), script = join(f.dir, 'synthetic-identity.mjs');
  try {
    writeFileSync(script, `process.stdout.write(JSON.stringify({ installationScopeId: 'windows:${'a'.repeat(64)}' }));`);
    assert.equal(await readDashboardInstallationIdentity(process.execPath, script), `windows:${'a'.repeat(64)}`);
    for (const source of [
      `console.log(JSON.stringify({installationScopeId:'untrusted'}));`,
      `console.log(JSON.stringify({installationScopeId:'windows:${'a'.repeat(64)}',error:'private'}));`,
      `process.stdout.write('x'.repeat(4097));`,
      `console.error('synthetic-private-identity');process.exit(1);`,
      `setInterval(()=>{},1000);`,
    ]) {
      writeFileSync(script, source);
      await assert.rejects(readDashboardInstallationIdentity(process.execPath, script), /^Error: windows-app-identity-unavailable$/);
    }
    await assert.rejects(readDashboardInstallationIdentity(join(f.dir, 'missing-executable'), script), /windows-app-identity-unavailable/);
    assert.deepEqual(f.calls, []);
  } finally { await f.close(); }
});
