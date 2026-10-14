import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Command,MemorySaver} from '@langchain/langgraph';
import {FakeModel} from '../src/agent/model-adapter.js';
import type {ComputerAction,Observation} from '../src/actions/schema.js';
import {createAgentLoop} from '../src/graph/graph.js';
import {initialState,type ComputerState} from '../src/graph/state.js';
import {continuePausedTask} from '../src/graph/resume.js';
import {FakeRuntime} from '../src/runtime/runtime-adapter.js';
import {createTaskBudget,meteredModelRequest,runWithTaskBudget} from '../src/runtime/model-budget.js';
import {SqliteTrace} from '../src/trace/sqlite-trace.js';

import {actionIsRisky,impactFingerprint,observationSignature,focusLost,riskDecision} from '../src/graph/guards.js';

const traceGoldens:string[]=[];
const observation:Observation={url:'https://example.test/current',dom:'<main>before</main>',accessibility:'before'};
const signature=createHash('sha256').update(JSON.stringify({url:observation.url,
  dom:observation.dom,accessibility:observation.accessibility})).digest('hex');
const click=(name:string,role='button'):ComputerAction=>({kind:'click',target:{kind:'role',role,name}});
const pay=click('Pay now'),ordinary=click('Continue'),other=click('Back');
type RiskCase={name:string;action:ComputerAction;gate:'allow'|'risky'|'duplicate'|'approved';seed?:Partial<ComputerState>};
const approval={approvedActionFingerprint:JSON.stringify(pay),approvalContextUrl:observation.url,
  approvalContextSignature:signature};
const cases:RiskCase[]=[
  {name:'risky button',action:pay,gate:'risky'},
  {name:'risky checkbox',action:click('删除','checkbox'),gate:'risky'},
  {name:'ordinary button',action:ordinary,gate:'allow'},
  {name:'risky words on role link',action:click('Buy and delete','link'),gate:'allow'},
  {name:'double click link',action:{kind:'double_click',target:{kind:'role',role:'link',name:'提交'}},gate:'allow'},
  {name:'text link has no role exception',action:{kind:'click',target:{kind:'text',text:'submit'}},gate:'risky'},
  {name:'risky drag destination',action:{kind:'drag',source:{kind:'text',text:'item'},destination:{kind:'text',text:'delete'}},gate:'risky'},
  {name:'risky drag source only',action:{kind:'drag',source:{kind:'text',text:'delete'},destination:{kind:'text',text:'item'}},gate:'allow'},
  {name:'duplicate risk precedes high risk',action:pay,gate:'duplicate',seed:{executedImpactActions:[JSON.stringify(pay)]}},
  {name:'duplicate ordinary',action:ordinary,gate:'duplicate',seed:{executedImpactActions:[JSON.stringify(ordinary)]}},
  {name:'duplicate Enter',action:{kind:'keypress',keys:'Enter'},gate:'duplicate',seed:{executedImpactActions:[JSON.stringify({kind:'keypress',keys:'Enter'})]}},
  {name:'duplicate Return',action:{kind:'keypress',keys:'return'},gate:'duplicate',seed:{executedImpactActions:[JSON.stringify({kind:'keypress',keys:'return'})]}},
  {name:'Space has no impact',action:{kind:'keypress',keys:'Space'},gate:'allow',seed:{executedImpactActions:[JSON.stringify({kind:'keypress',keys:'Space'})]}},
  {name:'exact approval',action:pay,gate:'approved',seed:approval},
  {name:'approved duplicate',action:pay,gate:'approved',seed:{...approval,executedImpactActions:[JSON.stringify(pay)]}},
  {name:'old URL approval',action:pay,gate:'risky',seed:{...approval,approvalContextUrl:'https://example.test/old'}},
  {name:'signature drift approval',action:pay,gate:'risky',seed:{...approval,approvalContextSignature:'old'}},
  {name:'different action approval',action:pay,gate:'risky',seed:{...approval,approvedActionFingerprint:JSON.stringify(ordinary)}},
  {name:'stale approval duplicate retains fields',action:pay,gate:'duplicate',seed:{...approval,approvalContextSignature:'old',executedImpactActions:[JSON.stringify(pay)]}},
  {name:'different verified impact resets duplicate',action:ordinary,gate:'allow',seed:{
    executedImpactActions:[JSON.stringify(ordinary)],recentHistory:[{step:0,action:other,verification:{ok:true,message:'changed'}}]}},
  {name:'different unverified impact keeps duplicate',action:ordinary,gate:'duplicate',seed:{
    executedImpactActions:[JSON.stringify(ordinary)],recentHistory:[{step:0,action:other,verification:{ok:false,message:'unchanged'}}]}},
  {name:'same verified impact keeps duplicate',action:ordinary,gate:'duplicate',seed:{
    executedImpactActions:[JSON.stringify(ordinary)],recentHistory:[{step:0,action:ordinary,verification:{ok:true,message:'changed'}}]}},
  {name:'non impact history does not hide prior impact',action:ordinary,gate:'allow',seed:{
    executedImpactActions:[JSON.stringify(ordinary)],recentHistory:[{step:0,action:other,verification:{ok:true,message:'changed'}},
      {step:1,action:{kind:'keypress',keys:'Space'},verification:{ok:false,message:'unchanged'}}]}},
];
async function fixture(run:(trace:SqliteTrace,dir:string)=>Promise<void>){
  const dir=mkdtempSync(join(tmpdir(),'u9a-golden-')),trace=new SqliteTrace(join(dir,'trace.sqlite'));
  try{await run(trace,dir);
    // Compare every persisted state and event order; wall-clock fields are not policy inputs.
    const states=['risk','human','pause','budget','limit','unknown'].flatMap(id=>trace.events(id)
      // U9b adds exactly one terminal event to the two no-checkpointer pause cases.
      // Keep the original U9a digest for their unchanged prefix and every other scenario.
      .filter(({node})=>!(id==="pause" && node==="pause_interrupt"))
      .map(({node,state})=>({node,state})));
    const stable=JSON.stringify(states,(key,value)=>key==='frozenAt'?'<clock>':value);
    traceGoldens.push(createHash('sha256').update(stable).digest('hex'));
  }finally{trace.close();rmSync(dir,{recursive:true,force:true});}
}

