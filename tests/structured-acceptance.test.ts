import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve as resolvePath} from 'node:path';
import {HybridVerifier,deterministicChecks} from '../src/verifier/hybrid-verifier.js';
import type {AcceptanceVerifier} from '../src/verifier/hybrid-verifier.js';
import {verifyGoal} from '../src/verifier/verifier.js';
import {parseTaskPlan} from '../src/agent/task-planner.js';
import {taskEvidenceInput} from '../src/verification/task-evidence.js';
import {createAgentLoop} from '../src/graph/graph.js';
import {initialState} from '../src/graph/state.js';
import {FakeModel} from '../src/agent/model-adapter.js';
import type {ModelAdapter} from '../src/agent/model-adapter.js';
import {SqliteTrace} from '../src/trace/sqlite-trace.js';
import type {Observation} from '../src/actions/schema.js';
import type {CompletionCriteria} from '../src/verifier/verifier.js';
import type {PlannedVerificationContract} from '../src/agent/task-planner.js';

const verifier=new HybridVerifier({baseUrl:'http://127.0.0.1:1',apiKey:'unused',mode:'assist',
  confidenceThreshold:0.8,timeoutMs:100,instructions:()=>''});
function browser(title:string,checked:boolean,complete=true):Observation {
  return {capture:{epoch:'browser-e',sequence:2,object:'page:browser-e',startedAt:10,finishedAt:11,
    clock:'collector',atomic:false,fields:{structured:{source:'dom',complete}}},
    structured:{source:'dom',complete,items:[{role:'listitem',text:title,checked,complete:true}]}};
}
function windows(phone:string,complete=true):Observation {
  return {capture:{epoch:'win-e',sequence:2,object:'window:win-e:42',startedAt:10,finishedAt:11,
    clock:'collector',atomic:false,fields:{dom:{source:'uia',complete}}},
    dom:JSON.stringify([{role:'Edit',name:'手机号',value:phone,nameComplete:true,
      valueComplete:true,visible:true}])};
}
function contract(goal:string,criteria:CompletionCriteria,source:'dom'|'uia'):PlannedVerificationContract {
  return {goal,successConditions:criteria,evidenceSources:{structuredStates:source},
    verifierStrategy:'rules_then_jev'};
}
const todo=(title:string):CompletionCriteria=>({structuredStates:[{target:{role:'listitem',text:title},
  field:'checked',equals:true}]});
const phone=(number:string):CompletionCriteria=>({structuredStates:[{target:{role:'Edit',name:'手机号'},
  field:'value',equals:number}]});

test('P1 Todo positive, parameter variant, wrong state and missing evidence use one rule',async()=>{
  for(const title of ['核对蓝色样本','核对绿色样本']) {
    const goal=`添加并完成“${title}”`;
    const criteria=todo(title);
    const passed=await verifier.evaluate(goal,criteria,browser(title,true),'task',contract(goal,criteria,'dom'));
    assert.equal(passed.verdict,'pass');assert.equal(passed.auxiliary,undefined);
    assert.equal(verifyGoal(criteria,browser(title,true)).ok,true);
    const failed=await verifier.evaluate(goal,criteria,browser(title,false),'task',contract(goal,criteria,'dom'));
    assert.equal(failed.verdict,'fail');
    const missing=await verifier.evaluate(goal,criteria,browser(title,true,false),'task',contract(goal,criteria,'dom'));
    assert.equal(missing.verdict,'unknown');assert.equal(missing.reason,'evidence_unavailable');
  }
});

test('P1 structured Windows positive, parameter variant and wrong value use one rule',async()=>{
  for(const number of ['13912345678','13800001111']) {
    const goal=`把手机号改成 ${number}`;
    const criteria=phone(number);
    assert.equal((await verifier.evaluate(goal,criteria,windows(number),'task',
      contract(goal,criteria,'uia'))).verdict,'pass');
    assert.equal((await verifier.evaluate(goal,criteria,windows('13711112222'),'task',
      contract(goal,criteria,'uia'))).verdict,'fail');
    assert.equal((await verifier.evaluate(goal,criteria,windows(number,false),'task',
      contract(goal,criteria,'uia'))).reason,'evidence_unavailable');
  }
});

