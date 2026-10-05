import type {VerificationInput} from './contracts.js';
import type {FollowUpState} from './follow-up.js';
import type {VerificationCoordinator} from './coordinator.js';

export interface ShadowEnvelope {eventId:number;taskId:string;step:number;node:string;createdAt:string;state:Record<string,unknown>}
/** Receipts never contain or modify task state. Legacy evidence is not silently promoted to trusted Evidence. */
export function inspectShadowEvent(event:ShadowEnvelope) {
  const state=event.state;
  const observation=state.observation as Record<string,unknown>|undefined;
  const scope=event.node==='verify'?'action':event.node==='finish'?'task':'stage';
  const original=scope==='action'?state.lastVerification:scope==='task'?state.goalVerification:state.lastStageVerification;
  return {eventId:event.eventId,taskId:event.taskId,step:event.step,node:event.node,scope,recordedAt:event.createdAt,
    mode:'shadow' as const,status:'blocked' as const,
    original:original??null,
    missing:['independent_verification_contract','capture_session_and_timestamp','field_completeness_and_object_binding'],
    available:{observation:Boolean(observation),textEvidence:Array.isArray(observation?.textEvidence),
      windowIdentity:typeof observation?.windowHandle==='number',windowScreenshot:typeof observation?.screenshot==='string',
      desktopScreenshot:typeof observation?.desktopScreenshot==='string'},
    verdict:null,followUp:null,jevCalls:0,deepseekCalls:0};
}

/** Typed future integration boundary; callers supply authentic contracts/capture metadata and Host retry state. */
export async function evaluateShadow(coordinator:VerificationCoordinator,input:VerificationInput,state:FollowUpState) {
  try {
    const copy=structuredClone(input),retry=structuredClone(state);
    const result=await coordinator.verify(copy,retry);
    return {mode:'shadow' as const,status:'evaluated' as const,...result};
  } catch {
    return {mode:'shadow' as const,status:'error' as const,reason:'shadow_evaluation_failed'};
  }
}