for(const row of cases)test('U9a golden risk: '+row.name,()=>fixture(async trace=>{
  const runtime=new FakeRuntime();
  runtime.observe=async()=>observation;
  // Resume a frozen pending action to exercise history and approval without decide clearing them.
  const state={...initialState('risk','synthetic goal'),step:1,lastAction:row.action,
    resumePendingAction:true,...row.seed};
  const before=structuredClone(state);
  const result=await createAgentLoop({runtime,trace,model:new FakeModel([]),maxSteps:1}).invoke(state);
  assert.deepEqual(state,before);
  const events=trace.events('risk'),risk=events.find(e=>e.node==='risk_check')!.state;
  const ask=row.gate==='risky'||row.gate==='duplicate';
  assert.deepEqual(events.map(e=>e.node),ask
    ? ['observe','ground','resolve_action','risk_check','human_interrupt']
    : ['observe','ground','resolve_action','risk_check','execute','observe','verify','recover','observe','decide','finish']);
  assert.equal(risk.status,ask?'waiting_user':'running');
  assert.equal(risk.error,row.gate==='duplicate'?'重复执行可能产生副作用，需人工处理':
    row.gate==='risky'?'高风险动作需要人工确认':undefined);
  assert.equal(risk.approvedActionFingerprint,row.gate==='duplicate'||row.gate==='allow'
    ? row.seed?.approvedActionFingerprint:undefined);
  assert.equal(risk.resumePendingAction,row.gate==='duplicate');
  assert.equal(risk.approvalContextUrl,ask?observation.url:row.seed?.approvalContextUrl);
  assert.equal(risk.approvalContextSignature,ask?signature:row.seed?.approvalContextSignature);
  assert.deepEqual(risk.executedImpactActions,state.executedImpactActions);
  assert.deepEqual(risk.lastAction,row.action);
  assert.deepEqual(risk.observation,observation);
  assert.deepEqual(runtime.executed,ask?[]:[row.action]);
  assert.equal(result.status,ask?'waiting_user':'failed');
  assert.equal(result.error,ask?risk.error:'已达到整任务动作上限');
  assert.deepEqual(trace.load('risk'),JSON.parse(JSON.stringify(result)));
}));

