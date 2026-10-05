import type {Observation} from '../actions/schema.js';
import type {VerificationContract,VerificationInput} from './contracts.js';

/** Model chooses evidence channels only. Host owns the requirement IDs and exact requirement text. */
export interface EvidencePlan {requirements:Array<{id:string;field:'pageText'|'accessibility';source:'dom'|'uia'}>}
export function parseEvidencePlan(value:unknown,required:readonly string[]):EvidencePlan|undefined {
  if(!value||typeof value!=='object')return;
  const rows=(value as EvidencePlan).requirements;
  if(!Array.isArray(rows)||rows.length!==required.length||rows.length>20)return;
  if(new Set(rows.map(r=>r?.id)).size!==rows.length)return;
  if(rows.some(r=>!r||!required.includes(r.id)||!['pageText','accessibility'].includes(r.field)||!['dom','uia'].includes(r.source)))return;
  return structuredClone({requirements:rows.map(({id,field,source})=>({id,field,source}))});
}
export interface StageEvidenceContract {
  stageId:string;requirements:Array<{id:string;text:string}>;plan?:EvidencePlan;
  /** Independent Host copy made when planning returns, before any stage action. */
  originalTaskGoal:string;
}
export function freezeStageEvidence(stageId:string,goal:string,successCondition:string,originalTaskGoal:string,plan:unknown):StageEvidenceContract {
  return {stageId,originalTaskGoal,requirements:[{id:'stage-result',text:`${goal}\n成功条件：${successCondition}`}],
    plan:parseEvidencePlan(plan,['stage-result'])};
}
export function stageEvidenceInput(contract:StageEvidenceContract,observation:Observation|undefined,
  boundary:Observation['capture']):{input?:VerificationInput;reason?:string} {
  const capture=observation?.capture;
  if(!contract.plan)return {reason:'missing_or_invalid_evidence_plan'};
  if(!capture||!boundary)return {reason:'missing_capture_boundary'};
  if(capture.epoch!==boundary.epoch||capture.object!==boundary.object)return {reason:'capture_identity_changed'};
  if(![capture.startedAt,capture.finishedAt,boundary.finishedAt,capture.sequence,boundary.sequence].every(Number.isFinite)||
    capture.sequence<=boundary.sequence||capture.startedAt<boundary.finishedAt||capture.finishedAt<capture.startedAt)
    return {reason:'capture_order_unconfirmed'};
  const spec:VerificationContract={id:contract.stageId,scope:'stage',requirements:contract.requirements.map(r=>r.id),
    criteria:contract.plan.requirements.map(p=>({id:p.id,requirement:p.id,object:capture.object,field:p.field,sources:[p.source],
      predicate:{op:'semantic',instruction:contract.requirements.find(r=>r.id===p.id)!.text}}))};
  // Collector clock used end-to-end. Epoch is a collector identity, NOT a Host task session.
  const session=`${contract.stageId}:${capture.epoch}`;
  const evidence=contract.plan.requirements.flatMap(p=>{
    const originals=observation?.textEvidence?.filter(e=>e.source===p.source)??[];
    const text=p.field==='pageText'?(originals.length===1?originals[0].text:undefined):observation?.[p.field];
    if(typeof text!=='string'||capture.fields[p.field]?.source!==p.source)return [];
    return [{id:`${capture.sequence}:${p.id}`,session,object:capture.object,field:p.field,value:text,source:p.source,
      capturedAt:capture.finishedAt,complete:capture.fields[p.field].complete}];
  });
  return {input:{contract:structuredClone(spec),specification:structuredClone(spec),session,now:capture.finishedAt,
    notBefore:boundary.finishedAt,evidence}};
}
