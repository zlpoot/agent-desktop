import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createDashboardServer } from '../src/app/server.js';
import { DesktopTaskController } from '../src/app/task-runner.js';
import { initialState, type ComputerState } from '../src/graph/state.js';
import { SqliteTrace } from '../src/trace/sqlite-trace.js';
import { normalizeEvidence } from '../src/verifier/hybrid-verifier.js';
import { canManuallyReviewOutcome, reviewManualOutcome } from '../src/verification/manual-review.js';
import { taskOutcome } from '../src/verification/task-outcome.js';
import { explicitReplaySucceeded } from '../src/workflows/execution.js';
import type { Workflow } from '../src/workflows/schema.js';

function reviewableState(taskId = 'reviewable') {
  const observation = { windowTitle: '测试窗口', pageText: '结果已保存',
    textEvidence: [{ source: 'uia' as const, text: '结果已保存' }] };
  return { ...initialState(taskId, '保存测试结果', ['保存'], { pageTextIncludes: '结果已保存' }),
    status: 'paused' as const, step: 2, observation,
    stage: { id: `${taskId}:1`, goal: '保存结果', successCondition: '可见保存结果',
      startedAtStep: 0, actionCount: 2, planVersion: 1, isFinal: true },
    acceptanceReport: { mode: 'assist' as const, verdict: 'unknown' as const,
      observationId: normalizeEvidence(observation).observationId,
      checks: [{ criterion: 'pageTextIncludes', verdict: 'pass' as const, message: '页面文本匹配' }],
      message: 'JEV 无法确认持久结果' },
  };
}

test('人工结果验收只对最终阶段的当前证据开放，保留自动验收原结论', () => {
  const state = reviewableState();
  assert.equal(canManuallyReviewOutcome(state), true);
  const approved = reviewManualOutcome(state, true, '我已重新打开目标并核对结果', '2026-09-28T08:00:00Z');
  assert.equal(approved.status, 'done');
  assert.equal(approved.humanReview?.approved, true);
  assert.equal(approved.acceptanceReport?.verdict, 'unknown');
  assert.equal(approved.goalVerification, state.goalVerification);
  assert.deepEqual(taskOutcome(approved).autoVerification, {verdict:'unknown',reason:'evidence_unavailable',
    message:'JEV 无法确认持久结果'});
  assert.equal(taskOutcome(approved).humanAcceptance, 'accepted');
  assert.equal(taskOutcome(approved).diagnosis, 'human_confirmed_auto_unknown');
  assert.equal(approved.completedStages?.at(-1)?.source, 'manual');
  assert.equal(explicitReplaySucceeded({ ...approved, workflowReplayState: {
    nextIndex: 0, exploring: false } }, { steps: [] } as unknown as Workflow), false);
  assert.equal(canManuallyReviewOutcome(approved), false);
  const rejected = reviewManualOutcome(state, false, '尚未核对保存后的状态');
  assert.equal(rejected.status, 'paused');
  assert.equal(rejected.humanReview?.approved, false);
  for (const blocked of [
    { ...state, stage: { ...state.stage, isFinal: false } },
    { ...state, acceptanceReport: { ...state.acceptanceReport, checks: [] } },
    { ...state, acceptanceReport: { ...state.acceptanceReport, verdict: 'fail' as const } },
    { ...state, observation: { ...state.observation, pageText: '另一个结果' } },
    { ...state, inFlightAction: { kind: 'click' as const, target: { kind: 'text' as const, text: '保存' } } },
  ]) assert.equal(canManuallyReviewOutcome(blocked), false);
});

test('独立结果控件未被规划时可交人工核验，但其他未知项不可越过', () => {
  const state: ComputerState = reviewableState('durable-review');
  state.acceptanceReport!.checks.push({ criterion: 'durable_outcome', verdict: 'unknown',
    reason: 'unsupported_condition', message: '冻结条件缺少结果控件' });
  state.acceptanceReport!.reason = 'unsupported_condition';
  assert.equal(canManuallyReviewOutcome(state), true);
  assert.equal(canManuallyReviewOutcome({ ...state, recoveryRequired: true }), true);
  assert.equal(canManuallyReviewOutcome({ ...state, recoveryRequired: true,
    recoveryUncertain: true }), false);
  const approved = reviewManualOutcome(state, true, '独立 Oracle 显示保存后的值一致');
  assert.equal(approved.status, 'done');
  assert.equal(approved.acceptanceReport?.verdict, 'unknown');
  assert.equal(approved.completedStages?.at(-1)?.source, 'manual');
  assert.equal(canManuallyReviewOutcome({ ...state, acceptanceReport: {
    ...state.acceptanceReport!, checks: [...state.acceptanceReport!.checks,
      { criterion: 'missing_value', verdict: 'unknown', reason: 'evidence_unavailable', message: '缺少当前值' }],
  } }), false);
});