for(const approved of [true,false])test('U9a golden human resume approved='+approved,()=>fixture(async trace=>{
  const runtime=new FakeRuntime();runtime.observe=async()=>observation;
  const graph=createAgentLoop({runtime,trace,model:new FakeModel([pay]),checkpointer:new MemorySaver(),maxSteps:1});
  const config={configurable:{thread_id:'human'}};
  await graph.invoke(initialState('human','synthetic goal'),config);
  assert.equal(runtime.executed.length,0);
  assert.equal(trace.load('human')?.status,'waiting_user');
  const result=await graph.invoke(new Command({resume:{approved}}),config);
  assert.deepEqual(trace.events('human').map(e=>e.node),approved
    ? ['observe','decide','ground','resolve_action','risk_check','human_interrupt','observe','ground','resolve_action',
      'risk_check','execute','observe','verify','recover','observe','decide','finish']
    : ['observe','decide','ground','resolve_action','risk_check','human_interrupt','finish']);
  assert.equal(runtime.executed.length,approved?1:0);
  assert.equal(result.error,approved?'已达到整任务动作上限':'用户拒绝执行高风险动作');
  if(approved){const risk=trace.events('human').filter(e=>e.node==='risk_check').at(-1)!.state;
    assert.equal(risk.approvedActionFingerprint,undefined);assert.equal(risk.resumePendingAction,false);}
}));

for(const boundary of ['pause_check','pause_before_execute'] as const)
for(const checkpoint of [false,true])test('U9a golden pause '+boundary+' checkpoint='+checkpoint,()=>fixture(async trace=>{
  let calls=0;
  const runtime=new FakeRuntime();runtime.observe=async()=>observation;
  const graph=createAgentLoop({runtime,trace,model:new FakeModel([ordinary]),maxSteps:1,
    ...(checkpoint?{checkpointer:new MemorySaver()}:{}),pauseRequested:()=>++calls===(boundary==='pause_check'?1:2)});
  const config={configurable:{thread_id:'pause'}};
  const invoke=()=>graph.invoke(initialState('pause','synthetic goal'),config);
  const result=await invoke();
  const saved=trace.events("pause").find(e=>e.node===boundary)!.state;
  assert.equal(saved.status,'paused');assert.equal(saved.summary,boundary==='pause_check'?'已在安全边界暂停':'动作尚未发出，已暂停');
  assert.equal(saved.error,undefined);assert.equal(calls,boundary==='pause_check'?1:2);
  assert.equal(runtime.executed.length,0);
  const prefix=boundary==="pause_check"?["observe","pause_check"]:
    ["observe","decide","ground","resolve_action","pause_before_execute"];
  assert.deepEqual(trace.events("pause").map(e=>e.node),[...prefix,...(checkpoint?[]:["pause_interrupt"])]);
  if(checkpoint)assert.equal(result.status,"paused");
  else assert.deepEqual(trace.load("pause"),{...saved,status:"failed",
    error:`${saved.summary}；未配置 Checkpointer，无法安全继续；任务已终止`,
    summary:"未配置 Checkpointer，已安全终止；不能继续此任务"});
}));

for(const boundary of ['pause_check','pause_before_execute'] as const)
test('U9a golden budget short circuits human pause at '+boundary,()=>fixture(async(trace,dir)=>{
  createTaskBudget(dir,'budget',{deepseek:{maxCalls:1}});
  let calls=0,decisions=0;
  const consume=()=>meteredModelRequest('deepseek',async()=>({usage:{total_tokens:3}}));
  const runtime=new FakeRuntime();runtime.observe=async()=>observation;
  const graph=createAgentLoop({runtime,trace,checkpointer:new MemorySaver(),pauseRequested:()=>{calls++;return false;},
    model:{decide:async()=>{decisions++;await consume();return ordinary;}}});
  await runWithTaskBudget(dir,'budget',async()=>{
    if(boundary==='pause_check')await consume();
    await graph.invoke(initialState('budget','synthetic goal'),{configurable:{thread_id:'budget'}});
  });
  assert.equal(trace.load('budget')?.status,'paused');
  assert.equal(runtime.executed.length,0);
  assert.equal(calls,boundary==='pause_check'?0:1);
  assert.equal(decisions,boundary==='pause_check'?0:1);
  assert.equal(trace.events('budget').at(-1)?.node,boundary);
  assert.match(trace.load('budget')?.error??'',/deepseek 预算已用尽/);
}));

