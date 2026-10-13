import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import type {ComputerAction} from '../src/actions/schema.js';
import type {ComputerState} from '../src/graph/state.js';
import type {ChromeDiscovery} from '../src/desktop-provider/local-workspace-chrome-provider.js';
import {CreateOneKey,InspectKeyForm} from '../src/desktop-provider/hidden-chrome-rules.js';
import {candidateFromLiveTrace} from '../src/workflows/live-candidate.js';
import {KEY_MODEL_PREFIX,KEY_NAME_SELECTOR,KEY_SUBMIT_SELECTOR,KEY_TOKENS_SELECTOR} from '../src/desktop-provider/local-workspace-chrome-provider.js';
import {initialState} from '../src/graph/state.js';
import {SqliteTrace} from '../src/trace/sqlite-trace.js';

const live01Path=resolve('testbench/live-01/hidden-chrome.ts');
const live01Source=readFileSync(live01Path,'utf8');

test('production import graph no longer statically depends on the LIVE-01 experiment directory',()=>{
  const creation=readFileSync(resolve('src/desktop-provider/hidden-chrome-creation.ts'),'utf8');
  assert.ok(!creation.includes('testbench'),'hidden-chrome-creation.ts must not reference the testbench experiment directory');
  assert.match(creation,/import \{CreateOneKey\} from '\.\/hidden-chrome-rules\.js';/);
  assert.match(creation,/import \{candidateFromLiveTrace\} from '\.\.\/workflows\/live-candidate\.js';/);
  const walk=(directory:string):string[]=>readdirSync(directory,{withFileTypes:true}).flatMap(entry=>
    entry.isDirectory()?walk(join(directory,entry.name)):entry.name.endsWith('.ts')?[join(directory,entry.name)]:[]);
  for(const file of walk(resolve('src')))
    assert.ok(!readFileSync(file,'utf8').includes('testbench/live-01'),
      `production module ${file} must not statically import the LIVE-01 experiment directory`);
});

test('LIVE-01 rules and candidate generator keep exactly one implementation under src',()=>{
  assert.ok(!live01Source.includes('class InspectKeyForm')&&!live01Source.includes('class CreateOneKey'),
    'rule models must exist only in src/desktop-provider/hidden-chrome-rules.ts');
  assert.ok(!live01Source.includes('candidateFromLiveTrace(trace: TraceStore'),
    'candidate generator must exist only in src/workflows/live-candidate.ts');
  assert.ok(live01Source.includes("import { CreateOneKey, InspectKeyForm } from '../../src/desktop-provider/hidden-chrome-rules.js';"));
  assert.ok(live01Source.includes("import { candidateFromLiveTrace } from '../../src/workflows/live-candidate.js';"));
  assert.equal(existsSync(resolve('testbench/live-01/workflow-candidate.ts')),false,
    'the moved testbench copy must not remain beside the experiment entry');
});

test('testbench LIVE-01 keeps its independent CLI entry and importing it never runs main()',async()=>{
  assert.match(live01Source,/if \(process\.argv\[1\]\?\.endsWith\('hidden-chrome\.ts'\)\) await main\(\);/,
    'the explicit direct-execution guard must stay in front of main()');
  for(const guard of ['--live','LIVE01_CHROME_PATH','--create-one','--all-models','--max-output-tokens=40000','--other-defaults'])
    assert.ok(live01Source.includes(guard),`explicit authorization check ${guard} must stay in the CLI entry`);
  // If the module top level executed main(), this import would throw
  // 'Explicit --live on Windows required' instead of resolving.
  await import('../testbench/live-01/hidden-chrome.js');
});

const ruleDiscovery=(discovery:Partial<ChromeDiscovery>={})=>JSON.stringify({controls:[],fields:[],...discovery});
const ruleState=(pageText:string,history:ComputerState['recentHistory']=[],url='http://192.168.2.3:8102/'):ComputerState=>
  ({...initialState('synthetic-boundary-rule','synthetic rule state'),observation:{url,pageText},recentHistory:history});
const field=(field:Partial<ChromeDiscovery['fields'][number]>={}):ChromeDiscovery['fields'][number]=>
  ({tag:'input',type:'text',required:false,id:'synthetic',label:'合成',password:false,...field});

