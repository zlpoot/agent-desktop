import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {MemorySaver} from '@langchain/langgraph';
import {FakeModel} from '../src/agent/model-adapter.js';
import type {ComputerAction} from '../src/actions/schema.js';
import {createAgentLoop} from '../src/graph/graph.js';
import {continuePausedTask,resumeSavedTask} from '../src/graph/resume.js';
import {initialState,type ComputerState} from '../src/graph/state.js';
import {FakeRuntime} from '../src/runtime/runtime-adapter.js';
import {createTaskBudget,meteredModelRequest,runWithTaskBudget} from '../src/runtime/model-budget.js';
import {SqliteTrace} from '../src/trace/sqlite-trace.js';

async function fixture(run:(trace:SqliteTrace,dir:string)=>Promise<void>){
  const dir=mkdtempSync(join(tmpdir(),'u9b-pause-')),trace=new SqliteTrace(join(dir,'trace.sqlite'));
  try{await run(trace,dir);}finally{trace.close();rmSync(dir,{recursive:true,force:true});}
}
const action:ComputerAction={kind:'click',target:{kind:'text',text:'Continue'}};
const boundaryCases=[
  {kind:'human-observe',node:'pause_check',calls:1,decisions:0,nodes:['observe','pause_check']},
  {kind:'human-execute',node:'pause_before_execute',calls:2,decisions:1,nodes:['observe','decide','ground','resolve_action','pause_before_execute']},
  {kind:'human-stage',node:'stage_plan',calls:2,decisions:0,nodes:['observe','stage_plan']},
  {kind:'budget-observe',node:'pause_check',calls:0,decisions:0,nodes:['observe','pause_check']},
  {kind:'budget-execute',node:'pause_before_execute',calls:1,decisions:1,nodes:['observe','decide','ground','resolve_action','pause_before_execute']},
  {kind:'budget-decide',node:'budget_pause',calls:1,decisions:1,nodes:['observe','budget_pause']},
  {kind:'budget-stage',node:'budget_pause',calls:2,decisions:0,nodes:['observe','budget_pause']},
] as const;

for(const row of boundaryCases)for(const checkpoint of [false,true])
test('U9b pause '+row.kind+' checkpoint='+checkpoint,()=>fixture(async(trace,dir)=>{
  let calls=0,decisions=0,plans=0;
  const runtime=new FakeRuntime();
  const model=new FakeModel([action]);
  const consume=()=>meteredModelRequest('deepseek',async()=>({usage:{total_tokens:3}}));
  const originalDecide=model.decide.bind(model);
  model.decide=async state=>{
    decisions++;
    if(row.kind==='budget-execute'||row.kind==='budget-decide')await consume();
    if(row.kind==='budget-decide')await consume(); // Real budget refusal, no external model.
    return originalDecide(state);
  };
  const graph=createAgentLoop({runtime,trace,
    model:{...model,decide:model.decide,planStage:async()=>{
      plans++;if(row.kind==='budget-stage'){await consume();await consume();}
      throw Error('stage planning must not dispatch');
    }},
    ...(checkpoint?{checkpointer:new MemorySaver()}:{}),
    pauseRequested:()=>{
      calls++;
      return row.kind==='human-observe'?calls===1:
        row.kind==='human-execute'||row.kind==='human-stage'?calls===2:false;
    }});
  const state={...initialState('pause','synthetic goal'),
    ...(row.kind.endsWith('stage')?{taskContract:{target:'synthetic target',constraint:'',
      taskActionLimit:4,stageActionLimit:4}}:{})};
  const config={configurable:{thread_id:'pause'}};
  let result!:ComputerState;
  const invoke=async()=>{
    if(row.kind==='budget-observe')await consume();
    try{result=await graph.invoke(state,config);}
    catch(error){
      // Captures the original exact symptom and persisted final state on the RED commit.
      assert.equal(trace.load('pause')?.status,'paused');
      assert.equal(runtime.executed.length,0);
      console.error('U9B_RED '+JSON.stringify({kind:row.kind,checkpoint,
        error:String(error),code:(error as {lc_error_code?:string}).lc_error_code,
        finalTraceStatus:trace.load('pause')?.status,nodes:trace.events('pause').map(e=>e.node),dispatch:runtime.executed.length}));
      throw error;
    }
  };
  if(row.kind.startsWith('budget')){createTaskBudget(dir,'pause',{deepseek:{maxCalls:1}});await runWithTaskBudget(dir,'pause',invoke);}
  else await invoke();
  const events=trace.events('pause'),gate=events.find(e=>e.node===row.node)!.state;
  assert.equal(gate.status,'paused');
  assert.equal(calls,row.calls);assert.equal(decisions,row.decisions);
  assert.equal(plans,row.kind==='budget-stage'?1:0);
  assert.equal(runtime.executed.length,0);
  assert.deepEqual(events.map(e=>e.node),checkpoint?[...row.nodes]:[...row.nodes,'pause_interrupt']);
  assert.equal(result.status,checkpoint?'paused':'failed');
  assert.deepEqual(trace.load('pause'),JSON.parse(JSON.stringify(result,(key,value)=>key==='__interrupt__'?undefined:value)));
  if(checkpoint){
    assert.equal(result.summary,gate.summary);assert.equal(result.error,gate.error);
    assert.ok((await graph.getState(config)).tasks.some(task=>task.interrupts?.length));
  }else{
    assert.match(result.error??'',/未配置 Checkpointer/);
    assert.ok(result.error?.includes(gate.error??gate.summary!));
    assert.equal(result.summary,'未配置 Checkpointer，已安全终止；不能继续此任务');
    const saved=structuredClone(trace.load('pause'));
    await assert.rejects(continuePausedTask(graph,'pause',undefined,runtime),/checkpointer/i);
    await assert.rejects(resumeSavedTask(graph,runtime,'pause',{approved:true}),/checkpointer/i);
    // A Trace JSON row does not create a checkpoint, even in a new graph with a saver.
    const empty=createAgentLoop({runtime,trace,model:new FakeModel([]),checkpointer:new MemorySaver()});
    await assert.rejects(continuePausedTask(empty,'pause'),/未处于可继续的暂停状态/);
    assert.equal(runtime.executed.length,0);assert.deepEqual(trace.load('pause'),saved);
  }
}));