for(const limit of ['failed','task','stage'] as const)test('U9a golden decide limit '+limit,()=>fixture(async trace=>{
  let decisions=0;const runtime=new FakeRuntime();runtime.observe=async()=>observation;
  const state={...initialState('limit','synthetic goal'),...(limit==='failed'?{status:'failed' as const,error:'terminal contradiction'}:{}),
    ...(limit==='task'?{step:1}:{}),
    ...(limit==='stage'?{stage:{id:'s',goal:'s',successCondition:'s',startedAtStep:0,actionCount:24,planVersion:1,isFinal:false}}:{})};
  const result=await createAgentLoop({runtime,trace,maxSteps:1,model:{decide:async()=>{decisions++;return ordinary;}}}).invoke(state);
  assert.equal(decisions,0);assert.equal(runtime.executed.length,0);assert.equal(result.status,'failed');
  assert.equal(result.error,limit==='failed'?'terminal contradiction':limit==='task'?'已达到整任务动作上限':'已达到当前阶段动作上限');
}));

test('U9a golden unknown dispatch resume never resends',()=>fixture(async trace=>{
  const runtime=new FakeRuntime();runtime.observe=async()=>observation;
  runtime.execute=async action=>{runtime.executed.push(action);return {ok:false,effect:'uncertain',message:'response lost'};};
  const graph=createAgentLoop({runtime,trace,model:new FakeModel([ordinary]),checkpointer:new MemorySaver(),recoveryJournal:true});
  await graph.invoke(initialState('unknown','synthetic goal'),{configurable:{thread_id:'unknown'}});
  assert.equal(trace.load('unknown')?.recoveryUncertain,true);
  assert.equal(trace.load('unknown')?.status,'paused');
  await continuePausedTask(graph,'unknown');
  assert.equal(trace.load('unknown')?.status,'waiting_user');
  assert.equal(runtime.executed.length,1);
  assert.deepEqual(trace.events('unknown').map(e=>e.node),['observe','decide','ground','resolve_action','risk_check',
    'dispatch_pending','execute','continue','observe','resume_reconcile']);
}));

test('U9a golden complete persisted Trace states',()=>{
  // Frozen on main@62c95ab before extraction. Explicit field assertions above make failures readable.
  assert.equal(traceGoldens.length,35);
  assert.equal(createHash('sha256').update(JSON.stringify(traceGoldens)).digest('hex'),
    '1936f41e6e820f37553572941301ef57cb7a46b250f59dd263180bc0ac68bb15');
});

for(const row of cases)test('U9a pure risk decision: '+row.name,()=>{
  const state={...initialState('pure','synthetic goal'),lastAction:row.action,observation,...row.seed};
  const before=structuredClone(state);
  assert.equal(riskDecision(state),row.gate);
  assert.deepEqual(state,before);
});
test('U9a pure predicates retain original risk, impact, signature and focus semantics',()=>{
  assert.equal(riskDecision(initialState('empty','goal')),'allow');
  for(const [action,expected] of [[pay,true],[ordinary,false],[click('buy','link'),false],
    [{kind:'type',target:{kind:'text',text:'submit'},text:'delete'},false]] as const)
    assert.equal(actionIsRisky(action),expected);
  for(const action of [pay,{kind:'double_click',target:{kind:'text',text:'x'}},
    {kind:'drag',source:{kind:'text',text:'a'},destination:{kind:'text',text:'b'}},
    {kind:'keypress',keys:'ENTER'},{kind:'keypress',keys:'Return'}] satisfies ComputerAction[])
    assert.equal(impactFingerprint(action),JSON.stringify(action));
  for(const action of [{kind:'keypress',keys:'Ctrl+Enter'},{kind:'keypress',keys:'Space'},
    {kind:'navigate',url:'https://example.test'},{kind:'done',summary:'x'}] satisfies ComputerAction[])
    assert.equal(impactFingerprint(action),undefined);
  assert.equal(observationSignature(undefined),undefined);
  assert.equal(observationSignature(observation),signature);
  assert.equal(observationSignature({...observation,pageText:'ignored',screenshotHash:'ignored'}),signature);
  for(const delta of [{url:'old'},{dom:'changed'},{accessibility:'changed'}])
    assert.notEqual(observationSignature({...observation,...delta}),signature);
  for(const error of ['目标窗口不在前台','目标窗口前台不可用','Window is not FOREGROUND'])
    assert.equal(focusLost({error}),true);
  assert.equal(focusLost({}),false);assert.equal(focusLost({error:'worker unavailable'}),false);
});