test('CreateOneKey keeps the fixed single-page decisions and refuses any second submit after an unknown result',async()=>{
  const model=new CreateOneKey('agent-desktop-hidden-chrome-20261013');
  assert.deepEqual(await model.decide(ruleState('{}',[],'about:blank')),{kind:'navigate',url:'http://192.168.2.3:8102/'});
  assert.match(((await model.decide(ruleState(ruleDiscovery({fields:[field({password:true})]})))) as {question:string}).question,/BLOCKED_LOGIN/);
  assert.match(((await model.decide(ruleState(ruleDiscovery(),[{step:1,action:{kind:'click',target:{kind:'selector',selector:'#new-api-key'}}}]))
    ) as {question:string}).question,/BLOCKED_PERMISSION/);
  assert.deepEqual(await model.decide(ruleState(ruleDiscovery({controls:[{role:'tab',name:'接入权限',id:'new-api-key',submit:false}]}),
    [{step:1,action:{kind:'click',target:{kind:'role',role:'tab',name:'接入权限'}}}])),
    {kind:'click',target:{kind:'selector',selector:'#new-api-key'}});
  assert.match(((await model.decide(ruleState(ruleDiscovery({controls:[{role:'tab',name:'接入权限',id:'new-api-key',submit:true}]}),
    [{step:1,action:{kind:'click',target:{kind:'role',role:'tab',name:'接入权限'}}}]))) as {question:string}).question,/BLOCKED_DISCOVERY/);
  assert.deepEqual(await model.decide(ruleState(ruleDiscovery({controls:[{role:'tab',name:'接入权限',submit:false}]}))),
    {kind:'click',target:{kind:'role',role:'tab',name:'接入权限'}});
  assert.match(((await model.decide(ruleState(ruleDiscovery({controls:[{role:'tab',name:'接入权限',submit:false},{role:'link',name:'接入权限',submit:false}]})))
    ) as {question:string}).question,/BLOCKED_DISCOVERY/);
  assert.equal((await model.decide(ruleState(ruleDiscovery({apiKeyGenerated:true})))).kind,'done');
  assert.deepEqual(await model.decide(ruleState(ruleDiscovery({fields:[field({fieldName:'max_output_tokens'}),field({fieldName:'name',value:'SYNTHETIC_OTHER'})]}))),
    {kind:'type',target:{kind:'selector',selector:KEY_NAME_SELECTOR},text:'agent-desktop-hidden-chrome-20261013'});
  assert.deepEqual(await model.decide(ruleState(ruleDiscovery({fields:[field({fieldName:'max_output_tokens',value:'1024'}),field({fieldName:'name',value:'agent-desktop-hidden-chrome-20261013'})]}))),
    {kind:'type',target:{kind:'selector',selector:KEY_TOKENS_SELECTOR},text:'40000'});
  assert.deepEqual(await model.decide(ruleState(ruleDiscovery({fields:[field({fieldName:'max_output_tokens',value:'40000'}),
    field({fieldName:'name',value:'agent-desktop-hidden-chrome-20261013'}),field({fieldName:'allowed_models',checked:false,modelIndex:3})]}))),
    {kind:'set_checked',target:{kind:'selector',selector:KEY_MODEL_PREFIX+'3'},checked:true});
  const ready=ruleState(ruleDiscovery({fields:[field({fieldName:'max_output_tokens',value:'40000'}),
    field({fieldName:'name',value:'agent-desktop-hidden-chrome-20261013'}),field({fieldName:'allowed_models',checked:true,modelIndex:3})]}));
  assert.deepEqual(await model.decide(ready),{kind:'click',target:{kind:'selector',selector:KEY_SUBMIT_SELECTOR}});
  // One creation already dispatched with an unconfirmed result: the rule must ask,
  // never re-submit, and stay stable across repeated decisions.
  const dispatched=ruleState(ruleDiscovery({fields:[field({fieldName:'max_output_tokens',value:'40000'}),
    field({fieldName:'name',value:'agent-desktop-hidden-chrome-20261013'}),field({fieldName:'allowed_models',checked:true,modelIndex:3})]}),
    [{step:5,action:{kind:'click',target:{kind:'selector',selector:KEY_SUBMIT_SELECTOR}}}]);
  for(let attempt=0;attempt<3;attempt++)
    assert.match(((await model.decide(dispatched)) as {question:string}).question,/UNKNOWN_CREATE_RESULT: 已发出一次创建，结果尚未确认；禁止再次提交。/);
  assert.equal(new InspectKeyForm().kind,'rule');
  // The default fixed name stays available for the experiment CLI.
  assert.equal((await new CreateOneKey().decide(ruleState(ruleDiscovery({fields:[field({fieldName:'max_output_tokens'}),field({fieldName:'name',value:'SYNTHETIC_OTHER'})]}))) as {text:string}).text,
    'agent-desktop-hidden-chrome-20261009');
});

