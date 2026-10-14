import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {FakeModel} from '../src/agent/model-adapter.js';
import {FakeRuntime} from '../src/runtime/runtime-adapter.js';
import {createAgentLoop} from '../src/graph/graph.js';
import {initialState} from '../src/graph/state.js';
import {SqliteTrace} from '../src/trace/sqlite-trace.js';
import type {Observation,ComputerAction} from '../src/actions/schema.js';
import type {CompletionCriteria} from '../src/verifier/verifier.js';
import type {PlannedVerificationContract} from '../src/agent/task-planner.js';

const OLD='13900000001', NEW='13977770002';
const goal='把手机号改成 13977770002 并保存';
const criteria:CompletionCriteria={windowTitleIncludes:'客户资料',structuredStates:[
  {target:{role:'Edit',name:'手机号'},field:'value',equals:NEW,persistedAfter:'rebind'}]};
function frozen(conditions=criteria):PlannedVerificationContract {
  return {goal,successConditions:structuredClone(conditions),
    evidenceSources:{windowTitleIncludes:'window',structuredStates:'uia'},verifierStrategy:'rules_then_jev'};
}
const actions:ComputerAction[]=[
  {kind:'type',target:{kind:'role',role:'Edit',name:'手机号'},text:NEW},
  {kind:'keypress',keys:'CTRL+S'},
  {kind:'keypress',keys:'ESC'},
  {kind:'keypress',keys:'CTRL+O'},
  {kind:'done',summary:'请求完整目标验收'},
];

// Every capture is synthetic. Four dispatched actions produce the real Graph
// R0 -> edit -> commit -> absent -> R1 chain; no pre-seeded rebind state.
class RebindRuntime extends FakeRuntime {
  sequence=0;
  constructor(readonly terminal:(observation:Observation)=>Observation=observation=>observation) {super();}
  override async observe():Promise<Observation> {
    const step=this.executed.length;
    const observation:Observation={windowTitle:'客户资料',pageText:`合成界面 ${step}`,
      dom:JSON.stringify(step===3?[]:[{role:'Edit',name:'手机号',
        value:step===0?OLD:NEW,runtimeId:step<4?[7,1]:[7,2],
        nameComplete:true,valueComplete:true,visible:true}]),
      capture:{epoch:'fixture-e',sequence:++this.sequence,object:'window:fixture-e:42',
        startedAt:this.sequence,finishedAt:this.sequence+0.5,clock:'collector',atomic:false,
        enumerationComplete:true,fields:{dom:{source:'uia',complete:true},
          pageText:{source:'uia',complete:true}}}};
    observation.textEvidence=[{source:'uia',text:observation.pageText!}];
    // The completion read is after the observe following the fourth action.
    return step===4&&this.sequence>5?this.terminal(observation):observation;
  }
}

async function run(terminal:(observation:Observation)=>Observation,
  conditions=criteria,contract:PlannedVerificationContract|undefined=frozen(conditions)) {
  const dir=mkdtempSync(join(tmpdir(),'b5a-graph-'));
  const trace=new SqliteTrace(join(dir,'trace.sqlite'));
  const runtime=new RebindRuntime(terminal);
  try {
    const state={...initialState('b5a-fixture',goal,undefined,structuredClone(conditions)),
      verificationContract:contract};
    const result=await createAgentLoop({model:new FakeModel(actions),runtime,trace,maxSteps:6})
      .invoke(state,{recursionLimit:100});
    const events=trace.events(state.taskId);
    if(process.env.B5A_EVIDENCE_DIR) {
      mkdirSync(process.env.B5A_EVIDENCE_DIR,{recursive:true});
      writeFileSync(join(process.env.B5A_EVIDENCE_DIR,`trace-${runNumber++}.json`),
        JSON.stringify({result,events,executed:runtime.executed},null,2));
    }
    assert.equal(runtime.executed.length,4,'save/navigation actions must not replay');
    const chain=events.findLast(event=>event.node==='verify')?.state.rebindState?.[0];
    assert.equal(chain?.baseline?.runtimeId,'[7,1]');
    assert.ok(chain?.editedSequence!<chain?.committedSequence!);
    assert.ok(chain?.committedSequence!<chain?.absentSequence!);
    assert.ok(chain?.absentSequence!<chain?.rebound?.sequence!);
    assert.equal(chain?.rebound?.runtimeId,'[7,2]');
    const acceptance=events.findLast(event=>event.node==='acceptance_task');
    assert.ok(acceptance,'raw Trace must retain the terminal acceptance');
    assert.deepEqual(acceptance.state.acceptanceReport,result.acceptanceReport);
    return {result,events,runtime};
  }finally{
    trace.close();
    const target=resolve(dir);
    if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('b5a-graph-'))
      throw Error('Refusing to remove an unexpected test directory');
    rmSync(target,{recursive:true,force:true});
  }
}

let runNumber=0;

test('B5a Graph: rebind PASS cannot cover a fresh explicit windowTitle FAIL',async()=>{
  const {result}=await run(observation=>({...observation,windowTitle:'其他窗口'}));
  assert.equal(result.acceptanceReport?.verdict,'fail');
  assert.equal(result.status,'waiting_user');
  assert.equal(result.goalVerification?.ok,false);
  assert.equal(result.acceptanceReport?.checks.find(check=>check.criterion==='windowTitleIncludes')?.verdict,'fail');
  assert.equal(result.acceptanceReport?.checks.find(check=>check.criterion==='structuredStates:0')?.verdict,'pass');
});

test('B5a Graph: rebind PASS plus every remaining frozen condition PASS completes',async()=>{
  const {result}=await run(observation=>observation);
  assert.equal(result.status,'done');
  assert.equal(result.goalVerification?.ok,true);
  assert.equal(result.acceptanceReport?.verdict,'pass');
  assert.deepEqual(result.acceptanceReport?.checks.map(check=>[check.criterion,check.verdict]),
    [['windowTitleIncludes','pass'],['structuredStates:0','pass']]);
});
