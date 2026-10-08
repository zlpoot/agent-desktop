import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { preflightFixture } from './fixtures/dashboard-preflight.js';

test('B preview is composition-only and inert; selected environment reports missing proof without scanner/launch/Task routes', async () => {
  const f = await preflightFixture({ mode: 'bridge-preview' });
  try {
    const metadata = await (await fetch(`${f.base}/api/dashboard/preflight?live=true`)).json();
    assert.equal(metadata.mode, 'a1'); assert.equal(metadata.bridgePreview.applicationVersion, '3.1.40.205461');
    assert.match(metadata.bridgePreview.targetStatus, /尚未验证/);
    for (const scope of f.scopes) {
      const desktopTarget = { providerId: scope.providerId, environmentId: scope.environmentId };
      const view = await (await f.post({ action: 'open', desktopTarget })).json();
      assert.equal(view.readiness.discovery, false); assert.equal(view.readiness.controlledLaunch, false);
      assert.equal(view.preflight.taskBridge.state, 'unavailable'); assert.equal(view.preflight.taskBridge.liveAction, 'forbidden');
      for (const action of ['scan', 'path', 'prepare', 'confirm', 'verify', 'revoke']) {
        assert.equal((await f.post({ action, desktopTarget, sessionId: view.sessionId, revision: view.revision, requestId: action })).status, 409);
      }
    }
    for (const route of ['/api/tasks', '/api/desktop/scenarios/tasks', '/api/desktop/control', '/api/desktop/vm/start']) {
      assert.equal((await fetch(`${f.base}${route}`, { method: 'POST' })).status, 403);
    }
    assert.equal(f.opens(), 0); assert.equal(f.identityReads(), 0); assert.deepEqual(f.calls, []);
    assert.deepEqual(readdirSync(f.dir), ['operator.json']);
  } finally { await f.close(); }
});

test('B preview startup command serves actual loopback preview with synthetic empty configuration and no helper', { timeout: 30000 }, async () => {
  const f = await preflightFixture();
  const reservation = createServer(); await new Promise<void>(done => reservation.listen(0, '127.0.0.1', done));
  const address = reservation.address(); if (!address || typeof address === 'string') throw new Error('missing port');
  await new Promise<void>(done => reservation.close(() => done()));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(AGENT_DESKTOP_|COMPUTER_USE_|JEV_|NETEASE_APP_PATH$)/.test(key)) delete env[key];
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), resolve('src/app/start-preflight.ts'),
    '--bridge-preview', '--config', f.config, '--port', String(address.port)], { cwd: f.dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>(done => child.on('exit', done));
  try {
    await new Promise<void>((done, reject) => { let output = '';
      child.stdout.on('data', data => { output += data.toString(); if (output.includes('Ctrl+C')) done(); });
      child.once('error', reject); child.once('exit', code => reject(new Error(`startup exited: ${code}`))); });
    const base = `http://127.0.0.1:${address.port}`;
    const view = await (await fetch(`${base}/api/dashboard/preflight`)).json();
    assert.equal(view.bridgePreview.application, '网易云音乐');
    assert.equal((await fetch(`${base}/api/tasks`, { method: 'POST' })).status, 403);
    assert.deepEqual(readdirSync(f.dir), ['operator.json']);
  } finally { child.kill('SIGTERM'); await exited; await f.close(); }
});
