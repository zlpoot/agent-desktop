import type { ComputerState } from '../graph/state.js';
import type { UnknownReason, Verdict } from '../verifier/hybrid-verifier.js';

/** A presentation of three independent facts. It never changes task or verification state. */
export interface TaskOutcome {
  taskState: ComputerState['status'];
  diagnosis: 'execution_failure' | 'verification_failure' | 'verifier_unsupported' |
    'human_confirmed_auto_unknown' | 'evidence_insufficient' | 'verified' | 'in_progress';
  autoVerification: { verdict: Verdict; reason?: UnknownReason; message?: string };
  humanAcceptance: 'accepted' | 'not_accepted' | 'unreviewed';
}

export function taskOutcome(state: ComputerState): TaskOutcome {
  const report = state.acceptanceReport?.mode === 'assist' ? state.acceptanceReport : undefined;
  const verdict: Verdict = report?.verdict ?? (state.goalVerification?.ok ? 'pass' : 'unknown');
  const reason = verdict === 'unknown' ? report?.reason ?? 'evidence_unavailable' : undefined;
  const humanAcceptance = state.humanReview?.approved === true ? 'accepted' :
    state.humanReview?.approved === false ? 'not_accepted' : 'unreviewed';
  let diagnosis: TaskOutcome['diagnosis'];
  if (report?.verdict === 'fail' || state.status === 'failed' && state.goalVerification?.ok === false)
    diagnosis = 'verification_failure';
  else if (state.status === 'failed') diagnosis = 'execution_failure';
  else if (reason === 'unsupported_condition') diagnosis = 'verifier_unsupported';
  else if (verdict === 'unknown' && humanAcceptance === 'accepted') diagnosis = 'human_confirmed_auto_unknown';
  else if (report?.verdict === 'unknown') diagnosis = 'evidence_insufficient';
  else if (verdict === 'pass' && state.status === 'done') diagnosis = 'verified';
  else diagnosis = 'in_progress';
  return { taskState: state.status, diagnosis,
    autoVerification: { verdict, ...(reason ? {reason} : {}),
      ...(report?.message ?? state.goalVerification?.message ?
        {message: report?.message ?? state.goalVerification?.message} : {}) },
    humanAcceptance };
}
