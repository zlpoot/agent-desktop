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
import {normalizeEvidence} from '../src/verifier/hybrid-verifier.js';

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

for(const source of ['dom','uia'] as const)
for(const mode of ['wrong-text','correct','unreadable-leave'] as const)
test(`B5b Graph: ${source} ${mode}`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'b5b-text-'));
  const trace=new SqliteTrace(join(dir,'trace.sqlite'));
  class TextRuntime extends FakeRuntime {
    sequence=0;
    override async observe() {
      const step=this.executed.length;
      const item=control(source,step===0?OLD:NEW,step<4?'r0':'r1');
      if(mode==='wrong-text') {
        if(source==='dom')item.text='目标 B';else item.name='目标 B';
      }
      let items=step===3?[]:[item];
      if(mode==='unreadable-leave'&&step===3) {
        if(source==='dom')delete item.text;else item.nameComplete=false;
        items=[item];
      }
      const current=observation(source,++this.sequence,items);
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
      {kind:'type',target:{kind:'role',role:'Edit',name:source==='uia'
        ?mode==='wrong-text'?'目标 B':targetText:'共同名称'},text:NEW},
      {kind:'keypress',keys:'CTRL+S'},{kind:'keypress',keys:'ESC'},
      {kind:'keypress',keys:'CTRL+O'},{kind:'done',summary:'请求验收'}])})
      .invoke({...initialState(`b5b-${source}`,goal,undefined,criteria),verificationContract:{goal,
        successConditions:criteria,evidenceSources:{structuredStates:source},verifierStrategy:'rules_then_jev'}},
      {recursionLimit:100});
    const latest=trace.load(result.taskId);
    const events=trace.events(result.taskId);
    record(`graph-${mode}-${source}`,{result,latest,events,executed:runtime.executed});
    assert.equal(runtime.executed.length,4);
    assert.equal(result.status,mode==='correct'?'done':'waiting_user');
    assert.equal(result.goalVerification?.ok,mode==='correct');
    assert.equal(result.acceptanceReport?.verdict,mode==='correct'?'pass':'unknown');
    if(mode==='wrong-text')assert.equal(result.rebindState?.[0].baseline,undefined);
    if(mode==='unreadable-leave') {
      assert.equal(result.rebindState?.[0].absentSequence,undefined);
      assert.equal(result.rebindState?.[0].rebound,undefined);
    }
    const accepted=events.filter(event=>event.node==='acceptance_task').at(-1)!.state;
    for(const current of [result,latest!,accepted]) {
      assert.equal(current.observation?.capture?.sequence,6);
      assert.equal(current.acceptanceReport?.observationId,normalizeEvidence(current.observation).observationId);
      assert.deepEqual(JSON.parse(JSON.stringify(current.observation)),accepted.observation);
    }
  }finally{
    trace.close();const target=resolve(dir);
    if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('b5b-text-'))
      throw Error('Refusing to remove an unexpected test directory');
    rmSync(target,{recursive:true,force:true});
  }
});

