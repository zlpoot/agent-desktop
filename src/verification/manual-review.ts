import type { ComputerState } from '../graph/state.js';
import { normalizeEvidence } from '../verifier/hybrid-verifier.js';

/** An explicit human decision is available only after a complete final observation. */
export function canManuallyReviewOutcome(state: ComputerState): boolean {
  const report = state.acceptanceReport;
  const checks = report?.checks ?? [];
  // A missing durable-result contract cannot establish automatic success, but
  // a person may confirm it from an independent source and leave an audit note.
  const reviewableChecks = checks.length > 0 && checks.some(check => check.verdict === 'pass') &&
    checks.every(check => check.verdict === 'pass' ||
      check.criterion === 'durable_outcome' && check.verdict === 'unknown' &&
      check.reason === 'unsupported_condition');
  const recoverySafeForReview = !state.recoveryRequired ||
    reviewableChecks && !state.recoveryUncertain;
  return state.status === 'paused' && recoverySafeForReview && !state.setupPaused &&
    !state.inFlightAction && !state.verificationPending && !!state.observation &&
    (state.stage?.isFinal === true || !state.stage && state.lastAction?.kind === 'done') &&
    report?.mode === 'assist' && report.verdict === 'unknown' &&
    reviewableChecks &&
    report.observationId === normalizeEvidence(state.observation).observationId;
}

export function reviewManualOutcome(state: ComputerState, approved: boolean, note: string,
  reviewedAt = new Date().toISOString()): ComputerState {
  if (!canManuallyReviewOutcome(state)) throw new Error('当前任务不符合人工结果验收条件');
  const reason = note.trim();
  if (reason.length < 3 || reason.length > 500) throw new Error('请填写 3–500 字的核对依据');
  const humanReview = { approved, note: reason, reviewedAt,
    observationId: state.acceptanceReport!.observationId };
  if (!approved) return { ...state, humanReview, summary: '人工尚未确认结果，任务保持暂停' };
  const completed = state.stage ? { id: state.stage.id, goal: state.stage.goal,
    successCondition: state.stage.successCondition, startStep: state.stage.startedAtStep,
    endStep: state.step, evidence: `人工核对：${reason}`, source: 'manual' as const } : undefined;
  return { ...state, humanReview, status: 'done', error: undefined, stage: undefined,
    finalReviewPending: false,
    completedStages: completed ? [...(state.completedStages ?? []), completed] : state.completedStages,
    summary: '人工确认完成；自动验收仍为 unknown' };
}