test('a save result already visible before this task is stale, while a new result can pass',async()=>{
  const goal='把手机号改成 13800001111 并保存';
  const criteria:CompletionCriteria={structuredStates:[
    {target:{role:'Edit',name:'手机号'},field:'value',equals:'13800001111'},
    {target:{role:'Text',text:'客户资料已保存'},field:'text',equals:'客户资料已保存'}]};
  const frozen=contract(goal,criteria,'uia');
  const observed=(number:string, saved:boolean):Observation=>{
    const result=windows(number);
    const controls=JSON.parse(result.dom!);
    if(saved)controls.push({role:'Text',name:'客户资料已保存',value:'',nameComplete:true,
      valueComplete:true,visible:true});
    result.dom=JSON.stringify(controls);
    return result;
  };
  const current=observed('13800001111',true);
  const stale=await verifier.evaluate(goal,criteria,current,'task',frozen,
    deterministicChecks(criteria,observed('13912345678',true),frozen));
  assert.equal(stale.verdict,'unknown');assert.equal(stale.reason,'observation_stale');
  assert.equal(stale.checks[1].reason,'observation_stale');
  const fresh=await verifier.evaluate(goal,criteria,current,'task',frozen,
    deterministicChecks(criteria,observed('13912345678',false),frozen));
  assert.equal(fresh.verdict,'pass');
  const wrong=await verifier.evaluate(goal,criteria,observed('13711112222',true),'task',frozen,
    deterministicChecks(criteria,observed('13912345678',true),frozen));
  assert.equal(wrong.verdict,'fail');
  const dir=mkdtempSync(join(tmpdir(),'p1-stale-result-'));
  const trace=new SqliteTrace(join(dir,'trace.sqlite'));
  try {
    const initial={...initialState('p1-stale-result',goal,undefined,criteria),verificationContract:frozen};
    const result=await createAgentLoop({model:new FakeModel([{kind:'done',summary:'已保存'}]),
      runtime:{async observe(){return current;},async execute(){throw Error('No action expected');}},
      trace,acceptanceVerifier:verifier,maxSteps:2}).invoke(initial);
    assert.equal(result.status,'waiting_user');
    assert.equal(result.acceptanceReport?.reason,'observation_stale');
    assert.equal(result.goalVerification?.ok,false);
    assert.equal(result.baselineChecks?.[1].verdict,'pass');
  }finally{
    trace.close();const target=resolvePath(dir);
    if(dirname(target)!==resolvePath(tmpdir())||!basename(target).startsWith('p1-stale-result-'))
      throw new Error('Refusing to remove an unexpected test directory');
    rmSync(target,{recursive:true,force:true});
  }
});

test('an edited value alone cannot prove a save or submit goal',async()=>{
  const goal='把手机号改成 13912345678 并保存';
  const valueOnly=phone('13912345678');
  const current=windows('13912345678');
  const weak=await verifier.evaluate(goal,valueOnly,current,'task',contract(goal,valueOnly,'uia'));
  assert.equal(weak.verdict,'unknown');assert.equal(weak.reason,'unsupported_condition');
  assert.equal(weak.checks.at(-1)?.criterion,'durable_outcome');
  const withOutcome:CompletionCriteria={structuredStates:[...valueOnly.structuredStates!,
    {target:{role:'Text',name:'客户资料已保存'},field:'text',equals:'客户资料已保存'}]};
  const controls=JSON.parse(current.dom!);
  controls.push({role:'Text',name:'客户资料已保存',value:'',nameComplete:true,
    valueComplete:true,visible:true});
  current.dom=JSON.stringify(controls);
  const strong=await verifier.evaluate(goal,withOutcome,current,'task',contract(goal,withOutcome,'uia'));
  assert.equal(strong.verdict,'pass');assert.equal(strong.auxiliary,undefined);
  controls[1].name='客户资料保存失败';
  current.dom=JSON.stringify(controls);
  const failed=await verifier.evaluate(goal,withOutcome,current,'task',contract(goal,withOutcome,'uia'));
  assert.equal(failed.verdict,'unknown');
});

test('a flat observed input value cannot prove a durable save goal',async()=>{
  const goal='把手机号改成 13912345678 并保存';
  const criteria:CompletionCriteria={pageTextIncludes:'13912345678'};
  const current=windows('13912345678');
  current.pageText='客户资料 · 张三\n手机号 13912345678\n保存客户资料';
  current.textEvidence=[{source:'uia',text:current.pageText}];
  current.capture!.fields.pageText={source:'uia',complete:true};
  const frozen:PlannedVerificationContract={goal,successConditions:criteria,
    evidenceSources:{pageTextIncludes:'uia'},verifierStrategy:'rules_then_jev'};
  const report=await verifier.evaluate(goal,criteria,current,'task',frozen);
  assert.equal(report.verdict,'unknown');
  assert.equal(report.reason,'unsupported_condition');
  assert.equal(report.checks.at(-1)?.criterion,'durable_outcome');
  assert.equal(report.auxiliary,undefined);
});

