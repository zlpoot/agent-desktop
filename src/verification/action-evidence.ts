import {createHash} from 'node:crypto';
import type {ActionPostcondition,ComputerAction,Observation,Target} from '../actions/schema.js';
import type {TargetBinding} from '../actions/semantic-target.js';
import type {VerificationContract,VerificationInput,Evidence} from './contracts.js';

interface GuestControl {
  name:string;value:string;runtimeId:number[]|null;nameComplete:boolean;valueComplete:boolean;
  role:string;autoId:string;className:string;enabled:boolean;visible:boolean;
}

const inputRoles=new Set(['edit','document','combobox']);
const maxBaselineAgeMs=60_000;

function controls(observation:Observation):GuestControl[]|undefined {
  const capture=observation.capture;
  if(capture?.fields.dom?.source!=='uia'||capture.enumerationComplete!==true||typeof observation.dom!=='string')return;
  try {
    const rows:unknown=JSON.parse(observation.dom);
    if(!Array.isArray(rows)||rows.length>501)return;
    if(!rows.every(row=>{
      if(!row||typeof row!=='object')return false;
      const x=row as Record<string,unknown>;
      return ['name','value','role','autoId','className'].every(k=>typeof x[k]==='string')&&
        ['nameComplete','valueComplete','enabled','visible'].every(k=>typeof x[k]==='boolean')&&
        (x.runtimeId===null||Array.isArray(x.runtimeId)&&x.runtimeId.length>0&&
          x.runtimeId.every((n:unknown)=>Number.isInteger(n)));
    }))return;
    return rows as GuestControl[];
  } catch {return;}
}

function matches(control:GuestControl,target:Target,inputOnly=false):boolean {
  if(!control.visible||!control.enabled||inputOnly&&!inputRoles.has(control.role.toLowerCase()))return false;
  switch(target.kind) {
    case 'role':return control.role.toLowerCase()===target.role.toLowerCase()&&
      (!target.name||control.nameComplete&&control.name===target.name);
    case 'label':return control.nameComplete&&control.name===target.label;
    case 'text':return control.nameComplete&&control.name===target.text;
    case 'selector':{
      const [key,...rest]=target.selector.split('=');
      if(rest.length!==1)return false;
      return key==='autoId'?control.autoId===rest[0]:key==='className'&&control.className===rest[0];
    }
    default:return false;
  }
}

function mayHideNamedMatch(control:GuestControl,target:Target):boolean {
  if(!control.visible||!control.enabled||control.nameComplete)return false;
  return target.kind==='role'?control.role.toLowerCase()===target.role.toLowerCase():
    target.kind==='label'||target.kind==='text';
}

function declaredPostcondition(action:ComputerAction):ActionPostcondition|undefined {
  if(action.kind==='navigate')return {kind:'url_equals',value:action.url};
  if(action.kind==='click'||action.kind==='double_click'||action.kind==='keypress')return action.postcondition;
}

function observedResult(taskId:string,step:number,earlier:NonNullable<Observation['capture']>,
  later:NonNullable<Observation['capture']>,postcondition:ActionPostcondition,
  before:Observation,after:Observation):{input?:VerificationInput;reason?:string} {
  const session=`${taskId}:${earlier.epoch}`;
  const requirement='declared-action-result';
  if(postcondition.kind==='url_equals'||postcondition.kind==='url_includes') {
    if(earlier.fields.url?.source!=='api'||later.fields.url?.source!=='api'||
      !earlier.fields.url.complete||!later.fields.url.complete||!before.url||!after.url)
      return {reason:'missing_original_url_evidence'};
    const pathOf = (url: string): string => { try { return new URL(url).pathname; } catch { return url; } };
    // 归一化后的条件值是 path+search（蒸馏端去掉了 origin/端口）；完整 URL 与 path 任一匹配。
    const satisfied=(value:string)=>postcondition.kind==='url_equals'
      ?(value===postcondition.value||pathOf(value)===postcondition.value)
      :(value.includes(postcondition.value)||pathOf(value).includes(postcondition.value));
    if(satisfied(before.url))return {reason:'postcondition_already_satisfied_before_action'};
    const contract:VerificationContract={id:`${taskId}:${step}:action`,scope:'action',requirements:[requirement],
      criteria:[{id:requirement,requirement,object:later.object,field:'url',sources:['api'],
        predicate:postcondition.kind==='url_equals'?{op:'equals',expected:postcondition.value}:
          {op:'contains',expected:postcondition.value}}]};
    return {input:{contract:structuredClone(contract),specification:structuredClone(contract),session,
      now:later.finishedAt,notBefore:later.startedAt,
      before:[{id:`before:${step}:${earlier.sequence}:url`,session,object:earlier.object,field:'url',
        source:'api',value:before.url,capturedAt:earlier.finishedAt,complete:true}],
      evidence:[{id:`after:${step}:${later.sequence}:url`,session,object:later.object,field:'url',
        source:'api',value:after.url,capturedAt:later.finishedAt,complete:true}],execution:'dispatched'}};
  }
  if(postcondition.kind==='desktop_file')return {reason:'file_evidence_requires_independent_collector'};
  if(before.windowHandle===undefined||before.windowHandle!==after.windowHandle)
    return {reason:'capture_identity_changed'};
  const first=controls(before),last=controls(after);
  if(!first||!last)return {reason:'missing_original_target_controls'};
  const target=postcondition.target;
  if(['coordinate','vision'].includes(target.kind)||target.kind==='role'&&!target.name)
    return {reason:'invalid_declared_ui_target'};
  if([...first,...last].some(c=>mayHideNamedMatch(c,target)))return {reason:'ui_target_name_incomplete'};
  if(first.some(c=>matches(c,target)))return {reason:'postcondition_already_satisfied_before_action'};
  const found=last.filter(c=>matches(c,target));
  if(found.length>1)return {reason:'result_target_not_unique'};
  if(found.length===1&&(!found[0].runtimeId||last.filter(c=>
    JSON.stringify(c.runtimeId)===JSON.stringify(found[0].runtimeId)).length!==1))
    return {reason:'result_target_identity_unconfirmed'};
  const object=`${later.object}:uia-query:${createHash('sha256').update(JSON.stringify(target)).digest('hex').slice(0,16)}`;
  const contract:VerificationContract={id:`${taskId}:${step}:action`,scope:'action',requirements:[requirement],
    criteria:[{id:requirement,requirement,object,field:'present',sources:['uia'],
      predicate:{op:'equals',expected:true}}]};
  return {input:{contract:structuredClone(contract),specification:structuredClone(contract),session,
    now:later.finishedAt,notBefore:later.startedAt,
    evidence:[{id:`after:${step}:${later.sequence}:uia-query`,session,object,field:'present',source:'uia',
      value:found.length===1,capturedAt:later.finishedAt,complete:true,
      ...(found.length===1?{revision:JSON.stringify(found[0].runtimeId)}:{})}],execution:'dispatched'}};
}

