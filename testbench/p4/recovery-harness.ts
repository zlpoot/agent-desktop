import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRootAssembly } from '../../src/composition/root.js';
import { mountSessionScope } from '../../src/composition/session-scope.js';
import { WorkflowStore } from '../../src/workflows/store.js';
import { SqliteTrace } from '../../src/trace/sqlite-trace.js';
import { meteredModelRequest, readTaskBudget } from '../../src/runtime/model-budget.js';
import type { PlanningModel } from '../../src/contracts/model-provider.js';
import type { ComputerState } from '../../src/graph/state.js';

const phase = process.argv[2];
if (!['first', 'resume'].includes(phase)) throw new Error('phase first|resume required');
const caseDir = process.argv[3];
const targetPhone = process.argv[4];
if (!caseDir || !/^1\d{10}$/.test(targetPhone ?? ''))
  throw new Error('Usage: recovery-harness.ts first|resume <unique-case-dir> <11-digit-phone>');
const vmId = process.env.AGENT_DESKTOP_VM_ID;
const token = process.env.AGENT_DESKTOP_TOKEN;
const endpoint = process.env.AGENT_DESKTOP_WORKER_URL;
if (!vmId || !token || !endpoint) throw new Error('Guest connection environment missing');
const rootDir = resolve(caseDir);
mkdirSync(resolve(rootDir, 'config'), { recursive: true });
if (!existsSync(resolve(rootDir, 'config/agent-desktop-apps.json')))
  writeFileSync(resolve(rootDir, 'config/agent-desktop-apps.json'), '[]');
if (phase === 'first' && existsSync(resolve(rootDir, 'task-id.txt')))
  throw new Error('Case directory has a task already; use a fresh case directory');
const criteria = { pageTextIncludes: '客户资料已保存',
  structuredStates: [{ target: { role: 'Edit', name: '手机号' }, field: 'value' as const, equals: targetPhone }] };
const model = {
  name: 'P4 deterministic live fixture', kind: 'model' as const,
  async planTask(goal: string, windows: readonly { handle: number; title: string }[] = []) {
    const matching = windows.filter(window => window.title === 'Windows Agent TestBench - 仓库与订单管理');
    if (matching.length !== 1) throw new Error(`Expected one TestBench window, found ${matching.length}`);
    return { task: { environment: 'windows' as const, windowHandle: matching[0].handle,
      plan: ['打开客户资料', '保存手机号', '核对结果'], completionCriteria: criteria,
      verificationContract: { goal, successConditions: criteria,
        evidenceSources: { pageTextIncludes: 'uia', structuredStates: 'uia' },
        verifierStrategy: 'rules_then_jev' as const } } };
  },
  async planStage(state: Readonly<ComputerState>) {
    await meteredModelRequest('deepseek', async () => ({ usage: { total_tokens: 7 } }));
    const done = state.completedStages?.length ?? 0;
    return done === 0 ? { goal: '打开张三资料', successCondition: '客户资料 · 张三', isFinal: false }
      : done === 1 ? { goal: `保存手机号 ${targetPhone}`, successCondition: '客户资料已保存', isFinal: false }
      : { goal: '核对当前客户资料最终状态', successCondition: targetPhone, isFinal: true };
  },
  async verifyStage(stage: NonNullable<ComputerState['stage']>, observation: NonNullable<ComputerState['observation']>) {
    const ok = observation.accessibility?.includes(stage.successCondition) ?? false;
    return { ok, confidence: 1, evidence: observation.accessibility ?? '', source: 'uia' as const };
  },
  async decide(state: Readonly<ComputerState>) {
    await meteredModelRequest('deepseek', async () => ({ usage: { total_tokens: 11 } }));
    if (state.stage?.goal === '打开张三资料')
      return { kind: 'click' as const, target: { kind: 'role' as const, role: 'Button', name: '打开张三资料' } };
    if (state.stage?.goal?.startsWith('保存手机号')) {
      if (!state.observation?.accessibility?.includes(targetPhone))
        return { kind: 'type' as const, target: { kind: 'role' as const, role: 'Edit', name: '手机号' }, text: targetPhone };
      return { kind: 'click' as const, target: { kind: 'role' as const, role: 'Button', name: '保存客户资料' } };
    }
    return { kind: 'done' as const, summary: '当前 UIA 证据已满足最终任务条件' };
  },
  async transcribeScreenshot() { return { text: '' }; },
  async locateVisualTarget() { throw new Error('Unexpected visual target'); },
  takeVisualUsage() { return undefined; },
} as PlanningModel;

