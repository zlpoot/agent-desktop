import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { StageWorkflowModel } from '../src/agent/stage-workflow-model.js';
import type { TraceStore } from '../src/contracts/stores.js';
import { initialState } from '../src/graph/state.js';
import { readWorkflowVersion } from '../src/app/workflow-view.js';
import { stageReplaySucceeded } from '../src/workflows/execution.js';
import { distillWorkflow } from '../src/workflows/distill.js';
import { instantiateWorkflow, matchWorkflow } from '../src/workflows/matcher.js';
import { workflowDigest } from '../src/workflows/recovery.js';
import type { Workflow } from '../src/workflows/schema.js';
import { WorkflowStore } from '../src/workflows/store.js';

const candidate: Workflow = {
  id: 'stage-example', version: 1, status: 'candidate', scope: 'stage',
  environment: 'windows', taskPattern: '输入 {{input1}}', stageCondition: '字段为样本',
  inputs: [{ name: 'input1', example: '样本' }], preconditions: [],
  steps: [{ goal: '输入 {{input1}}', action: { kind: 'type',
    target: { kind: 'role', role: 'Edit', name: '内容' }, text: '{{input1}}' },
    preferredMethods: ['accessibility'], successCondition: { kind: 'accessibility_includes', value: '{{input1}}' } }],
  successConditions: {}, knownFailures: [], sourceTaskId: 'source', sourceTrace: 'source.sqlite',
  createdAt: '', successCount: 0, failureCount: 0,
};

test('阶段候选的完成条件随参数展开，避免回放时显示来源样本', () => {
  const before = { windowTitle: '编辑器', pageText: '' };
  const after = { windowTitle: '编辑器', pageText: '字段为样本', accessibility: '样本' };
  const base = initialState('source', '输入 样本');
  const executed = { ...base, step: 1, lastAction: { kind: 'type' as const,
    target: { kind: 'role' as const, role: 'Edit', name: '内容' }, text: '样本' },
    lastResult: { ok: true, message: '已输入' }, beforeObservation: before };
  const trace = { load: () => base, metrics: () => [{ node: 'decide', actor: 'model', step: 1 }],
    events: () => [
      { node: 'execute', step: 1, state: executed },
      { node: 'observe', step: 1, state: { ...executed, observation: after } },
      { node: 'verify', step: 1, state: { ...executed, lastVerification: { ok: true } } },
    ] } as unknown as TraceStore;
  const proposed = distillWorkflow(trace, 'source', 'source.sqlite', 'windows', {
    goal: '输入 样本', successCondition: '字段为样本', startStep: 0, endStep: 1 });
  assert.equal(proposed?.stageCondition, '字段为{{input1}}');
  const match = matchWorkflow(proposed!, '输入 新值', true)!;
  assert.equal(instantiateWorkflow(match).stageCondition, '字段为新值');
});