const goal='创建一个 agent-desktop-hidden-chrome-20261013 API Key，全部模型、max_output_tokens 40000、其它默认；保存完整 Key 到当前用户桌面 AgentDesktop_8102_API_Key.txt';
const criteria={urlIncludes:'http://192.168.2.3:8102/',pageTextIncludes:'"apiKeyGenerated":true'};
const fileSnapshot={path:'AgentDesktop_8102_API_Key.txt',root:'C:\\Users\\synthetic',capturedAt:0,exists:true,complete:true};
const navigate:ComputerAction={kind:'navigate',url:'http://192.168.2.3:8102/'};
const accessTab:ComputerAction={kind:'click',target:{kind:'role',role:'tab',name:'接入权限'}};
const typeName:ComputerAction={kind:'type',target:{kind:'selector',selector:KEY_NAME_SELECTOR},text:'agent-desktop-hidden-chrome-20261013'};
const typeTokens:ComputerAction={kind:'type',target:{kind:'selector',selector:KEY_TOKENS_SELECTOR},text:'40000'};
const setModel:ComputerAction={kind:'set_checked',target:{kind:'selector',selector:KEY_MODEL_PREFIX+'3'},checked:true};
const submit:ComputerAction={kind:'click',target:{kind:'selector',selector:KEY_SUBMIT_SELECTOR}};
const defaultSteps:Array<{action:ComputerAction;verified?:boolean}>=
  [{action:navigate},{action:accessTab},{action:typeName},{action:typeTokens},{action:setModel},{action:submit}];

function writeTrace(options:{steps?:Array<{action:ComputerAction;verified?:boolean}>;final?:Partial<ComputerState>}={}) {
  const directory=mkdtempSync(join(tmpdir(),'live-candidate-')),trace=new SqliteTrace(join(directory,'task.sqlite'));
  const base={...initialState('synthetic-boundary-candidate',goal,undefined,criteria)};
  for(const [index,spec] of (options.steps??defaultSteps).entries()) {
    const step=index+1;
    trace.save('execute',{...base,step,lastResult:{ok:true,message:'synthetic executed'},groundedAction:spec.action,lastAction:spec.action});
    if(spec.verified!==false)trace.save('verify',{...base,step,lastVerification:{ok:true,message:'synthetic verified'}});
  }
  trace.save('acceptance',{...base,executorId:'live-01-hidden-chrome',status:'done',
    goalVerification:{ok:true,message:'synthetic goal verified'},
    acceptanceReport:{mode:'assist',verdict:'pass',observationId:'synthetic',checks:[],message:'synthetic acceptance'},
    verifiedFiles:[{taskId:'synthetic-boundary-candidate',step:9,expected:{kind:'desktop_file',path:'AgentDesktop_8102_API_Key.txt'},before:fileSnapshot,after:fileSnapshot}],
    completionCriteria:criteria,...options.final});
  return {trace,directory};
}

