import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DesktopTaskController } from '../src/app/task-runner.js';
import { SqliteTrace } from '../src/trace/sqlite-trace.js';
import { WorkflowStore } from '../src/workflows/store.js';
import { recoverDesktopTasks } from '../src/desktop-session/recovery.js';
import { singleProvider } from '../src/actions/action-resolution.js';
import { meteredModelRequest, readTaskBudget } from '../src/runtime/model-budget.js';
import { WorkerConnectionError } from '../src/contracts/worker-error.js';
import type { PlanningModel } from '../src/contracts/model-provider.js';
import type { WorkerClient } from '../src/contracts/worker-client.js';
import type { Workflow } from '../src/workflows/schema.js';

for (const parameter of ['alpha', 'beta']) test(`TaskRunner VM 三阶段 Host 重启及 Guest 断线恢复并固定原版本：${parameter}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-controller-'));
  mkdirSync(join(dir, 'config')); writeFileSync(join(dir, 'config/agent-desktop-apps.json'), '[]');
  let page = 'start', pauseSecond = true, pauseThird = true, failAfterB = false;
  let windowHandle = 1, processId = 100, semanticRebinds = 0;
  const actions: string[] = [];
  const store = new WorkflowStore(join(dir, 'workflows.sqlite'));
  const definition: Workflow = { id: 'second', version: 1, status: 'candidate', scope: 'stage', environment: 'windows',
    taskPattern: 'second {{value}}', inputs: [{ name: 'value', example: parameter }], preconditions: [],
    steps: [{ goal: 'complete', action: { kind: 'keypress', keys: 'b' }, preferredMethods: [],
      successCondition: { kind: 'text_includes', value: 'second done' } }],
    successConditions: { pageTextIncludes: '{{value}} done' }, knownFailures: [], sourceTaskId: 'seed',
    sourceTrace: 'seed', createdAt: '', successCount: 0, failureCount: 0 };
  store.addCandidate(definition);
  const model = {
    async planTask(goal: string) { return { task: { environment: 'windows', windowHandle: 1,
      plan: ['first', 'second'], completionCriteria: { pageTextIncludes: `${parameter} done` },
      verificationContract:{goal,successConditions:{pageTextIncludes:`${parameter} done`},
        evidenceSources:{pageTextIncludes:'uia'},verifierStrategy:'rules_then_jev'} } }; },
    async planStage(state) {
      await meteredModelRequest('deepseek', async () => ({ usage: { total_tokens: 7 } }));
      const completed = state.completedStages?.length ?? 0;
      return completed === 0 ? { goal: 'first', successCondition: 'first done', isFinal: false }
        : completed === 1 ? { goal: `second ${parameter}`, successCondition: 'second done', isFinal: false }
        : { goal: `third ${parameter}`, successCondition: `${parameter} done`, isFinal: true };
    },
    async verifyStage(stage, observation) { const ok = observation.accessibility?.includes(stage.successCondition) ?? false;
      return { ok, confidence: 1, evidence: observation.accessibility ?? '', source: 'uia' }; },
    async decide(state) {
      await meteredModelRequest('deepseek', async () => ({ usage: { total_tokens: 11 } }));
      return { kind: 'keypress', keys: state.stage?.goal === 'first' ? 'a' : 'c' };
    },
    async transcribeScreenshot() { return { text: page }; },
    async locateVisualTarget() { throw new Error('unexpected visual targeting'); },
    takeVisualUsage() { return undefined; },
  } as PlanningModel;
  const worker = { async listWindows() { return []; }, async attach(options) {
      if (options.windowHandle !== undefined) assert.equal(options.windowHandle, windowHandle);
      else {
        assert.equal(options.windowTitle, 'fixture');
        assert.equal(options.windowClass, undefined);
        assert.equal(options.processPath, 'C:\\Fixture\\fixture.exe');
        semanticRebinds++;
      }
    },
    async ensureApp() { throw new Error('unexpected launch'); }, async recoverFocus() {}, async restore() {},
    async observe() {
      if (failAfterB && page === 'second done') {
        failAfterB = false; throw new WorkerConnectionError('Guest Worker restarted after dispatch');
      }
      return { pageText: page, accessibility: page, windowTitle: 'fixture', windowHandle };
    },
    async probe() { return { windowClass: `Fixture-${processId}`,
      processId, processPath: 'C:\\Fixture\\fixture.exe', permissionsCompatible: true,
      elevated: false, targetElevated: false, visible: true, minimized: false, rect: { left: 0, top: 0, width: 100, height: 100 },
      foreground: true, uiaControls: true, title: 'fixture' }; },
    async ground(action) { return { action, attempts: [] }; },
    async resolveAction() { return singleProvider('fixture', 'test'); },
    async execute(action) { assert.equal(action.kind, 'keypress'); if (action.kind !== 'keypress') throw Error('action');
      actions.push(action.keys); page = action.keys === 'a' ? 'first done'
        : action.keys === 'b' ? 'second done' : `${parameter} done`;
      return { ok: true, message: 'changed', effect: 'dispatched' }; },
    async close() {},
  } as WorkerClient;
  const options = { modelProvider: { createModel: () => model }, workerClientFactory: async () => worker,
    traceStore: (path: string) => { const trace = new SqliteTrace(path); const save = trace.save.bind(trace);
      trace.save = (node, state) => { save(node, state);
        if (pauseSecond && node === 'resolve_action' && state.workflowRef?.id === 'second') {
          pauseSecond = false; trace.requestPause(state.taskId);
        } else if (pauseThird && node === 'resolve_action' && state.stage?.goal === `third ${parameter}`) {
          pauseThird = false; trace.requestPause(state.taskId);
        } };
      return trace; } };
  let controller = new DesktopTaskController(dir, options);
  const trace = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
  async function wait(id: string, status: string) {
    // 上限 30s：全量并行时 CPU/IO 争抢会显著拉长恢复流程，10s 偶发耗尽。
    const end = Date.now() + 30000;
    while (Date.now() < end) { if (trace.load(id)?.status === status) return; await new Promise(r => setTimeout(r, 20)); }
    assert.fail(JSON.stringify(trace.load(id)));
  }
  try {
    const id = controller.submit(`VM: test ${parameter}`);
    await wait(id, 'paused'); await controller.close();
    assert.deepEqual(actions, ['a']); assert.equal(trace.load(id)?.completedStages?.length, 1);
    assert.equal(trace.load(id)?.workflowRef?.version, 1);
    const usageAfterA = readTaskBudget(dir, id)!.usage.deepseek;
    assert.ok(usageAfterA.calls > 0 && usageAfterA.tokens > 0);
    store.addCandidate({ ...definition, steps: [{ ...definition.steps[0], action: { kind: 'keypress', keys: 'wrong-new-version' } }] });
    if (parameter === 'alpha') failAfterB = true;
    windowHandle++; processId++;
    recoverDesktopTasks(dir);
    controller = new DesktopTaskController(dir, options); controller.continue(id);
    await wait(id, 'paused'); await controller.close();
    if (parameter === 'alpha') {
      assert.equal(trace.load(id)?.verificationPending, true);
      assert.equal(trace.load(id)?.recoveryRequired, true);
      windowHandle++; processId++;
      recoverDesktopTasks(dir);
      controller = new DesktopTaskController(dir, options); controller.continue(id);
      await wait(id, 'paused'); await controller.close();
    }
    assert.deepEqual(actions, ['a', 'b']); assert.equal(trace.load(id)?.completedStages?.length, 2);
    assert.equal(trace.load(id)?.completedStages?.[1]?.workflowVersion, 1);
    const firstThread = trace.load(id)?.checkpointThreadId;
    const firstLineage = trace.load(id)?.checkpointLineage;
    assert.equal(firstLineage?.length, parameter === 'alpha' ? 2 : 1);
    assert.equal(firstLineage[0].from, id);
    assert.equal(firstLineage.at(-1)?.to, firstThread);
    for (let i = 1; i < firstLineage.length; i++) assert.equal(firstLineage[i].from, firstLineage[i - 1].to);
    const usageAfterB = readTaskBudget(dir, id)!.usage.deepseek;
    assert.ok(usageAfterB.calls >= usageAfterA.calls && usageAfterB.tokens >= usageAfterA.tokens);
    assert.equal(trace.load(id)?.desktopBinding?.windowHandle, windowHandle);
    windowHandle++; processId++;
    recoverDesktopTasks(dir);
    controller = new DesktopTaskController(dir, options); controller.continue(id);
    await wait(id, 'done'); await controller.close();
    assert.deepEqual(actions, ['a', 'b', 'c']); assert.equal(trace.load(id)?.completedStages?.length, 3);
    assert.equal(trace.load(id)?.desktopBinding?.windowHandle, windowHandle);
    assert.equal(semanticRebinds, parameter === 'alpha' ? 3 : 2);
    assert.equal(trace.load(id)?.goalVerification?.ok, true);
    assert.ok(trace.load(id)?.completedStages?.every(stage => !!stage.evidence));
    const lineage = trace.load(id)?.checkpointLineage;
    assert.equal(lineage?.length, firstLineage.length + 1);
    assert.equal(lineage.at(-1)?.from, firstThread);
    assert.equal(lineage.at(-1)?.to, trace.load(id)?.checkpointThreadId);
    const usageAfterC = readTaskBudget(dir, id)!.usage.deepseek;
    assert.ok(usageAfterC.calls > usageAfterB.calls && usageAfterC.tokens > usageAfterB.tokens);
    const events = trace.events(id);
    const restarts = events.flatMap((event, index) => event.node === 'restart_reobserve' ? [index] : []);
    assert.equal(restarts.length, lineage.length);
    for (const [index, start] of restarts.entries()) {
      const resumed = events.slice(start, restarts[index + 1] ?? events.length).map(event => event.node);
      assert.ok(resumed.indexOf('observe') > 0, JSON.stringify({ index, resumed }));
      if (resumed.includes('execute')) assert.ok(resumed.indexOf('observe') < resumed.indexOf('execute'));
      if (index < restarts.length - 1) {
        assert.ok(resumed.indexOf('observe') < resumed.indexOf('workflow_recovery'));
        if (resumed.includes('execute')) assert.ok(resumed.indexOf('workflow_recovery') < resumed.indexOf('execute'));
      } else {
        assert.ok(resumed.indexOf('observe') < resumed.indexOf('stage_check'));
        assert.ok(resumed.indexOf('stage_check') < resumed.indexOf('execute'));
      }
    }
    assert.equal(trace.load(id)?.completedStages?.[1]?.workflowVersion, 1);
    assert.equal(trace.load(id)?.workflowRef, undefined);
  } finally { await controller.close(); trace.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
