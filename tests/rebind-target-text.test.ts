import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import type {Observation} from '../src/actions/schema.js';
import type {CompletionCriteria} from '../src/verifier/verifier.js';
import {captureRebindBaseline,ingestRebindObservation,evaluateRebindTask,
  type StructuredCondition,type RebindConditionState} from '../src/verification/structured-rebind.js';
import {FakeModel} from '../src/agent/model-adapter.js';
import {FakeRuntime} from '../src/runtime/runtime-adapter.js';
import {createAgentLoop} from '../src/graph/graph.js';
import {initialState} from '../src/graph/state.js';
import {SqliteTrace} from '../src/trace/sqlite-trace.js';

type Source='dom'|'uia';
type Control={role:string;name?:string;text?:string;value?:string;identity:string;
  complete?:boolean;nameComplete?:boolean;valueComplete?:boolean;textComplete?:boolean};
const OLD='before',NEW='after';
const targetText='目标 A';
const condition=(target:StructuredCondition['target']):StructuredCondition=>
  ({target,field:'value',equals:NEW,persistedAfter:'rebind'});
function control(source:Source,value=NEW,identity='r1'):Control {
  return {role:'Edit',name:source==='uia'?targetText:'共同名称',text:targetText,value,identity,
    complete:true,nameComplete:true,valueComplete:true};
}
function observation(source:Source,sequence:number,controls:Control[]):Observation {
  const now=Date.now();
  const result:Observation={capture:{epoch:'synthetic-e',sequence,
    object:source==='dom'?'page:synthetic-e':'window:synthetic-e:42',startedAt:now,finishedAt:now,
    clock:'collector',atomic:false,enumerationComplete:true,
    fields:{dom:{source,complete:true},structured:{source,complete:true}}}};
  if(source==='dom')result.structured={source,complete:true,items:controls};
  else result.dom=JSON.stringify(controls.map(({identity,complete,...item})=>({...item,runtimeId:identity})));
  return result;
}
function record(name:string,data:unknown) {
  if(!process.env.B5B_EVIDENCE_DIR)return;
  mkdirSync(process.env.B5B_EVIDENCE_DIR,{recursive:true});
  writeFileSync(join(process.env.B5B_EVIDENCE_DIR,name+'.json'),JSON.stringify(data,null,2));
}
function chain(source:Source,cond:StructuredCondition,
  transform:(controls:Control[],sequence:number)=>Control[]=controls=>controls) {
  const observations=Array.from({length:6},(_,index)=>{
    const sequence=index+1;
    const items=sequence===4?[]:[control(source,sequence===1?OLD:NEW,sequence<5?'r0':'r1')];
    return observation(source,sequence,transform(items,sequence));
  });

  let state=captureRebindBaseline(undefined,observations[0],cond);
  const states:RebindConditionState[]=[state];
  for(const current of observations.slice(1,5)) {
    state=ingestRebindObservation(state,current,cond,true);states.push(state);
  }
  const criteria:CompletionCriteria={structuredStates:[cond]};
  const report=evaluateRebindTask(criteria,{0:state},observations[5],source);
  return {criteria,observations,states,state,report};
}

for(const [source,both] of [['dom',false],['dom',true],['uia',false]] as const)
  test(`B5b red: ${source} ${both?'name+text':'text-only'} wrong text cannot bind and PASS`,()=>{
    const cond=condition({role:'Edit',...(both?{name:'共同名称'}:{}),text:targetText});
    const result=chain(source,cond,items=>items.map(item=>({...item,
      ...(source==='dom'?{text:'目标 B'}:{name:'目标 B',text:targetText})})));
    record(`wrong-text-${source}-${both}`,result);
    assert.equal(result.report.verdict,'unknown');
    assert.equal(result.state.baseline,undefined);
    assert.notEqual(result.report.verdict,'pass');
  });

for(const source of ['dom','uia'] as const) test(`B5b red Graph: ${source} wrong text never completes`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'b5b-text-'));
  const trace=new SqliteTrace(join(dir,'trace.sqlite'));
  class TextRuntime extends FakeRuntime {
    sequence=0;
    override async observe() {
      const step=this.executed.length;
      const item=control(source,step===0?OLD:NEW,step<4?'r0':'r1');
      if(source==='dom')item.text='目标 B';else item.name='目标 B';
      const current=observation(source,++this.sequence,step===3?[]:[item]);
      current.pageText=`${step===0?OLD:NEW} 合成动作 ${step}`;
      current.textEvidence=[{source,text:current.pageText}];
      return current;
    }
  }
  const runtime=new TextRuntime();
  const cond=condition({role:'Edit',text:targetText});
  const criteria:CompletionCriteria={structuredStates:[cond]};
  const goal='修改目标 A 并保存';
  try {
    const result=await createAgentLoop({trace,runtime,maxSteps:6,model:new FakeModel([
      {kind:'type',target:{kind:'role',role:'Edit',name:source==='uia'?'目标 B':'共同名称'},text:NEW},
      {kind:'keypress',keys:'CTRL+S'},{kind:'keypress',keys:'ESC'},
      {kind:'keypress',keys:'CTRL+O'},{kind:'done',summary:'请求验收'}])})
      .invoke({...initialState(`b5b-${source}`,goal,undefined,criteria),verificationContract:{goal,
        successConditions:criteria,evidenceSources:{structuredStates:source},verifierStrategy:'rules_then_jev'}},
      {recursionLimit:100});
    const latest=trace.load(result.taskId);
    const events=trace.events(result.taskId);
    record(`graph-wrong-text-${source}`,{result,latest,events,executed:runtime.executed});
    assert.equal(runtime.executed.length,4);
    assert.equal(result.status,'waiting_user');
    assert.equal(result.goalVerification?.ok,false);
    assert.equal(result.acceptanceReport?.verdict,'unknown');
    assert.equal(result.rebindState?.[0].baseline,undefined);
  }finally{
    trace.close();const target=resolve(dir);
    if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('b5b-text-'))
      throw Error('Refusing to remove an unexpected test directory');
    rmSync(target,{recursive:true,force:true});
  }
});