test('candidateFromLiveTrace keeps the curated candidate fields and parameterization',()=>{
  const {trace,directory}=writeTrace();
  try {
    const candidate=candidateFromLiveTrace(trace,'synthetic-boundary-candidate',join(directory,'task.sqlite'));
    assert.equal(candidate.status,'candidate');assert.equal(candidate.version,1);
    assert.equal(candidate.workflowSchemaVersion,2);assert.equal(candidate.environment,'browser');
    assert.equal(candidate.sourceTaskId,'synthetic-boundary-candidate');
    assert.equal(candidate.sourceTrace,join(directory,'task.sqlite'));
    assert.equal(candidate.steps.length,6);
    assert.deepEqual(candidate.steps[0],{stepId:'live-1',goal:'navigate',action:navigate,preferredMethods:['owned-chrome-cdp'],
      successCondition:{kind:'url_includes',value:'/'},idempotent:true});
    assert.deepEqual(candidate.steps[1],{stepId:'live-2',goal:'click',action:accessTab,preferredMethods:['owned-chrome-cdp'],
      targetHint:{kind:'role',role:'tab',name:'接入权限'},semanticTarget:{label:'接入权限',role:'tab'},
      successCondition:{kind:'state_changed'},idempotent:true});
    assert.equal(candidate.steps[2]!.action.kind,'type');
    if(candidate.steps[2]!.action.kind==='type')assert.equal(candidate.steps[2]!.action.text,'{{keyName}}');
    assert.deepEqual(candidate.steps[2]!.successCondition,{kind:'text_includes',value:'{{keyName}}'});
    if(candidate.steps[3]!.action.kind==='type')assert.equal(candidate.steps[3]!.action.text,'{{maxOutputTokens}}');
    const submitStep=candidate.steps[5]!;
    assert.equal(submitStep.goal,'一次性创建并私下保存 Key');
    assert.equal(submitStep.idempotent,false);
    assert.deepEqual(submitStep.successCondition,{kind:'text_includes',value:'"apiKeyGenerated":true'});
    assert.deepEqual(submitStep.targetHint,{kind:'selector',selector:KEY_SUBMIT_SELECTOR});
    // A raw DOM selector carries no cross-runtime semantic meaning (unchanged).
    assert.equal(submitStep.semanticTarget,undefined);
    assert.deepEqual(candidate.inputs.map(input=>input.name),['keyName','maxOutputTokens']);
    assert.deepEqual(candidate.inputs[0]!.boundTo,{stepId:'live-3',argument:'text'});
    assert.ok(candidate.taskPattern.includes('{{keyName}}')&&candidate.taskPattern.includes('{{maxOutputTokens}}'));
    assert.ok(!candidate.taskPattern.includes('agent-desktop-hidden-chrome-20261013'));
    assert.deepEqual(candidate.successConditions,criteria);
    assert.deepEqual(candidate.knownFailures,['规则驱动的真实 UI 轨迹；未调用模型，未触发核心模型驱动蒸馏或自动发布。']);
    assert.ok(!JSON.stringify(candidate).includes('SYNTHETIC'));
  }finally{trace.close();rmSync(directory,{recursive:true,force:true});}
});

test('candidateFromLiveTrace still rejects traces without independent acceptance or a single verified creation boundary',()=>{
  const finals:Array<[string,Partial<ComputerState>]>=[
    ['executorId',{executorId:'synthetic-other-executor'}],
    ['terminal status',{status:'failed'}],
    ['goal verification',{goalVerification:{ok:false,message:'unverified'}}],
    ['acceptance verdict',{acceptanceReport:{mode:'assist',verdict:'unknown',observationId:'synthetic',checks:[],message:'unconfirmed acceptance'}}],
    ['verified files',{verifiedFiles:[]}],
    ['completion criteria',{completionCriteria:undefined}],
  ];
  for(const [name,final] of finals) {
    const {trace,directory}=writeTrace({final});
    try {assert.throws(()=>candidateFromLiveTrace(trace,'synthetic-boundary-candidate',join(directory,'task.sqlite')),
      /Live candidate requires independent task and file acceptance/,name);}
    finally{trace.close();rmSync(directory,{recursive:true,force:true});}
  }
  const cases:Array<[string,{steps:Array<{action:ComputerAction;verified?:boolean}>}]>=[
    ['action without verification',{steps:defaultSteps.map(spec=>({...spec,verified:false}))}],
    ['unstable coordinate target',{steps:[{action:navigate},{action:accessTab},{action:typeName},{action:typeTokens},{action:setModel},
      {action:{kind:'click',target:{kind:'coordinate',x:1,y:2}}}]}],
    ['two creation submits',{steps:[...defaultSteps,{action:submit}]}],
    ['no creation submit',{steps:defaultSteps.slice(0,5)}],
  ];
  for(const [name,options] of cases) {
    const {trace,directory}=writeTrace(options);
    try {assert.throws(()=>candidateFromLiveTrace(trace,'synthetic-boundary-candidate',join(directory,'task.sqlite')),
      /Live candidate (action lacks verification|requires a stable semantic\/DOM target|must have one verified creation boundary)/,name);}
    finally{trace.close();rmSync(directory,{recursive:true,force:true});}
  }
});
