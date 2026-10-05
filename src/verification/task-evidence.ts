import type {Observation} from '../actions/schema.js';
import type {CompletionCriteria} from '../verifier/verifier.js';
import type {VerificationContract,VerificationInput,EvidenceSource,Evidence} from './contracts.js';
import type {DesktopFileSnapshot,VerifiedDesktopFile} from './file-evidence.js';
import {checkStructuredState} from './structured-state.js';
import type {PlannedVerificationContract} from '../agent/task-planner.js';

export interface TaskFileEvidence {proof:VerifiedDesktopFile;current:DesktopFileSnapshot}

/** Build a task-level check from Host completion criteria and the original user goal. */
export function taskEvidenceInput(taskId:string,goal:string,criteria:CompletionCriteria|undefined,
  observation:Observation|undefined,options:{files?:TaskFileEvidence[];exactContract?:boolean;
    planned?:PlannedVerificationContract}={}
):{input?:VerificationInput;reason?:string} {
  if(!criteria||!Object.keys(criteria).length)return {reason:'missing_independent_task_criteria'};
  const capture=observation?.capture;
  if(!capture||!Number.isFinite(capture.startedAt)||!Number.isFinite(capture.finishedAt)||
    capture.finishedAt<capture.startedAt)return {reason:'missing_capture_boundary'};
  const configured=Object.entries(criteria).filter(([,value])=>value!==undefined&&value!==''&&
    (!Array.isArray(value)||value.length>0));
  if(!configured.length)return {reason:'missing_independent_task_criteria'};
  const supported=new Set(['urlIncludes','windowTitleIncludes','pageTextIncludes','pageTextIncludesAll',
    'accessibilityIncludes','domIncludes','structuredStates']);
  if(configured.some(([key])=>!supported.has(key)))return {reason:'unsupported_task_criterion'};
  const session=`${taskId}:${capture.epoch}`;
  const evidence:Evidence[]=[];
  const contract:VerificationContract={id:`${taskId}:task`,scope:'task',requirements:[],criteria:[]};
  const select=(field:'url'|'windowTitle'|'pageText'|'accessibility'|'dom'):
    {value:string;source:EvidenceSource;complete:boolean}|undefined=>{
    if(field==='windowTitle')return observation?.windowTitle
      ?{value:observation.windowTitle,source:'window',complete:true}:undefined;
    const fieldInfo=capture.fields[field];
    if(!fieldInfo?.source)return;
    const value=field==='pageText'
      ?observation?.textEvidence?.filter(e=>e.source===fieldInfo.source).length===1
        ?observation.textEvidence.filter(e=>e.source===fieldInfo.source)[0].text:undefined
      :observation?.[field];
    return typeof value==='string'?{value,source:fieldInfo.source,complete:fieldInfo.complete}:undefined;
  };
  const add=(id:string,field:'url'|'windowTitle'|'pageText'|'accessibility'|'dom',expected:string)=>{
    contract.requirements.push(id);
    const original=select(field);
    contract.criteria.push({id,requirement:id,object:capture.object,field,sources:[original?.source??'dom'],
      predicate:{op:'contains',expected}});
    if(original)evidence.push({id:`${capture.sequence}:${id}`,session,object:capture.object,field,
      source:original.source,value:original.value,capturedAt:capture.finishedAt,complete:original.complete});
  };
  if(criteria.urlIncludes)add('urlIncludes','url',criteria.urlIncludes);
  if(criteria.windowTitleIncludes)add('windowTitleIncludes','windowTitle',criteria.windowTitleIncludes);
  if(criteria.pageTextIncludes)add('pageTextIncludes','pageText',criteria.pageTextIncludes);
  criteria.pageTextIncludesAll?.forEach((value,index)=>add(`pageTextIncludesAll:${index}`,'pageText',value));
  if(criteria.accessibilityIncludes)add('accessibilityIncludes','accessibility',criteria.accessibilityIncludes);
  if(criteria.domIncludes)add('domIncludes','dom',criteria.domIncludes);
  for(const [index,condition] of (criteria.structuredStates??[]).entries()) {
    const source=options.planned?.evidenceSources.structuredStates;
    if(source!=='dom'&&source!=='uia')return {reason:'missing_structured_evidence_source'};
    const id=`structuredStates:${index}`;
    const object=`${capture.object}:control:${condition.target.role}:${condition.target.name??''}:${condition.target.text??''}`;
    const field=condition.field==='classToken'?`classToken:${condition.equals}`:condition.field;
    const expected=condition.field==='classToken'?true:condition.equals;
    contract.requirements.push(id);
    contract.criteria.push({id,requirement:id,object,field,sources:[source],
      predicate:{op:'equals',expected}});
    const checked=checkStructuredState(condition,observation,source);
    if(checked.actual!==undefined)evidence.push({id:`${capture.sequence}:${id}`,session,object,field,
      source,value:checked.actual,capturedAt:capture.finishedAt,complete:true});
  }
  if(options.exactContract) {
    if(!options.files?.length)return {reason:'missing_verified_file_contract'};
    for(const {proof,current} of options.files) {
      if(proof.taskId!==taskId)return {reason:'verified_file_task_mismatch'};
      const object=`desktop-file:${current.path}`;
      const fields:Array<[string,string|boolean|undefined]>=[['exists',true],
        ['sha256',proof.after.sha256?.toLowerCase()]];
      if(proof.expected.contentEquals!==undefined)fields.push(['text',proof.expected.contentEquals]);
      if(fields.some(([,expected])=>expected===undefined))return {reason:'verified_file_hash_missing'};
      for(const [field,expected] of fields) {
        const id=`verified-file:${proof.step}:${field}`;
        contract.requirements.push(id);
        contract.criteria.push({id,requirement:id,object,field,sources:['file'],
          predicate:{op:'equals',expected:expected!}});
        if(field==='exists'||current.exists)evidence.push({id:`file:${proof.step}:${field}:${current.capturedAt}`,
          session,object,field,source:'file',capturedAt:current.capturedAt,complete:current.complete,
          value:field==='exists'?current.exists:field==='sha256'?current.sha256!:current.text!});
      }
    }
  } else {
    // Exploratory tasks still require the original goal to be judged separately.
    const semantic=select('pageText')??select('accessibility');
    if(!semantic)return {reason:'missing_original_task_text'};
    const semanticField=select('pageText')?'pageText':'accessibility';
    contract.requirements.push('original-task-goal');
    contract.criteria.push({id:'original-task-goal',requirement:'original-task-goal',object:capture.object,
      field:semanticField,sources:[semantic.source],predicate:{op:'semantic',
        instruction:`判断原始任务是否已经完成：${goal}。只依据当前证据；若任务要求持久化、文件路径或其他画面外事实而证据没有提供，应回答 unknown。`}});
    evidence.push({id:`${capture.sequence}:original-task-goal`,session,object:capture.object,field:semanticField,
      source:semantic.source,value:semantic.value,capturedAt:capture.finishedAt,complete:semantic.complete});
  }
  return {input:{contract:structuredClone(contract),specification:structuredClone(contract),session,
    now:Math.max(capture.finishedAt,...(options.files??[]).map(item=>item.current.capturedAt)),
    notBefore:capture.startedAt,evidence}};
}
