import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRootAssembly } from '../src/composition/root.js';
import { createDashboardServer } from '../src/app/server.js';
import { ScenarioWorkspace } from './fixtures/local-workspace-scenario.js';
import { SqliteTrace } from '../src/trace/sqlite-trace.js';
import { TaskDesktopSessions } from '../src/app/task-desktop-sessions.js';
import { LocalWorkspaceDesktopProvider } from '../src/desktop-provider/local-workspace-provider.js';
import { LocalWorkspaceTaskExecutor } from '../src/desktop-provider/local-workspace-task-executor.js';
import { ResourceInputControl } from '../src/desktop-provider/resource-input-control.js';

test('catalog is read-only, immutable and reports supported-but-unavailable executor without a Session', async () => {
  const provider = new LocalWorkspaceDesktopProvider(new ResourceInputControl(), { app: 'fixture' }, '', '',
    () => { throw new Error('discovery cannot construct backend'); }, true);
  const executor = new LocalWorkspaceTaskExecutor(provider);
  const sessions = new TaskDesktopSessions([provider], new Map([[provider.id, executor]]));
  try {
    const initial = (await sessions.discover())[0]!;
    assert.ok(Object.isFrozen(initial.scenarios)); assert.ok(Object.isFrozen(initial.scenarios![0]));
    executor.scenario = () => { throw new Error('executor unavailable'); };
    const blocked = (await sessions.discover())[0]!;
    assert.equal(blocked.executable, false); assert.equal(blocked.scenarios![0]!.availability, 'unavailable');
    assert.equal(blocked.scenarios![1]!.availability, 'unsupported');
    executor.scenarios = () => [initial.scenarios![0]!, initial.scenarios![0]!];
    await assert.rejects(sessions.discover(), /invalid-desktop-scenario-catalog/);
  } finally { await sessions.close(); await provider.close(); }
});

test('missing finite scenario controller cannot fall back to generic submit', async () => {
  const server = createDashboardServer('', { submit() { assert.fail('generic fallback'); }, resume() {}, pause() {}, continue() {} });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
  try {
    const result = await fetch(`http://127.0.0.1:${address.port}/api/desktop/scenarios/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(result.status, 503);
  } finally { await new Promise<void>(done => server.close(() => done())); }
});

for (const app of ['fixture', 'netease'] as const) {
  test(`HTTP catalog and explicit ${app} submission retain production finite fences`, { timeout: 10000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'p6-c-api-'));
    const backend = new ScenarioWorkspace(); let factories = 0;
    const config = app === 'fixture' ? { app } : { app, path: 'C:\\synthetic\\cloudmusic.exe', song: '我怀念的', artist: '孙燕姿' };
    const assembly = await createRootAssembly({ rootDir: directory, localWorkspace: config,
      localWorkspaceBackendFactory: () => { factories++; return backend; },
      model: { createModel: () => { throw new Error('no model allowed'); } } });
    const server = createDashboardServer(directory, assembly.controller);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
    const base = `http://127.0.0.1:${address.port}`;
    const target = { providerId: 'windows-local-workspace', environmentId: `local-workspace:${app}` };
    const scenarioId = app === 'fixture' ? 'd0-fixture-text-click-v1' : 'd0-netease-fixed-track-v1';
    const post = (body: object, path = '/api/desktop/scenarios/tasks', headers = {}) => fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    try {
      for (let n = 0; n < 2; n++) {
        const response = await fetch(base + '/api/desktop/environments'); assert.equal(response.status, 200);
        const data = await response.json(); const workspace = data.environments.find((item: { providerId: string }) => item.providerId === target.providerId);
        assert.equal(workspace.executable, false);
        assert.deepEqual(workspace.scenarios.map((item: { availability: string }) => item.availability), ['supported', 'unsupported', 'not-proven', 'not-proven']);
        assert.equal(workspace.scenarios[0].id, scenarioId);
        assert.equal(workspace.scenarios[0].applicationVersion, app === 'fixture' ? 'd0-synthetic-fixture-v1' : '3.1.40.205461');
        assert.ok(!JSON.stringify(data).includes('cloudmusic.exe'));
      }
      assert.equal(factories, 0); assert.deepEqual(backend.calls, []);
      for (const body of [ {}, { desktopTarget: target }, { scenarioId },
        { desktopTarget: target, scenarioId: false }, { desktopTarget: target, scenarioId: [scenarioId] },
        { desktopTarget: target, scenarioId, budget: { deepseek: { maxCalls: 0 } } },
        { desktopTarget: target, scenarioId: 'arbitrary-local-workspace' },
        { desktopTarget: target, scenarioId: 'packaged-notepad' },
        { desktopTarget: target, scenarioId: 'raw-isolated-input' },
        { desktopTarget: target, scenarioId: app === 'fixture' ? 'd0-netease-fixed-track-v1' : 'd0-fixture-text-click-v1' },
        { desktopTarget: { ...target, environmentId: 'local-workspace:other' }, scenarioId },
        { desktopTarget: { ...target, providerId: 'windows-physical' }, scenarioId },
        { desktopTarget: { ...target, instanceId: 'forged' }, scenarioId },
        ...['goal', 'admin', 'criteria', 'constraints', 'destination', 'applicationVersion', 'action'].map(key => ({ desktopTarget: target, scenarioId, [key]: 'widen' }))
      ]) assert.equal((await post(body)).status, 400, JSON.stringify(body));
      assert.equal((await post({ desktopTarget: target, scenarioId }, undefined, { Origin: 'https://evil.example' })).status, 403);
      assert.equal((await post({ desktopTarget: target, scenarioId }, undefined, { 'Content-Type': 'text/plain' })).status, 415);
      assert.equal((await post({ goal: 'arbitrary', desktopTarget: target }, '/api/tasks')).status, 400);
      assert.equal((await post({ goal: 'ignored?', desktopTarget: target, scenarioId }, '/api/tasks')).status, 400);
      assert.equal(factories, 0); assert.equal(backend.acts, 0);
      const response = await post({ desktopTarget: target, scenarioId }); assert.equal(response.status, 202);
      const { taskId } = await response.json();
      const trace = new SqliteTrace(join(directory, 'web-tasks.sqlite'));
      try {
        for (let n = 0; n < 200 && trace.load(taskId)?.status !== 'done'; n++) await new Promise(done => setTimeout(done, 10));
        const state = trace.load(taskId)!; assert.equal(state.status, 'done');
        assert.deepEqual(state.desktopTarget, target); assert.equal(state.desktopScenario, scenarioId);
        assert.equal(backend.acts, 1); assert.equal(factories, 1);
        assert.equal((await post({}, `/api/tasks/${taskId}/continue`)).status, 400);
        assert.equal(backend.acts, 1);
        const detail = await (await fetch(`${base}/api/runs/web-tasks.sqlite/${taskId}`)).json();
        assert.equal(detail.desktopScenario, scenarioId);
      } finally { trace.close(); }
    } finally {
      await new Promise<void>(done => server.close(() => done())); await assembly.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