test('任务状态、自动验收、人工验收与失败原因分别呈现', () => {
  const base=reviewableState();
  assert.equal(taskOutcome({...base,status:'failed',acceptanceReport:undefined,
    error:'应用启动失败'}).diagnosis,'execution_failure');
  assert.equal(taskOutcome({...base,acceptanceReport:{...base.acceptanceReport,
    verdict:'fail'}}).diagnosis,'verification_failure');
  assert.equal(taskOutcome({...base,acceptanceReport:{...base.acceptanceReport,
    reason:'unsupported_condition' as const}}).diagnosis,'verifier_unsupported');
  assert.equal(taskOutcome(base).diagnosis,'evidence_insufficient');
  assert.equal(taskOutcome({...base,status:'done',acceptanceReport:{...base.acceptanceReport,
    verdict:'pass'}}).diagnosis,'verified');
});

test('Dashboard 人工验收只更新指定通用任务并保存审计事件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-desktop-manual-review-'));
  const db = new DatabaseSync(join(dir, 'web-task-routes.sqlite'));
  db.exec('CREATE TABLE generic_routes (task_id TEXT PRIMARY KEY, environment TEXT, window_handle INTEGER, created_at TEXT NOT NULL)');
  db.prepare('INSERT INTO generic_routes (task_id, created_at) VALUES (?, ?)').run('reviewable', new Date().toISOString());
  db.prepare('INSERT INTO generic_routes (task_id, created_at) VALUES (?, ?)').run('guest-review', new Date().toISOString());
  db.close();
  const trace = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
  trace.save('stage_check', reviewableState());
  trace.save('stage_check', { ...reviewableState('other'), stage: {
    ...reviewableState('other').stage, isFinal: false } });
  trace.save('stage_check', { ...reviewableState('guest-review'), goal: 'VM: 保存测试结果' });
  trace.close();
  const controller = new DesktopTaskController(dir, { modelProvider: { createModel() {
    throw new Error('人工验收不得调用模型');
  } } });
  const finished: Array<{ taskId: string; status?: string }> = [];
  controller.setDesktopControl({ workerEndpoint: () => 'http://127.0.0.1:8765',
    assertTaskAllowed() {}, async beginTask() {}, async finishTask(taskId, status) {
      finished.push({ taskId, status }); return true;
    } });
  const server = createDashboardServer(dir, controller);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('服务未启动');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const detail = await (await fetch(`${base}/api/runs/web-tasks.sqlite/reviewable`)).json();
    assert.equal(detail.canManualReview, true);
    const post = (id: string, body: unknown, origin?: string) => fetch(`${base}/api/tasks/${id}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(body),
    });
    assert.equal((await post('reviewable', { approved: true, note: '重新打开并核对保存值' }, 'http://evil.example')).status, 403);
    assert.equal((await post('other', { approved: true, note: '错误的阶段' })).status, 400);
    assert.equal((await post('reviewable', { approved: true, note: '重新打开并核对保存值' })).status, 200);
    assert.equal((await post('guest-review', { approved: true, note: '独立 Oracle 显示保存值一致' })).status, 200);
    assert.deepEqual(finished, [{ taskId: 'guest-review', status: 'done' }]);
    assert.equal((await post('reviewable', { approved: true, note: '重复确认' })).status, 400);
    const after = await (await fetch(`${base}/api/runs/web-tasks.sqlite/reviewable`)).json();
    assert.equal(after.status, 'done');
    assert.equal(after.canManualReview, false);
    assert.equal(after.humanReview.note, '重新打开并核对保存值');
    assert.equal(after.acceptanceReport.verdict, 'unknown');
    assert.equal(after.outcome.autoVerification.verdict, 'unknown');
    assert.equal(after.outcome.humanAcceptance, 'accepted');
    const saved = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
    try { assert.ok(saved.events('reviewable').some(event => event.node === 'manual_outcome_approved')); }
    finally { saved.close(); }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await controller.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
