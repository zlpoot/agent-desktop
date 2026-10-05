import type {VerificationInput,VerificationReport} from './contracts.js';

export interface FollowUpState {
  /** Host-owned state for this observation boundary; never taken from UI text or model output. */
  session:string;contractId:string;notBefore:number;
  waits:number;collections:number;escalations:number;
  planningNeed?:'none'|'ambiguous_goal'|'replan';
}
export interface FollowUpPolicy {maxWaits:number;maxCollections:number;maxEscalations:number;waitMs:number}
export const defaultFollowUpPolicy:Readonly<FollowUpPolicy>={maxWaits:3,maxCollections:2,maxEscalations:1,waitMs:1000};
export interface FollowUp {
  kind:'complete'|'wait'|'collect'|'escalate'|'review';reason:string;
  waitMs?:number;targetModel?:'deepseek';
  evidenceRequests:VerificationReport['missing'];
}
const collectReasons=new Set(['missing_fresh_bound_evidence','partial_evidence','conflicting_evidence','mixed_revisions',
  'mixed_object_revisions','requested_revision_superseded_or_unconfirmed','model_text_is_not_original_evidence',
  'missing_baseline','conflicting_baseline','unrecognized_outcome','type_mismatch']);
const semanticReasons=new Set(['semantic_judgment_required','model_unknown','low_model_confidence']);
export function followUp(input:VerificationInput,report:VerificationReport,state:FollowUpState,
  policy:FollowUpPolicy=defaultFollowUpPolicy):FollowUp {
  const result=(kind:FollowUp['kind'],reason:string):FollowUp=>({kind,reason,evidenceRequests:[],
    ...(kind==='wait'?{waitMs:policy.waitMs}:{}),...(kind==='escalate'?{targetModel:'deepseek' as const}:{})});
  if(![policy.maxWaits,policy.maxCollections,policy.maxEscalations].every(n=>Number.isInteger(n)&&n>=0)||
    !Number.isFinite(policy.waitMs)||policy.waitMs<=0)throw new Error('Invalid follow-up policy');
  if(state.session!==input.session||state.contractId!==input.contract.id||state.notBefore!==input.notBefore||
    ![state.waits,state.collections,state.escalations].every(n=>Number.isInteger(n)&&n>=0)||report.contractId!==input.contract.id)
    return result('review','invalid_follow_up_binding');
  if(report.checks.some(c=>c.id==='contract')||report.checks.some(c=>c.reason==='model_pass_requires_review'))
    return result('review','contract_or_model_pass_requires_review');
  if(report.verdict==='pass')return result('complete','verified');
  if(report.verdict==='fail')return result('review','confirmed_failure');
  const unresolved=report.checks.filter(c=>c.verdict==='unknown');
  if(!unresolved.length)return result('review','invalid_unknown_report');
  if(unresolved.some(c=>!collectReasons.has(c.reason)&&!semanticReasons.has(c.reason)&&
    !['outcome_pending','insufficient_stable_samples'].includes(c.reason)))return result('review','unsupported_or_service_failure');
  if(unresolved.some(c=>collectReasons.has(c.reason))) {
    if(state.collections>=policy.maxCollections)return result('review','collection_budget_exhausted');
    return {...result('collect','missing_or_unreliable_evidence'),evidenceRequests:report.missing.filter(m=>
      unresolved.some(c=>c.id===m.criterion&&collectReasons.has(c.reason)))};
  }
  if(unresolved.some(c=>['outcome_pending','insufficient_stable_samples'].includes(c.reason)))
    return state.waits<policy.maxWaits?result('wait','pending_or_unstable'):result('review','wait_budget_exhausted');
  // Unknown semantic meaning alone does not justify a costly planner call.
  if(state.collections<policy.maxCollections)return {...result('collect','semantic_evidence_needed'),evidenceRequests:report.missing};
  if(state.planningNeed==='ambiguous_goal'||state.planningNeed==='replan')
    return state.escalations<policy.maxEscalations?result('escalate','host_confirmed_planning_need'):result('review','escalation_budget_exhausted');
  return result('review','unresolved_without_planning_need');
}