for(const checkpoint of [false,true])test('U9b unknown effect checkpoint='+checkpoint,()=>fixture(async trace=>{
  const runtime=new FakeRuntime();
  runtime.execute=async sent=>{runtime.executed.push(sent);return {ok:false,message:'response lost',effect:'uncertain'};};
  const graph=createAgentLoop({runtime,trace,model:new FakeModel([action]),recoveryJournal:true,
    ...(checkpoint?{checkpointer:new MemorySaver()}: {})});
  const result=await graph.invoke(initialState('unknown','synthetic goal'),{configurable:{thread_id:'unknown'}});
  assert.equal(result.status,checkpoint?'paused':'failed');
  assert.equal(result.recoveryUncertain,true);assert.equal(result.recoveryRequired,true);
  assert.equal(result.verificationPending,true);assert.deepEqual(result.lastResult,{ok:false,message:'response lost',effect:'uncertain'});
  assert.deepEqual(result.executedImpactActions,[JSON.stringify(action)]);
  assert.equal(runtime.executed.length,1);
  assert.deepEqual(trace.events('unknown').map(e=>e.node),['observe','decide','ground','resolve_action','risk_check',
    'dispatch_pending','execute',...(checkpoint?[]:['pause_interrupt'])]);
  if(checkpoint){
    await continuePausedTask(graph,'unknown');
    assert.equal(trace.load('unknown')?.status,'waiting_user');
    assert.equal(trace.load('unknown')?.recoveryUncertain,true);
  }else{
    await assert.rejects(continuePausedTask(graph,'unknown'),/checkpointer/i);
    assert.match(result.error??'',/response lost/);
  }
  assert.equal(runtime.executed.length,1);
}));

for(const boundary of ['pause_check','pause_before_execute','stage_plan'] as const)
test('U9b native checkpoint continues after '+boundary,()=>fixture(async trace=>{
  let calls=0;
  const runtime=new FakeRuntime();
  // Fresh observation after continue independently proves completion, so the frozen action is never sent.
  let complete=false,observations=0;
  runtime.observe=async()=>{observations++;return {pageText:complete?'human completed':'before'};};
  const model=new FakeModel([action]);
  const state={...initialState('resume','synthetic goal',undefined,{pageTextIncludes:'human completed'}),
    ...(boundary==='stage_plan'?{taskContract:{target:'synthetic target',constraint:'',taskActionLimit:4,stageActionLimit:4}}:{})};
  const graph=createAgentLoop({runtime,trace,model:{decide:model.decide.bind(model),
    planStage:async()=>({goal:'synthetic target',successCondition:'human completed',isFinal:true}),
    verifyStage:async()=>({ok:true,confidence:1,evidence:'human completed',source:'dom'})},checkpointer:new MemorySaver(),
    pauseRequested:()=>++calls===(boundary==='pause_check'?1:2)});
  await graph.invoke(state,{configurable:{thread_id:'resume'}});
  assert.equal(trace.load('resume')?.status,'paused');assert.equal(runtime.executed.length,0);
  complete=true;
  const result=await continuePausedTask(graph,'resume');
  // The existing final stage contract still requires stronger evidence and remains waiting_user.
  assert.equal(result.status,boundary==='stage_plan'?'waiting_user':'done');
  assert.equal(runtime.executed.length,0);assert.equal(observations,2);
  const nodes=trace.events('resume').map(e=>e.node);
  assert.ok(nodes.includes('continue'));
  assert.ok(nodes.includes(boundary==='stage_plan'?'stage_plan':'resume_reconcile'));
}));

test('U9b no checkpoint with no pause still completes normally',()=>fixture(async trace=>{
  const runtime=new FakeRuntime();
  const graph=createAgentLoop({runtime,trace,model:new FakeModel([{kind:'navigate',url:'https://example.test'},
    {kind:'done',summary:'opened'}]),pauseRequested:()=>false});
  const result=await graph.invoke(initialState('normal','synthetic goal',undefined,{urlIncludes:'https://example.test'}));
  assert.equal(result.status,'done');assert.equal(runtime.executed.length,1);
  assert.ok(!trace.events('normal').some(e=>e.node==='pause_interrupt'));
}));
