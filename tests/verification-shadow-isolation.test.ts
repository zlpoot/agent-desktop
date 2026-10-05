import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentLoop} from '../src/graph/graph.js';
import {initialState} from '../src/graph/state.js';
import {SqliteTrace} from '../src/trace/sqlite-trace.js';
import type {ComputerAction,Observation} from '../src/actions/schema.js';
import type {HostShadowRecord} from '../src/verification/host-shadow.js';

test('shadow JEV failure cannot change production action or task completion decision',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'shadow-isolation-'));
  const trace=new SqliteTrace(join(dir,'trace.sqlite'));
  let content='空白',sequence=0,decisions=0;
  const observation=():Observation=>{const n=++sequence;return {pageText:content,windowHandle:42,
    dom:JSON.stringify([{name:'',value:content,runtimeId:[1,7],nameComplete:true,valueComplete:true,
      role:'Edit',autoId:'body',className:'Edit',enabled:true,visible:true}]),
    textEvidence:[{source:'dom',text:content}],capture:{epoch:'e',object:'window:e:42',sequence:n,
      startedAt:n*10,finishedAt:n*10+1,clock:'collector',atomic:false,
      enumerationComplete:true,fields:{pageText:{complete:true,source:'dom'},dom:{complete:true,source:'uia'}}}};};
  const runtime={async observe(){return observation();},
    async ground(action:ComputerAction){return {target:action.kind==='type'?action.target as import('../src/actions/schema.js').Target:undefined,
      attempts:[{strategy:'role' as const,matched:true,selected:true,detail:'UIA 唯一匹配'}]};},
    async execute(action:ComputerAction){if(action.kind==='type')content=action.text;
      return {ok:true,message:'已派发' as const,effect:'dispatched' as const};}};
  const model={kind:'rule' as const,name:'test',async decide(){return decisions++===0
    ?{kind:'type' as const,target:{kind:'role' as const,role:'Edit'},text:'已完成'}
    :{kind:'done' as const,summary:'完成'};}};
  const records:HostShadowRecord[]=[];
  try {
    const result=await createAgentLoop({runtime,model,trace,maxSteps:5,shadowSink:r=>records.push(r),
      shadowVerify:async()=>{throw Error('JEV unavailable');}}).invoke(
        initialState('task','输入已完成',undefined,{pageTextIncludes:'已完成'}));
    assert.equal(result.status,'done');
    assert.equal(result.goalVerification?.ok,true);
    assert.ok(records.some(r=>r.kind==='action-verification'&&r.reasons?.includes('shadow_pipeline_error')));
    assert.ok(records.some(r=>r.kind==='task-verification'&&r.reasons?.includes('shadow_pipeline_error')));
  } finally {trace.close();rmSync(dir,{recursive:true,force:true});}
});
