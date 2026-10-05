import {appendFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import type {ComputerState} from '../graph/state.js';
import type {Observation} from '../actions/schema.js';

export function freezeShadowContract(state:ComputerState) {
  const action=state.lastAction;
  const formalized=action && (action.kind==='type'||action.kind==='paste_text'||action.kind==='navigate'||
    (action.kind==='click'||action.kind==='double_click'||action.kind==='keypress')&&!!action.postcondition);
  return {taskId:state.taskId,step:state.step,frozenAt:Date.now(),
    task:{goal:state.taskContract?.target??state.goal,criteria:structuredClone(state.completionCriteria??{})},
    stage:state.stage?{id:state.stage.id,goal:state.stage.goal,successCondition:state.stage.successCondition}:undefined,
    action:{intent:structuredClone(action),postconditionStatus:formalized?'formalized' as const:'not_formalized' as const},
    beforeCapture:structuredClone(state.observation?.capture)};
}
export type FrozenShadowContract=ReturnType<typeof freezeShadowContract>;
export interface HostShadowRecord {kind:'contract'|'observation'|'action-verification'|'stage-contract'|'stage-verification'|'task-verification';taskId:string;step:number;contract?:FrozenShadowContract;
  stageContract?:import('./planner-contract.js').StageEvidenceContract;
  input?:import('./contracts.js').VerificationInput;
  report?:import('./contracts.js').VerificationReport;
  capture?:Observation['capture'];
  status?:'ready_for_normalization'|'blocked';reasons?:string[]}
export function shadowObservation(state:ComputerState):HostShadowRecord {
  const contract=state.shadowContract,capture=state.observation?.capture,before=contract?.beforeCapture;
  const reasons:string[]=[];
  if(!contract||contract.taskId!==state.taskId||contract.step!==state.step)reasons.push('missing_pre_dispatch_contract');
  if(!capture||!before)reasons.push('missing_capture_boundary');
  else {
    if(capture.epoch!==before.epoch||capture.object!==before.object)reasons.push('capture_identity_changed');
    if(capture.sequence<=before.sequence||capture.startedAt<before.finishedAt||capture.finishedAt<capture.startedAt)reasons.push('capture_order_unconfirmed');
    if(!capture.fields.pageText?.complete)reasons.push('partial_text');
  }
  // A natural-language intent snapshot is not an executable postcondition.
  if(contract?.action.postconditionStatus==='not_formalized')reasons.push('action_postcondition_not_formalized');
  return {kind:'observation',taskId:state.taskId,step:state.step,contract,capture:structuredClone(capture),
    status:reasons.length?'blocked':'ready_for_normalization',reasons};
}
export function writeHostShadow(root:string,record:HostShadowRecord):void {
  const dir=resolve(root,'.artifacts','verification-host-shadow');mkdirSync(dir,{recursive:true});
  const key=createHash('sha256').update(record.taskId).digest('hex');
  appendFileSync(resolve(dir,`${key}.jsonl`),JSON.stringify(record)+'\n');
}
