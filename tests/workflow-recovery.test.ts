import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialState } from '../src/graph/state.js';
import { reconcileWorkflow, workflowDigest } from '../src/workflows/recovery.js';
import type { Workflow } from '../src/workflows/schema.js';
import { MemorySaver } from '@langchain/langgraph';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteTrace } from '../src/trace/sqlite-trace.js';
import { restartedDesktopState } from '../src/desktop-session/recovery.js';
import { createAgentLoop } from '../src/graph/graph.js';
import { StageWorkflowModel } from '../src/agent/stage-workflow-model.js';
import { WorkflowStore } from '../src/workflows/store.js';
import { FakeModel } from '../src/agent/model-adapter.js';
import { WorkflowReplayModel } from '../src/workflows/replay-model.js';

export const workflow: Workflow = { id: 'test', version: 1, status: 'verified', environment: 'windows',
  taskPattern: 'test {{value}}', inputs: [{ name: 'value', example: 'A' }], preconditions: [],
  steps: [{ goal: 'write', action: { kind: 'keypress', keys: 'space' }, preferredMethods: [],
    successCondition: { kind: 'text_includes', value: '{{value}}' } }], successConditions: { pageTextIncludes: '{{value}}' },
  knownFailures: [], sourceTaskId: 'origin', sourceTrace: 'trace', createdAt: '', successCount: 1, failureCount: 0 };

test('恢复契约固定原定义，以新观察核对未决结果', () => {
  for (const value of ['A', 'B']) {
    const state = { ...initialState('t', 'test'), workflowRef: { id: 'test', version: 1, values: { value }, definitionHash: workflowDigest(workflow) },
      workflowReplayState: { nextIndex: 1, activeIndex: 0, exploring: false }, inFlightAction: workflow.steps[0].action,
      recoveryUncertain: true, observation: { pageText: value } };
    assert.equal(reconcileWorkflow(state, workflow).decision, 'confirmed');
    assert.equal(reconcileWorkflow({ ...state, observation: { pageText: '' } }, workflow).decision, 'blocked');
    assert.equal(reconcileWorkflow(state, { ...workflow, version: 2 }).decision, 'blocked');
    assert.equal(reconcileWorkflow(state, { ...workflow, status: 'retired' }).decision, 'blocked');
    assert.equal(reconcileWorkflow({ ...state, workflowRef: { ...state.workflowRef, definitionHash: undefined } }, workflow).decision, 'blocked');
    assert.equal(reconcileWorkflow(state, { ...workflow, steps: [] }).decision, 'blocked');
  }
});

test('画面变化或幂等标记不能证明未知副作用已完成', () => {
  const weak: Workflow = { ...workflow, steps: [{ ...workflow.steps[0], idempotent: true, successCondition: { kind: 'state_changed' } }] };
  const state = { ...initialState('t', 'test'), workflowRef: { id: 'test', version: 1, values: {}, definitionHash: workflowDigest(weak) },
    workflowReplayState: { nextIndex: 1, activeIndex: 0, exploring: false }, recoveryUncertain: true, observation: { pageText: 'changed' } };
  assert.equal(reconcileWorkflow(state, weak).decision, 'blocked');
});

test('完整的新 UIA 观察可重做唯一 Edit 字段替换，但不能重放未知动作', async () => {
  const edit: Workflow = { ...workflow, steps: [{ goal: 'replace field',
    action: { kind: 'type', target: { kind: 'role', role: 'Edit', name: 'Field' }, text: 'new' },
    preferredMethods: [], successCondition: { kind: 'text_includes', value: 'new' } }] };
  const control = { role: 'Edit', name: 'Field', value: 'old', nameComplete: true,
    valueComplete: true, enabled: true, visible: true };
  const observation = { pageText: 'Field old', dom: JSON.stringify([control]),
    capture: { epoch: 'fresh', sequence: 1, object: 'window:fresh:42',
      startedAt: 10, finishedAt: 11, clock: 'collector' as const, atomic: false as const,
      enumerationComplete: true, fields: { dom: { complete: true, source: 'uia' as const } } } };
  const state = { ...initialState('t', 'test'),
    workflowRef: { id: edit.id, version: edit.version, values: { value: 'new' }, definitionHash: workflowDigest(edit) },
    workflowReplayState: { nextIndex: 1, exploring: false }, observation };
  const decision = reconcileWorkflow(state, edit);
  assert.equal(decision.decision, 'continue');
  assert.equal(decision.replay?.nextIndex, 0);
  assert.equal(decision.replay?.activeIndex, undefined);
  const replay = new WorkflowReplayModel(edit, new FakeModel([]));
  replay.restoreState(decision.replay!);
  assert.deepEqual(await replay.decide(state), edit.steps[0].action);
  assert.equal(reconcileWorkflow({ ...state, recoveryUncertain: true }, edit).decision, 'blocked');
  assert.equal(reconcileWorkflow({ ...state, inFlightAction: edit.steps[0].action }, edit).decision, 'blocked');
  assert.equal(reconcileWorkflow({ ...state, observation: { ...observation,
    dom: JSON.stringify([control, { ...control, valueComplete: false }]) } }, edit).decision, 'blocked');
  assert.equal(reconcileWorkflow({ ...state, observation: { ...observation,
    capture: { ...observation.capture, enumerationComplete: false } } }, edit).decision, 'blocked');
  assert.equal(reconcileWorkflow({ ...state, observation: { ...observation,
    capture: { ...observation.capture, fields: { dom: { complete: true, source: 'dom' as const } } } } }, edit).decision, 'blocked');
  assert.equal(reconcileWorkflow({ ...state, observation: { ...observation,
    dom: JSON.stringify([{ ...control, value: 'new' }]), pageText: 'Field new' } }, edit).decision, 'continue');
  const click: Workflow = { ...edit, steps: [{ ...edit.steps[0],
    action: { kind: 'click', target: { kind: 'role', role: 'Button', name: 'Save' } } }] };
  assert.equal(reconcileWorkflow({ ...state, workflowRef: { ...state.workflowRef,
    definitionHash: workflowDigest(click) } }, click).decision, 'blocked');
});