test('ambiguous target, wrong source and changed frozen criteria cannot pass',async()=>{
  const goal='完成目标任务';const criteria=todo('目标任务');
  const duplicate=browser('目标任务',true);
  duplicate.structured!.items.push({...duplicate.structured!.items[0]});
  const ambiguous=await verifier.evaluate(goal,criteria,duplicate,'task',contract(goal,criteria,'dom'));
  assert.equal(ambiguous.verdict,'unknown');assert.equal(ambiguous.reason,'target_ambiguous');
  const wrongSource=await verifier.evaluate(goal,criteria,browser('目标任务',true),'task',
    contract(goal,criteria,'uia'));
  assert.equal(wrongSource.verdict,'unknown');
  const changed=await verifier.evaluate(goal,criteria,browser('目标任务',true),'task',
    contract(goal,todo('另一任务'),'dom'));
  assert.equal(changed.verdict,'unknown');assert.equal(changed.reason,'unsupported_condition');
});

test('structured result enters normalized trace input; flattened text alone never passes',async()=>{
  const goal='把手机号改成 13912345678';const criteria=phone('13912345678');
  const current=windows('13912345678');
  current.pageText='手机号 13912345678';
  current.textEvidence=[{source:'uia',text:current.pageText}];
  current.capture!.fields.pageText={source:'uia',complete:true};
  const normalized=taskEvidenceInput('p1-structured',goal,criteria,current,
    {planned:contract(goal,criteria,'uia')});
  assert.ok(normalized.input);
  assert.equal(normalized.input.evidence.find(item=>item.field==='value')?.value,'13912345678');
  const flattened={...current,dom:'invalid',structured:undefined};
  const report=await verifier.evaluate(goal,criteria,flattened,'task',contract(goal,criteria,'uia'));
  assert.equal(report.verdict,'unknown');assert.equal(report.reason,'evidence_unavailable');
});

test('planner validates source-bound structured condition before any action',()=>{
  const goal='完成核对蓝色样本';const criteria=todo('核对蓝色样本');
  const body={environment:'browser',plan:['更新目标条目'],
    verificationContract:contract(goal,criteria,'dom')};
  assert.deepEqual(parseTaskPlan(JSON.stringify(body),[],goal).completionCriteria,criteria);
  assert.throws(()=>parseTaskPlan(JSON.stringify({...body,
    verificationContract:contract(goal,criteria,'uia')}),[],goal),/结构化|来源/);
  assert.throws(()=>parseTaskPlan(JSON.stringify({...body,
    verificationContract:contract(goal,{structuredStates:[{target:{role:'listitem'},
      field:'checked',equals:true}]},'dom')}),[],goal),/结构化/);
});

test('Graph records source-bound automatic PASS and explicit wrong-state FAIL separately',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'p1-graph-'));
  const trace=new SqliteTrace(join(dir,'trace.sqlite'));
  try {
    for(const checked of [true,false]) {
      const taskId=`p1-${checked?'pass':'fail'}`;
      const goal='完成核对蓝色样本';const criteria=todo('核对蓝色样本');
      const current=browser('核对蓝色样本',checked);
      current.pageText='核对蓝色样本';current.textEvidence=[{source:'dom',text:current.pageText}];
      current.capture!.fields.pageText={source:'dom',complete:true};
      const state={...initialState(taskId,goal,undefined,criteria),
        verificationContract:contract(goal,criteria,'dom')};
      const result=await createAgentLoop({model:new FakeModel([{kind:'done',summary:'已处理'}]),
        runtime:{async observe(){return current;},async execute(){throw Error('No action expected');}},
        trace,acceptanceVerifier:verifier,maxSteps:2}).invoke(state);
      assert.equal(result.acceptanceReport?.verdict,checked?'pass':'fail');
      assert.equal(result.goalVerification?.ok,checked);
      assert.equal(result.status,checked?'done':'waiting_user');
      assert.ok(trace.events(taskId).some(event=>event.node==='acceptance_task'));
    }
  } finally {
    trace.close();const target=resolvePath(dir);
    if(dirname(target)!==resolvePath(tmpdir())||!basename(target).startsWith('p1-graph-'))
      throw new Error('Refusing to remove an unexpected test directory');
    rmSync(target,{recursive:true,force:true});
  }
});