/** A typed action is checked against the same UIA control, never against whole-window text. */
export function actionEvidenceInput(taskId:string,step:number,action:ComputerAction|undefined,
  before:Observation|undefined,after:Observation|undefined,effect:'none'|'dispatched'|'uncertain'|undefined,
  binding?:TargetBinding):{input?:VerificationInput;reason?:string} {
  if(!action)return {reason:'action_postcondition_not_formalized'};
  const inputAction=action.kind==='type'||action.kind==='paste_text';
  const postcondition=declaredPostcondition(action);
  if(!inputAction&&!postcondition)return {reason:'action_postcondition_not_formalized'};
  if(effect!=='dispatched')return {reason:'action_dispatch_not_confirmed'};
  const earlier=before?.capture,later=after?.capture;
  if(!earlier||!later)return {reason:'missing_capture_boundary'};
  if(earlier.epoch!==later.epoch||earlier.object!==later.object)return {reason:'capture_identity_changed'};
  if(![earlier.finishedAt,earlier.sequence,later.startedAt,later.finishedAt,later.sequence].every(Number.isFinite)||
    later.sequence<=earlier.sequence||later.startedAt<=earlier.finishedAt||later.finishedAt<later.startedAt)
    return {reason:'capture_order_unconfirmed'};
  if(later.finishedAt-earlier.finishedAt>maxBaselineAgeMs)return {reason:'partial_or_stale_baseline'};
  if(postcondition&&before&&after)return observedResult(taskId,step,earlier,later,postcondition,before,after);
  if(!inputAction)return {reason:'missing_capture_boundary'};
  if(!binding||!['role','label','text','selector'].includes(binding.selected.kind)||
    before?.windowHandle===undefined||before.windowHandle!==after?.windowHandle||
    binding.context.windowHandle!==before.windowHandle)return {reason:'missing_bound_input_target'};
  const first=controls(before),last=controls(after);
  if(!first||!last)return {reason:'missing_original_target_controls'};
  const target=binding.selected;
  const initial=first.filter(c=>matches(c,target,true));
  if(initial.length!==1)return {reason:'baseline_target_not_unique'};
  const source=initial[0];
  if(!source.runtimeId||!source.valueComplete)return {reason:'baseline_target_identity_or_value_incomplete'};
  const id=JSON.stringify(source.runtimeId);
  if(first.filter(c=>JSON.stringify(c.runtimeId)===id).length!==1)return {reason:'duplicate_baseline_control_identity'};
  const same=last.filter(c=>JSON.stringify(c.runtimeId)===id);
  if(same.length!==1||!matches(same[0],target,true)||last.filter(c=>matches(c,target,true)).length!==1||
    !same[0].valueComplete)return {reason:'result_target_identity_or_value_unconfirmed'};
  if(source.value===action.text)return {reason:'input_already_present_before_action'};
  const session=`${taskId}:${earlier.epoch}`;
  const object=`${later.object}:uia:${id}`;
  const requirement='bound-input-value';
  const contract:VerificationContract={id:`${taskId}:${step}:action`,scope:'action',requirements:[requirement],
    criteria:[{id:requirement,requirement,object,field:'value',sources:['uia'],
      predicate:{op:'equals',expected:action.text}}]};
  const evidence:Evidence={id:`after:${step}:${later.sequence}:${id}`,session,object,field:'value',
    source:'uia',value:same[0].value,capturedAt:later.finishedAt,complete:true};
  const baseline:Evidence={id:`before:${step}:${earlier.sequence}:${id}`,session,object,field:'value',
    source:'uia',value:source.value,capturedAt:earlier.finishedAt,complete:true};
  return {input:{contract:structuredClone(contract),specification:structuredClone(contract),session,
    now:later.finishedAt,notBefore:later.startedAt,evidence:[evidence],before:[baseline],execution:'dispatched'}};
}
