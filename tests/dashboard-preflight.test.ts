import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { resolve } from 'node:path';
import { preflightFixture } from './fixtures/dashboard-preflight.js';
import { createDashboardPreflight } from '../src/composition/dashboard-preflight.js';

test('A1 uses scoped P7 reads with no native Session; effects and unrelated Dashboard APIs fail closed', async () => {
  const f = await preflightFixture();
  try {
    const view = await (await fetch(`${f.base}/api/dashboard/preflight`)).json();
    assert.equal(view.mode, 'a1'); assert.equal(view.hostLabel, 'Synthetic Host');
    const environments = await (await fetch(`${f.base}/api/desktop/environments`)).json();
    assert.equal(environments.environments.length, 3);
    assert.ok(environments.environments.every((item: { executable: boolean }) => !item.executable));
    assert.equal((await f.post({ action: 'open' })).status, 409);
    assert.equal((await f.post({ action: 'open', desktopTarget: f.scopes[0] })).status, 409); // no kind injection
    const target = (index: number) => ({ providerId: f.scopes[index].providerId, environmentId: f.scopes[index].environmentId });
    const first = await (await f.post({ action: 'open', desktopTarget: target(0) })).json();
    assert.deepEqual(first.registered, []); assert.deepEqual(first.candidates, []);
    assert.equal(first.readiness.discovery, false); assert.equal(first.readiness.controlledLaunch, false);
    assert.match(first.preflight.discoveryReason, /不可用不表示未安装/);
    assert.equal(first.preflight.capabilities['input.globalInput'][0].state, 'forbidden');
    const guest = await (await f.post({ action: 'open', desktopTarget: target(2) })).json();
    assert.notEqual(guest.scope.installationScopeId, first.scope.installationScopeId);
    for (const action of ['scan', 'path', 'prepare', 'confirm', 'verify', 'revoke']) {
      const response = await f.post({ action, desktopTarget: target(0), sessionId: first.sessionId, revision: 0, requestId: action });
      assert.equal(response.status, 409); assert.equal((await response.json()).error, 'preflight-a1-operation-disabled');
      await assert.rejects(f.assembly.controller.manageApps!({ action }), /preflight-a1-operation-disabled/);
    }
    assert.equal((await f.post({ action: 'list', desktopTarget: target(1), sessionId: first.sessionId, revision: 0, requestId: 'cross' })).status, 409);
    for (const [method, route] of [['POST', '/api/tasks'], ['POST', '/api/desktop/control'], ['POST', '/api/desktop/vm/start'],
      ['POST', '/api/desktop/scenarios/tasks'], ['GET', '/api/runs'], ['GET', '/api/screenshots/x/y/1'], ['PUT', '/api/settings/task-budget']]) {
      assert.equal((await fetch(`${f.base}${route}?preflight=false`, { method })).status, 403);
    }
    assert.equal((await f.post({ action: 'open', desktopTarget: target(0) }, null)).status, 403);
    assert.equal((await f.post({ action: 'open', desktopTarget: target(0) }, 'http://untrusted.invalid')).status, 403);
    const wrongHost = await new Promise<number | undefined>((done, reject) => {
      const req = request(`${f.base}/api/dashboard/preflight`, { headers: { Host: 'untrusted.invalid' } }, response => {
        response.resume(); done(response.statusCode);
      }); req.on('error', reject); req.end();
    });
    assert.equal(wrongHost, 403);
    assert.equal((await fetch(`${f.base}/api/desktop/environments`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.throws(() => f.assembly.controller.submit('arbitrary task'), /preflight-a1-operation-disabled/);
    assert.equal(f.opens(), 0); assert.deepEqual(readdirSync(f.dir), ['operator.json']);
  } finally { await f.close(); }
});

test('A1 startup requires an explicit validated operator file', async () => {
  await assert.rejects(createDashboardPreflight('', '.'), /preflight-explicit-config-required/);
});

test('documented A1 CLI actually listens on localhost with synthetic empty configuration and shuts down', { timeout: 30000 }, async () => {
  const f = await preflightFixture();
  const reservation = createServer(); await new Promise<void>(done => reservation.listen(0, '127.0.0.1', done));
  const address = reservation.address(); if (!address || typeof address === 'string') throw new Error('missing port');
  await new Promise<void>(done => reservation.close(() => done()));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(AGENT_DESKTOP_|COMPUTER_USE_|JEV_|NETEASE_APP_PATH$)/.test(key)) delete env[key];
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), resolve('src/app/start-preflight.ts'), '--config', f.config, '--port', String(address.port)],
    { cwd: f.dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>(done => child.on('exit', done));
  try {
    await new Promise<void>((done, reject) => {
      let output = '';
      child.stdout.on('data', data => { output += data.toString(); if (output.includes('Ctrl+C')) done(); });
      child.once('error', reject); child.once('exit', code => reject(new Error(`startup exited: ${code}`)));
    });
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(response.status, 200); assert.match(await response.text(), /环境预检 A1/);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/tasks`, { method: 'POST' })).status, 403);
    assert.deepEqual(readdirSync(f.dir), ['operator.json']);
  } finally { child.kill('SIGTERM'); await exited; await f.close(); }
});
