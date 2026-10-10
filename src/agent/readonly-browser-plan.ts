import type { ComputerState } from '../graph/state.js';
import type { CompletionCriteria } from '../verifier/verifier.js';
import type { PlannedVerificationContract } from './task-planner.js';
import type { ComputerAction } from '../actions/schema.js';

/** Closed, explicit single-page request. Unknown wording or extra goals cannot be silently dropped. */
export function readonlyBrowserIdentity(goal:string):{url:string;title:string;marker:string}|undefined {
  const match=goal.trim().match(/^仅打开 (https?:\/\/[^\s，。]+)，读取网页标题和页面唯一标记 ([^\s，。]+)，并报告观察结果。只读，不访问其他地址，不点击、输入、下载或登录。\s*完成条件：最终 URL 为 (https?:\/\/[^\s，。]+)，网页标题为 ([^，。\r\n]+)，页面正文含唯一标记 ([^\s，。]+)。以实际页面 DOM 和最终 URL 独立核验。\s*操作限制：仅允许导航到 (https?:\/\/[^\s，。]+) 并读取观察。禁止其他地址、第三方站点、账号登录、点击、输入、下载、文件或站点写入及 Native\/VM 输入。$/);
  if(!match)return;
  const [,url,marker,finalUrl,title,finalMarker,allowedUrl]=match;
  if(url!==finalUrl||url!==allowedUrl||marker!==finalMarker||url.length>200
    ||title.length<2||title.length>185||/[<>&]/.test(title)||marker.length<2||marker.length>200)return;
  try {const parsed=new URL(url);if(parsed.href!==url||parsed.username||parsed.password)return;}catch{return;}
  return {url,title,marker};
}

/** Construct before freezing; never substitute evidence or rewrite an executing Task contract. */
export function readonlyBrowserContract(goal:string):PlannedVerificationContract|undefined {
  const identity=readonlyBrowserIdentity(goal);
  if(!identity)return;
  return {goal:goal.trim(),successConditions:{urlIncludes:identity.url,
    domIncludes:`<title>${identity.title}</title>`,pageTextIncludes:identity.marker},
    evidenceSources:{urlIncludes:'browser',domIncludes:'dom',pageTextIncludes:'dom'},
    verifierStrategy:'rules_then_jev'};
}

function sameCriteria(actual:CompletionCriteria|undefined,expected:CompletionCriteria):boolean {
  return !!actual&&Object.keys(actual).length===3
    && (['urlIncludes','domIncludes','pageTextIncludes'] as const).every(key=>actual[key]===expected[key]);
}

function matchesFrozen(state:Readonly<ComputerState>):boolean {
  const expected=readonlyBrowserContract(state.goal),frozen=state.verificationContract;
  return !!expected&&!!frozen&&frozen.goal===expected.goal&&frozen.verifierStrategy===expected.verifierStrategy
    &&sameCriteria(state.completionCriteria,expected.successConditions)
    &&sameCriteria(frozen.successConditions,expected.successConditions)
    &&Object.keys(frozen.evidenceSources).length===3
    &&Object.keys(expected.evidenceSources).every(key=>frozen.evidenceSources[key]===expected.evidenceSources[key]);
}

/** The canonical request permits no other target or input, even if a decision model proposes one. */
export function assertReadonlyBrowserAction(state:Readonly<ComputerState>,action:ComputerAction):void {
  if(state.taskContract?.environment!=='browser'||!matchesFrozen(state))return;
  if(['done','ask_user','wait'].includes(action.kind))return;
  if(action.kind==='navigate'&&action.url===state.completionCriteria!.urlIncludes)return;
  throw new Error('冻结的单页只读任务只允许导航到指定 URL 或读取报告，禁止其他地址和输入');
}

/** Only the first, untouched Browser stage of this complete request can be planned as final. */
export function readonlyBrowserStagePlan(state:Readonly<ComputerState>) {
  if(state.step!==0||(state.stagePlanVersion??0)!==0||state.stage||state.completedStages?.length
    ||state.workflowRef||state.workflowReplayState||state.resumeReconcile||state.recoveryRequired
    ||state.taskContract?.environment!=='browser'||state.taskContract.target!==state.goal
    ||state.contractCoverage?.covered!==true)return;
  if(!matchesFrozen(state))return;
  return {goal:'只读打开指定网页，读取并报告网页标题及正文唯一标记',
    successCondition:'最终 URL、DOM title 和正文唯一标记均精确满足冻结的完整任务契约',isFinal:true,
    verification:{requirements:[{id:'stage-result',field:'pageText' as const,source:'dom' as const}]}};
}
