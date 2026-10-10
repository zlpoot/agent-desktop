import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDashboardServer } from '../src/app/server.js';
import { DesktopTaskController } from '../src/app/task-runner.js';
import { createDefaultExtensionRegistry } from '../src/extensions/index.js';
import type { PlanningModel } from '../src/contracts/model-provider.js';
import { fixtureDesktopSessions } from './fixtures/task-desktop.js';
import { SqliteTrace } from '../src/trace/sqlite-trace.js';

test('explicit HTTP Browser entry persists generic routing, selects Browser planning and blocks a Windows plan before any Runtime or input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'b-browser-routing-'));
  const modelOptions: unknown[] = [], goals: string[] = [];
  const controller = new DesktopTaskController(dir, {
    registry: createDefaultExtensionRegistry({ rootDir: dir }),
    desktopSessions: fixtureDesktopSessions(async () => { assert.fail('no desktop Runtime'); }),
    modelProvider: { createModel(options) {
      modelOptions.push(options);
      return { name: 'FakeBrowserPlanner', kind: 'rule', async planTask(goal: string) {
        goals.push(goal);
        if (goal === 'ordinary synthetic Browser task') throw Error('SYNTHETIC_BROWSER_PREPARED');
        return { task: { environment: 'windows', plan: [], completionCriteria: {} } };
      }, async decide() { assert.fail('no Agent Loop'); } } as unknown as PlanningModel;
    } },
  });
  const server = createDashboardServer(dir, controller);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('port');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const [goal, expectedError] of [['打开网易云播放稻香', 'browser-plan-environment-mismatch'],
      ['ordinary synthetic Browser task', 'SYNTHETIC_BROWSER_PREPARED']]) {
      const response = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destination: 'browser', goal }) });
      assert.equal(response.status, 202, 'explicit Browser must bypass the legacy specialized Windows route');
      const { taskId, source } = await response.json(); assert.equal(source, 'web-tasks.sqlite');
      const trace = new SqliteTrace(join(dir, source));
      try {
        const until = Date.now() + 5000;
        while (trace.load(taskId)?.status !== 'failed' && Date.now() < until) await new Promise(done => setTimeout(done, 10));
        assert.equal(trace.load(taskId)?.status, 'failed'); assert.equal(trace.load(taskId)?.error, `Error: ${expectedError}`);
        assert.equal(trace.load(taskId)?.desktopTarget, undefined); assert.equal(trace.load(taskId)?.desktopExecutionBinding, undefined);
      } finally { trace.close(); }
      const db = new DatabaseSync(join(dir, 'web-task-routes.sqlite'), { readOnly: true });
      try { assert.equal(db.prepare('SELECT environment FROM generic_routes WHERE task_id=?').get(taskId)?.environment, 'browser'); } finally { db.close(); }
      const history = await (await fetch(`${base}/api/runs/${source}/${taskId}`)).json();
      assert.equal(history.taskId, taskId); assert.equal(history.goal, goal); assert.equal(history.desktopTarget, undefined);
    }
    assert.deepEqual(goals, ['打开网易云播放稻香', 'ordinary synthetic Browser task']);
    assert.deepEqual(modelOptions, [{ environment: 'browser', visualMode: false }, { environment: 'browser', visualMode: false }]);
    assert.throws(() => controller.submit('synthetic', { destination: 'browser', admin: true }), /通用任务暂不支持/);
    assert.throws(() => controller.submit('synthetic', { destination: 'browser', desktopTarget: { providerId: 'fixture', environmentId: 'fixture' } }), /desktop-target-destination-conflict/);
  } finally { await new Promise<void>(done => server.close(() => done())); await controller.close(); rmSync(dir, { recursive: true, force: true }); }
});