for(const source of ['dom','uia'] as const) {
  for(const both of [false,true])test(`B5b ${source} ${both?'name+text':'text-only'} full chain PASS`,()=>{
    const cond=condition({role:'edit',...(both?{name:control(source).name}:{}),text:targetText});
    const result=chain(source,cond);
    record(`positive-${source}-${both}`,result);
    assert.equal(result.report.verdict,'pass');
    assert.deepEqual([result.state.baseline?.sequence,result.state.editedSequence,
      result.state.committedSequence,result.state.absentSequence,result.state.rebound?.sequence],[1,2,3,4,5]);
    assert.notEqual(result.state.rebound?.runtimeId,result.state.baseline?.runtimeId);
  });
  test(`B5b ${source} text whitespace normalization`,()=>{
    const result=chain(source,condition({role:'Edit',text:' 目标\n A '}));
    assert.equal(result.report.verdict,'pass');
  });
  for(const defect of ['missing','incomplete','missing completeness'] as const)
    test(`B5b ${source} ${defect} target text UNKNOWN`,()=>{
      const result=chain(source,condition({role:'Edit',text:targetText}),items=>items.map(item=>{
        const changed={...item};
        if(source==='dom') {
          if(defect==='missing')delete changed.text;
          if(defect==='incomplete')changed.complete=false;
          if(defect==='missing completeness')delete changed.complete;
        }else{
          if(defect==='missing')delete changed.name;
          if(defect==='incomplete')changed.nameComplete=false;
          if(defect==='missing completeness')delete changed.nameComplete;
        }
        // The correct value/name/forged text cannot supply the missing label.
        return changed;
      }));
      record(`missing-${source}-${defect}`,result);
      assert.equal(result.state.baseline,undefined);
      assert.equal(result.state.absentSequence,undefined);
      assert.equal(result.report.verdict,'unknown');
    });
  test(`B5b ${source} unreadable text after commit cannot create absence/rebind`,()=>{
    const cond=condition({role:'Edit',text:targetText});
    const result=chain(source,cond,(items,sequence)=>{
      if(sequence!==4)return items;
      const unknown=control(source,NEW,'r0');
      if(source==='dom')delete unknown.text;else unknown.nameComplete=false;
      return [unknown];
    });
    record(`no-fake-leave-${source}`,result);
    assert.equal(result.state.committedSequence,3);
    assert.equal(result.state.absentSequence,undefined);
    assert.equal(result.state.rebound,undefined);
    assert.equal(result.report.verdict,'unknown');
  });
  for(const stage of [2,3,5] as const)test(`B5b ${source} unreadable text blocks stage ${stage}`,()=>{
    const result=chain(source,condition({role:'Edit',text:targetText}),(items,sequence)=>items.map(item=>{
      if(sequence!==stage)return item;
      return source==='dom'?{...item,text:undefined}:{...item,nameComplete:false};
    }));
    if(stage===2)assert.equal(result.states[1].editedSequence,undefined);
    if(stage===3)assert.equal(result.states[2].committedSequence,undefined);
    if(stage===5)assert.equal(result.states[4].rebound,undefined);
  });
  for(const scenario of ['distinct texts','duplicate target','unreadable competitor'] as const)
    test(`B5b ${source} same-role candidates: ${scenario}`,()=>{
      const result=chain(source,condition({role:'Edit',text:targetText}),(items,sequence)=>{
        if(sequence===4)return items;
        const other=control(source,NEW,sequence<5?'other-r0':'other-r1');
        if(scenario==='distinct texts') {
          if(source==='dom')other.text='目标 B';else other.name='目标 B';
        }
        if(scenario==='unreadable competitor') {
          if(source==='dom')delete other.text;else other.nameComplete=false;
        }
        return [...items,other];
      });
      record(`candidates-${source}-${scenario}`,result);
      assert.equal(result.report.verdict,scenario==='distinct texts'?'pass':'unknown');
      if(scenario==='duplicate target')assert.equal(result.report.checks[0].reason,'target_ambiguous');
      if(scenario==='unreadable competitor')assert.equal(result.state.baseline,undefined);
    });
  test(`B5b ${source} trusted name mismatch excludes unreadable unrelated text`,()=>{
    const result=chain(source,condition({role:'Edit',name:control(source).name,text:targetText}),(items,sequence)=>
      sequence===4?items:[...items,{...control(source,NEW,'unrelated'),name:'无关名称',text:undefined}]);
    assert.equal(result.report.verdict,'pass');
  });
  for(const scenario of ['matching','wrong text','missing text','wrong source','wrong identity','wrong value'] as const)
    test(`B5b ${source} historical name-only checkpoint requires current full target: ${scenario}`,()=>{
      const legacy=chain(source,condition({role:'Edit',name:control(source).name}));
      const saved=JSON.parse(JSON.stringify(legacy.state)) as RebindConditionState;
      const item=control(source);
      if(scenario==='wrong text') {
        if(source==='dom')item.text='目标 B';else item.name='目标 B';
      }
      if(scenario==='missing text') {
        if(source==='dom')delete item.text;else item.nameComplete=false;
      }
      if(scenario==='wrong identity')item.identity='r2';
      if(scenario==='wrong value')item.value=OLD;
      const terminal=observation(source,6,[item]);
      const report=evaluateRebindTask({structuredStates:[condition({role:'Edit',text:targetText})]},
        {0:saved},terminal,scenario==='wrong source'?(source==='dom'?'uia':'dom'):source);
      record(`checkpoint-${source}-${scenario}`,{saved,terminal,report});
      assert.equal(report.verdict,scenario==='matching'?'pass':scenario==='wrong value'?'fail':'unknown');
      if(scenario==='missing text'||scenario==='wrong source')assert.equal(report.checks[0].reason,'evidence_unavailable');
    });
}

test('B5b DOM textComplete=false cannot certify text despite complete item',()=>{
  const result=chain('dom',condition({role:'Edit',text:targetText}),items=>
    items.map(item=>({...item,textComplete:false})));
  assert.equal(result.state.baseline,undefined);
  assert.equal(result.report.verdict,'unknown');
});
for(const source of ['dom','uia'] as const)test(`B5b ${source} name-only matching remains exact`,()=>{
  const result=chain(source,condition({role:'Edit',name:' '+control(source).name+' '}));
  assert.equal(result.state.baseline,undefined);
  assert.equal(result.report.verdict,'unknown');
});
for(const source of ['dom','uia'] as const)test(`B5b ${source} incomplete capture stamp cannot advance leave`,()=>{
  const cond=condition({role:'Edit',text:targetText});
  const good=chain(source,cond);
  const before=good.states[2];
  const absent=observation(source,4,[]);
  absent.capture!.fields[source==='dom'?'structured':'dom'].complete=false;
  assert.deepEqual(ingestRebindObservation(before,absent,cond,true),before);
});

for(const source of ['dom','uia'] as const) {
  for(const attribute of ['role','name'] as const)test(`B5b ${source} ${attribute} mismatch despite correct text`,()=>{
    const cond=condition({role:'Edit',name:control(source).name,text:targetText});
    const result=chain(source,cond,items=>items.map(item=>({...item,
      ...(attribute==='role'?{role:'Document'}:{name:'错误名称'})})));
    assert.equal(result.state.baseline,undefined);
    assert.equal(result.report.verdict,'unknown');
  });
  test(`B5b ${source} wrong capture source cannot create absence`,()=>{
    const cond=condition({role:'Edit',text:targetText});
    const before=chain(source,cond).states[2];
    const absent=observation(source,4,[]);
    absent.capture!.fields[source==='dom'?'structured':'dom'].source=source==='dom'?'uia':'dom';
    assert.deepEqual(ingestRebindObservation(before,absent,cond,true),before);
  });
}