test('final structured task proof outranks a weak visual stage result',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'p1-stage-priority-'));
  const trace=new SqliteTrace(join(dir,'trace.sqlite'));
  const goal='完成核对蓝色样本';const criteria=todo('核对蓝色样本');
  const model:ModelAdapter={name:'stage-fixture',kind:'model',
    async planStage(){return {goal:'目标条目已完成',successCondition:'目标复选框已勾选',isFinal:true};},
    async verifyStage(){return {ok:true,confidence:0.9,evidence:'画面看似完成',source:'visual_model'};},
    async decide(){return {kind:'done',summary:'无需动作'};}};
  try {
    const initial={...initialState('p1-stage-priority',goal,undefined,criteria),
      verificationContract:contract(goal,criteria,'dom'),
      taskContract:{target:goal,constraint:'仅观察',stageActionLimit:2,taskActionLimit:2}};
    const result=await createAgentLoop({model,runtime:{
      async observe(){return browser('核对蓝色样本',true);},
      async execute(){throw Error('No action expected');}},
      trace,acceptanceVerifier:verifier,maxSteps:2}).invoke(initial);
    assert.equal(result.acceptanceReport?.verdict,'pass');
    assert.equal(result.status,'done');
    assert.equal(result.finalReviewPending,false);
    assert.equal(result.goalVerification?.ok,true);
  }finally{
    trace.close();const target=resolvePath(dir);
    if(dirname(target)!==resolvePath(tmpdir())||!basename(target).startsWith('p1-stage-priority-'))
      throw new Error('Refusing to remove an unexpected test directory');
    rmSync(target,{recursive:true,force:true});
  }
});

test('final structured task proof does not depend on an unavailable stage JEV',async()=>{
  for(const checked of [true,false]) {
    const dir=mkdtempSync(join(tmpdir(),'p1-stage-jev-'));
    const trace=new SqliteTrace(join(dir,'trace.sqlite'));
    const goal='完成核对绿色样本';const criteria=todo('核对绿色样本');
    let stageCalls=0;let actions=0;
    const acceptanceVerifier:AcceptanceVerifier={async evaluate(taskGoal,taskCriteria,observation,scope,verificationContract){
      if(scope==='stage') {
        stageCalls++;
        return {mode:'assist',verdict:'unknown',reason:'verification_error',observationId:'stage',
          checks:[],message:'JEV 验收暂不可用',auxiliary:{verdict:'unknown',confidence:0,durationMs:1,error:'JEV HTTP 500'}};
      }
      return verifier.evaluate(taskGoal,taskCriteria,observation,scope,verificationContract);
    }};
    const model:ModelAdapter={name:'stage-jev-fixture',kind:'model',
      async planStage(){return {goal:'目标条目已完成',successCondition:'目标复选框已勾选',isFinal:true};},
      async verifyStage(){return {ok:false,confidence:0,evidence:'阶段模型无法判定',source:'visual_model'};},
      async decide(){return {kind:'done',summary:'已完成'};}};
    try {
      const initial={...initialState(`p1-stage-jev-${checked}`,goal,undefined,criteria),
        verificationContract:contract(goal,criteria,'dom'),
        taskContract:{target:goal,constraint:'仅观察',stageActionLimit:2,taskActionLimit:2}};
      const result=await createAgentLoop({model,runtime:{
        async observe(){return browser('核对绿色样本',checked);},
        async execute(){actions++;throw Error('No action expected');}},
        trace,acceptanceVerifier,maxSteps:2}).invoke(initial);
      assert.equal(result.status,checked?'done':'waiting_user');
      assert.equal(result.acceptanceReport?.verdict,checked?'pass':'fail');
      assert.equal(result.goalVerification?.ok,checked?true:undefined);
      assert.equal(stageCalls,0);
      assert.equal(actions,0);
    }finally{
      trace.close();const target=resolvePath(dir);
      if(dirname(target)!==resolvePath(tmpdir())||!basename(target).startsWith('p1-stage-jev-'))
        throw new Error('Refusing to remove an unexpected test directory');
      rmSync(target,{recursive:true,force:true});
    }
  }
});