test('不同参数的相似阶段优先试回放候选，不调用探索模型', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-stage-parameter-'));
  const store = new WorkflowStore(join(dir, 'workflows.sqlite'));
  try {
    const saved = store.addCandidate({ ...candidate, stageCondition: '字段为{{input1}}' });
    let explored = 0;
    const model = new StageWorkflowModel({ async decide() {
      explored++;
      throw new Error('候选已匹配，不应探索');
    } }, store);
    const state = { ...initialState('task-new', '输入 新值'),
      stage: { id: 'task-new:1', goal: '输入 新值', successCondition: '字段为新值',
        startedAtStep: 0, actionCount: 0, planVersion: 1, isFinal: false },
      observation: { windowTitle: '编辑器', accessibility: '空' } };
    const action = await model.decide(state);
    assert.equal(action.kind, 'type');
    if (action.kind === 'type') assert.equal(action.text, '新值');
    assert.equal(model.currentWorkflowRef()?.id, saved.id);
    assert.equal(model.currentWorkflowRef()?.values.input1, '新值');
    assert.equal(explored, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('首个最终阶段改写措辞时用冻结的原始目标匹配，VM 路由前缀不影响阶段候选', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-stage-original-goal-'));
  const store = new WorkflowStore(join(dir, 'workflows.sqlite'));
  try {
    const saved = store.addCandidate({ ...candidate,
      taskPattern: '把客户字段改为 {{input1}} 并保存' });
    let explored = 0;
    const model = new StageWorkflowModel({ async decide() {
      explored++;
      return { kind: 'done' as const, summary: '未匹配' };
    } }, store);
    const state = { ...initialState('task-original', 'VM: 把客户字段改为 新值 并保存'),
      taskContract: { target: 'VM: 把客户字段改为 新值 并保存', constraint: '',
        stageActionLimit: 24, taskActionLimit: 80 },
      stage: { id: 'task-original:1', goal: '更新当前客户字段并提交',
        successCondition: '字段已更新', startedAtStep: 0, actionCount: 0,
        planVersion: 1, isFinal: true },
      observation: { windowTitle: '编辑器', accessibility: '空' } };
    const action = await model.decide(state);
    assert.equal(action.kind, 'type');
    if (action.kind === 'type') assert.equal(action.text, '新值');
    assert.equal(model.currentWorkflowRef()?.id, saved.id);
    assert.equal(explored, 0);

    const later = new StageWorkflowModel({ async decide() {
      explored++;
      return { kind: 'done' as const, summary: '未匹配' };
    } }, store);
    await later.decide({ ...state, stage: { ...state.stage, id: 'task-original:2',
      startedAtStep: 1 } });
    assert.equal(later.currentWorkflowRef(), undefined);
    assert.equal(explored, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('阶段画面提前满足时不晋级未走完的流程；末步语义验收后才晋级', () => {
  const workflow: Workflow = { ...candidate, stageCondition: '字段为{{input1}}', steps: [
    candidate.steps[0],
    { goal: '保存', action: { kind: 'click', target: { kind: 'role', role: 'Button', name: '保存' } },
      preferredMethods: ['accessibility'], successCondition: { kind: 'text_includes', value: '已保存' } },
  ] };
  const base = { ...initialState('task-1', '输入 新值'),
    workflowRef: { id: workflow.id, version: 1, values: { input1: '新值' }, stageId: 'task-1:1' },
    lastStageVerification: { ok: true, confidence: 1, evidence: '字段为新值', source: 'uia' as const },
    lastResult: { ok: true, message: '已执行' }, lastVerification: { ok: true, message: '通过' },
    beforeObservation: { pageText: '字段为新值' },
    observation: { pageText: '字段为新值 已保存' } };
  assert.equal(stageReplaySucceeded({ ...base,
    workflowReplayState: { nextIndex: 1, activeIndex: 0, exploring: false } }, workflow), false);
  assert.equal(stageReplaySucceeded({ ...base, observation: { pageText: '字段为新值' },
    workflowReplayState: { nextIndex: 2, activeIndex: 1, exploring: false } }, workflow), false);
  assert.equal(stageReplaySucceeded({ ...base,
    workflowReplayState: { nextIndex: 2, activeIndex: 1, exploring: false } }, workflow), true);
  assert.equal(stageReplaySucceeded({ ...base,
    workflowReplayState: { nextIndex: 2, activeIndex: 1, exploring: true } }, workflow), false);
});

test('阶段回放按任务和阶段去重，同一任务的另一阶段单独记账', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-stage-record-'));
  const store = new WorkflowStore(join(dir, 'workflows.sqlite'));
  try {
    const saved = store.addCandidate(candidate);
    const hash = workflowDigest(saved);
    const first = store.recordReplay(saved.id, 1, 'task-1', true, undefined, hash, 'automatic', 'task-1:1');
    assert.equal(first.status, 'verified');
    assert.equal(store.recordReplay(saved.id, 1, 'task-1', false, '重复完成', hash,
      'automatic', 'task-1:1').successCount, 1);
    assert.equal(store.get(saved.id, 1)?.failureCount, 0);
    store.recordReplay(saved.id, 1, 'task-1', true, undefined, hash, 'automatic', 'task-1:2');
    assert.equal(store.get(saved.id, 1)?.successCount, 2);
    const detail = readWorkflowVersion(dir, saved.id, 1)!;
    assert.deepEqual((detail.runs as Array<{ stageId: string }>).map((run) => run.stageId),
      ['task-1:2', 'task-1:1']);
    assert.throws(() => store.recordReplay(saved.id, 1, 'task-2', true,
      undefined, 'stale', 'automatic', 'task-2:1'), /定义已改变/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('旧 workflow_runs 表迁移后保留任务记录，并对旧记录去重', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-stage-migrate-'));
  const path = join(dir, 'workflows.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE workflow_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, version INTEGER NOT NULL,
    task_id TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL
  )`);
  legacy.prepare(`INSERT INTO workflow_runs
    (workflow_id,version,task_id,outcome,reason,created_at) VALUES (?,?,?,?,?,?)`)
    .run(candidate.id, 1, 'legacy-task', 'success', null, '2026-01-01T00:00:00Z');
  legacy.close();
  const store = new WorkflowStore(path);
  try {
    store.addCandidate(candidate);
    const result = store.recordReplay(candidate.id, 1, 'legacy-task', true);
    assert.equal(result.successCount, 0, '旧记录不得被重新计数');
    assert.equal((readWorkflowVersion(dir, candidate.id, 1)!.runs as Array<{ stageId: string }>)[0].stageId, '');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