test('缺少前帧的 state_changed 不能让回放器跳过步骤', async () => {
  const weak: Workflow = { ...workflow, steps: [{ ...workflow.steps[0], idempotent: true, successCondition: { kind: 'state_changed' } }] };
  const model = new WorkflowReplayModel(weak, new FakeModel([]));
  const action = await model.decide({ ...initialState('t', 'test'), observation: { pageText: 'unrelated' } });
  assert.deepEqual(action, weak.steps[0].action);
});

for (const applied of [true, false]) test(`阶段未决动作恢复 ${applied ? '已生效' : '证据不足'}：重复恢复不重复输入`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-uncertain-'));
  const trace = new SqliteTrace(join(dir, 'trace.sqlite')); let executions = 0;
  try {
    const state = { ...initialState('t', 'VM: test', undefined, { pageTextIncludes: 'A' }),
      taskContract: { target: 'A', constraint: '', stageActionLimit: 5, taskActionLimit: 10 },
      stage: { id: 's', goal: 'A', successCondition: 'A', isFinal: true, startedAtStep: 0, actionCount: 1, planVersion: 1 },
      workflowRef: { id: 'test', version: 1, values: { value: 'A' }, stageId: 's', definitionHash: workflowDigest(workflow) },
      workflowReplayState: { nextIndex: 1, activeIndex: 0, exploring: false },
      inFlightAction: workflow.steps[0].action, recoveryRequired: true };
    trace.save('dispatch_pending', state);
    const graph = createAgentLoop({ trace, checkpointer: new MemorySaver(),
      workflowRecovery: s => reconcileWorkflow(s, workflow),
      model: { async decide() { throw Error('must not decide'); },
        async verifyStage() { return { ok: true, evidence: 'A', source: 'uia', confidence: 1 }; } },
      runtime: { async observe() { return { pageText: applied ? 'A' : '' }; },
        async execute() { executions++; throw Error('must not execute'); } } });
    for (let i = 0; i < (applied ? 1 : 2); i++) {
      const recovered = restartedDesktopState(trace.load('t')!);
      await graph.invoke(recovered, { configurable: { thread_id: recovered.checkpointThreadId } });
      assert.equal(trace.load('t')?.status, applied ? 'done' : 'paused');
      assert.equal(executions, 0);
    }
  } finally { trace.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('阶段原版本缺失时反复 select 也不能退回探索或最新版本', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-missing-')); const store = new WorkflowStore(join(dir, 'store.sqlite'));
  try {
    const model = new StageWorkflowModel(new FakeModel([{ kind: 'keypress', keys: 'bad' }]), store);
    const state = { ...initialState('t', 'test'),
      stage: { id: 's', goal: 'test', successCondition: 'done', isFinal: true, startedAtStep: 0, actionCount: 1, planVersion: 1 },
      workflowRef: { id: 'absent', version: 1, values: {}, stageId: 's' } };
    await assert.rejects(model.decide(state), /不能重新匹配/);
    await assert.rejects(model.decide(state), /不能重新匹配/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const pause of [true, false]) test(`阶段边界${pause ? '暂停先于规划' : '规划失败保留恢复状态'}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stage-boundary-')); const trace = new SqliteTrace(join(dir, 'trace.sqlite'));
  let plans = 0;
  try {
    const state = { ...initialState('t', 'test'),
      taskContract: { target: 'test', constraint: '', stageActionLimit: 5, taskActionLimit: 10 } };
    const result = await createAgentLoop({ trace, checkpointer: new MemorySaver(),
      // The request arrives after pause_check, at the stage boundary itself.
      pauseRequested: () => false,
      model: { async decide() { throw Error('must not execute'); },
        async planStage() { plans++; throw Error('invalid plan'); } },
      runtime: { async observe() { return {}; }, async execute() { throw Error('must not execute'); } },
      ...(pause ? { pauseRequested: (() => { let count = 0; return () => ++count >= 2; })() } : {}),
    }).invoke(state, { configurable: { thread_id: 't' } });
    assert.equal(result.status, 'paused'); assert.equal(plans, pause ? 0 : 1);
    if (!pause) assert.equal(result.recoveryRequired, true);
  } finally { trace.close(); rmSync(dir, { recursive: true, force: true }); }
});