if (phase === 'first') {
  const store = new WorkflowStore(resolve(rootDir, 'workflows.sqlite'));
  try {
    if (!store.get('p4-live-phone', 1)) store.addCandidate({
      id: 'p4-live-phone', version: 1, status: 'candidate', scope: 'stage', environment: 'windows',
      taskPattern: '保存手机号 {{value}}', inputs: [{ name: 'value', example: targetPhone }], preconditions: [],
      steps: [
        { goal: '输入手机号', action: { kind: 'type', target: { kind: 'role', role: 'Edit', name: '手机号' }, text: '{{value}}' },
          preferredMethods: [], successCondition: { kind: 'text_includes', value: '{{value}}' } },
        { goal: '保存客户资料', action: { kind: 'click', target: { kind: 'role', role: 'Button', name: '保存客户资料' } },
          preferredMethods: [], successCondition: { kind: 'text_includes', value: '客户资料已保存' } },
      ], successConditions: { pageTextIncludes: '客户资料已保存' }, knownFailures: [],
      sourceTaskId: 'p4-live-fixture', sourceTrace: 'p4-live-fixture', createdAt: '',
      successCount: 0, failureCount: 0,
    });
  } finally { store.close(); }
} else {
  const store = new WorkflowStore(resolve(rootDir, 'workflows.sqlite'));
  try {
    if (!store.get('p4-live-phone', 2)) store.addCandidate({ ...store.get('p4-live-phone', 1)!,
      steps: [{ goal: 'wrong new version', action: { kind: 'keypress', keys: 'f24' },
        preferredMethods: [], successCondition: { kind: 'text_includes', value: 'wrong' } }] });
  } finally { store.close(); }
}

const assembly = await createRootAssembly({ rootDir, model: { createModel: () => model },
  vmControl: {
    async status() { return { name: 'AgentDesktop', id: vmId, state: 'Running', ipv4: new URL(endpoint).hostname }; },
    async start() { return this.status(); },
    async openConsole() { throw new Error('Console operation excluded from P4 fixture'); },
  },
  traceStore: path => {
    const trace = new SqliteTrace(path);
    if (phase === 'first') {
      const save = trace.save.bind(trace);
      trace.save = (node, state) => {
        save(node, state);
        if (node === 'resolve_action' && state.stage?.goal === `保存手机号 ${targetPhone}` &&
            state.stage.actionCount === 2) trace.requestPause(state.taskId);
      };
    }
    return trace;
  },
});
const scope = mountSessionScope({ root: assembly.root, rootDir,
  sessionId: 'p4-live-session', vmId, endpoint, token, controlBus: assembly.controlBus,
  requireReconnect: true });
const trace = new SqliteTrace(resolve(rootDir, 'web-tasks.sqlite'));
const eventReader = new DatabaseSync(resolve(rootDir, 'web-tasks.sqlite'), { readOnly: true });
const lastEventId = eventReader.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE task_id = ?');
try {
  await scope.fiber;
  await scope.control!.reconnect();
  if (!scope.control!.view().workerReady) throw new Error('Worker not ready');
  const taskId = phase === 'first'
    ? assembly.controller.submit(`VM: 在 Windows Agent TestBench 中打开张三资料、把手机号改为 ${targetPhone} 并保存，最后核对号码和本次保存提示`)
    : readFileSync(resolve(rootDir, 'task-id.txt'), 'utf8').trim();
  const baselineLineage = phase === 'resume'
    ? trace.load(taskId)?.checkpointLineage?.length ?? 0 : 0;
  const baselineEventId = phase === 'first' ? 0 : (lastEventId.get(taskId) as { id: number }).id;
  if (phase === 'first') writeFileSync(resolve(rootDir, 'task-id.txt'), taskId);
  else assembly.controller.continue(taskId);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const state = trace.load(taskId);
    const newEvent = (lastEventId.get(taskId) as { id: number }).id > baselineEventId;
    if (newEvent && state && ['paused', 'done', 'failed', 'waiting_user'].includes(state.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const state = trace.load(taskId);
  const newEvents = (lastEventId.get(taskId) as { id: number }).id - baselineEventId;
  const budget = readTaskBudget(rootDir, taskId);
  console.log(JSON.stringify({ phase, taskId, newEvents, status: state?.status, summary: state?.summary,
    error: state?.error, step: state?.step, stages: state?.completedStages?.map(item => ({ goal: item.goal,
      workflowId: item.workflowId, workflowVersion: item.workflowVersion })),
    currentStage: state?.stage?.goal, workflowRef: state?.workflowRef,
    replay: state?.workflowReplayState, lineage: state?.checkpointLineage,
    verification: state?.goalVerification, budget: budget?.usage,
    budgetNote: 'Deterministic model reports synthetic token usage; no DeepSeek/JEV request is made.' }));
  assert.ok(newEvents > 0, 'Task produced no new Trace event during this harness invocation');
  if (phase === 'first') {
    assert.equal(state?.status, 'paused');
    assert.equal(state?.completedStages?.length, 1);
    assert.equal(state?.workflowRef?.id, 'p4-live-phone');
    assert.equal(state?.workflowRef?.version, 1);
  } else {
    assert.equal(state?.status, 'done');
    assert.equal(state?.completedStages?.length, 3);
    assert.equal(state?.completedStages?.[1]?.workflowId, 'p4-live-phone');
    assert.equal(state?.completedStages?.[1]?.workflowVersion, 1);
    assert.equal(state?.goalVerification?.ok, true);
    assert.equal(state?.checkpointLineage?.length, baselineLineage + 1);
  }
} finally {
  eventReader.close();
  trace.close();
  await assembly.dispose();
}
