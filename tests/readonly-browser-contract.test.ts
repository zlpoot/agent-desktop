import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareReadonlyBrowserTask,assertReadonlyBrowserAction,matchesReadonlyBrowserContract,
  readonlyBrowserStagePlan,isReadonlyBrowserRestricted,isLegacyReadonlyBrowserContract} from '../src/agent/readonly-browser-plan.js';
import {readonlyBrowserAcceptance,isReadonlyBrowserContract} from '../src/verifier/readonly-browser-verifier.js';
import {readonlyFixture} from './fixtures/readonly-browser.js';
import {initialState,type ComputerState} from '../src/graph/state.js';
import {createAgentLoop} from '../src/graph/graph.js';
import {FakeModel} from '../src/agent/model-adapter.js';
import {FakeRuntime} from '../src/runtime/runtime-adapter.js';
import {SqliteTrace} from '../src/trace/sqlite-trace.js';
import {DesktopTaskController} from '../src/app/task-runner.js';
import type {ComputerAction} from '../src/actions/schema.js';

const url='https://example.test/identity?mode=read', title='Structured Title',marker='STRUCTURED-MARKER';
const goal='Read this page identity without input.';
function state():ComputerState {
  const prepared=readonlyFixture(goal,url,title,marker);
  return {...initialState('fixture',goal,prepared.plan,prepared.completionCriteria),
    verificationContract:prepared.verificationContract,taskContract:prepared.taskContract,
    contractCoverage:{covered:true,reviewRequired:false,requiredFiles:[]}};
}
const denied:ComputerAction[]=[{kind:'click',target:{kind:'text',text:'Button'}},
  {kind:'type',target:{kind:'text',text:'Field'},text:'bad'},
  {kind:'navigate',url:url+'&other=1'},{kind:'navigate',url:'https://other.test/'}];

test('structured opt-in supports different wording; complete original goal remains bound',()=>{
  for(const text of [goal,'请只读核对网页身份。','Lire le titre et le repère, sans saisie.']) {
    const prepared=readonlyFixture(text,url,title,marker);
    assert.equal(isReadonlyBrowserContract(text,prepared.verificationContract,prepared.taskContract),true);
    assert.equal(isReadonlyBrowserContract(text,prepared.verificationContract),false,'LLM 仅自报同样条件不得提升');
  }
  for(const extra of [' 填写表单',' 核对价格为42元',' 保存 report.txt',' 然后提交']) {
    const changed=state(); changed.goal+=extra; changed.taskContract!.target=changed.goal;
    changed.verificationContract!.goal=changed.goal;
    assert.equal(matchesReadonlyBrowserContract(changed.goal,changed.verificationContract,changed.completionCriteria,changed.taskContract),false);
    assert.equal(readonlyBrowserAcceptance(changed.goal,changed.completionCriteria,undefined,changed.verificationContract,changed.taskContract).verdict,'unknown');
    for(const action of denied)assert.throws(()=>assertReadonlyBrowserAction(changed,action),/只读/);
    assert.throws(()=>prepareReadonlyBrowserTask(changed.goal,readonlyFixture(goal,url,title,marker).request),/invalid-opt-in/);
  }
});

test('invalid opt-in is rejected; malformed frozen fields never remove the read-only fence',()=>{
  const request=readonlyFixture(goal,url,title,marker).request;
  for(const patch of [{url:'file:///tmp/secret'},{url:'https://user:pass@example.test/'},{url:'https://example.test'},
    {sourceId:''},{scope:'partial-task'},{title:'<Injected>'},{title:'  '},{marker:''},{marker:'  '},
    {allowedActions:['navigate','click','done','wait']},{additionalRequirement:'price'}]) {
    assert.throws(()=>prepareReadonlyBrowserTask(goal,{...request,...patch} as any),/invalid-opt-in/);
  }
  for(const corrupt of [
    (s:ComputerState)=>{s.verificationContract=undefined;},
    (s:ComputerState)=>{s.completionCriteria={pageTextIncludes:marker};},
    (s:ComputerState)=>{s.verificationContract!.evidenceSources.domIncludes='uia';},
    (s:ComputerState)=>{s.taskContract!.environment='windows';},
    (s:ComputerState)=>{s.taskContract!.allowedActions=['click','navigate'];},
    (s:ComputerState)=>{s.taskContract!.profileId='readonly-browser/v1:invalid';},
    (s:ComputerState)=>{delete s.taskContract!.profileId;},
  ]) {
    const changed=state();corrupt(changed);
    assert.equal(isReadonlyBrowserRestricted(changed.taskContract),true);
    assert.equal(readonlyBrowserStagePlan(changed),undefined);
    for(const action of [...denied,{kind:'navigate' as const,url}])assert.throws(()=>assertReadonlyBrowserAction(changed,action),/只读/);
  }
  for(const patch of [{step:1},{stagePlanVersion:1},{resumeReconcile:true},{recoveryRequired:true},
    {workflowReplayState:{nextIndex:0,exploring:false}},{workflowRef:{id:'old',version:1,values:{}}},
    {completedStages:[{}]},{contractCoverage:{covered:false,reviewRequired:true}}]) {
    assert.equal(readonlyBrowserStagePlan({...state(),...patch} as ComputerState),undefined);
  }
});

test('Graph dispatch rejects unsafe actions even with a plain model or an invalid specialized contract',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'readonly-dispatch-')),trace=new SqliteTrace(join(dir,'trace.sqlite'));
  try {
    for(const action of denied) for(const corrupted of [false,true]) {
      const runtime=new FakeRuntime(), s=state();
      s.taskId=crypto.randomUUID();
      if(corrupted)s.verificationContract!.evidenceSources.domIncludes='uia';
      const model=Object.assign(new FakeModel([action]),{
        async planStage(){return {goal:'核对页面',successCondition:'标题与标记符合',isFinal:true};},
        async verifyStage(){return {ok:false,confidence:1,evidence:'尚未到达目标',source:'dom' as const};},
      });
      await assert.rejects(createAgentLoop({runtime,model,trace,maxSteps:2}).invoke(s),/只读/);
      assert.equal(runtime.executed.length,0);
    }
  } finally {trace.close();rmSync(dir,{recursive:true,force:true});}
});

test('trusted controller entry freezes before planning, rejects mismatched/legacy recovery without launching runtime',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'readonly-controller-'));
  const controller=new DesktopTaskController(dir,{modelProvider:{createModel(){throw Error('SYNTHETIC_STOP_BEFORE_RUNTIME');}}});
  const trace=new SqliteTrace(join(dir,'web-tasks.sqlite'));
  try {
    const prepared=readonlyFixture(goal,url,title,marker);
    const id=controller.submitReadonlyBrowser(goal,prepared.request);
    await controller.close();
    const frozen=trace.load(id)!;
    assert.deepEqual(frozen.taskContract,prepared.taskContract);
    assert.deepEqual(frozen.verificationContract,prepared.verificationContract);
    assert.throws(()=>controller.submitReadonlyBrowser(goal,prepared.request),/任务控制器已关闭/);
    const resumed=new DesktopTaskController(dir,{modelProvider:{createModel(){throw Error('must not create model');}}});
    try {
      trace.save('waiting_user',{...frozen,status:'waiting_user',observation:{url:url+'&redirect=1'}});
      assert.throws(()=>resumed.resume(id,{approved:true}),/restore-url-mismatch/);
      for(const taskContract of [undefined,
        {...frozen.taskContract!,profileId:undefined,allowedActions:undefined,environment:undefined}]) {
        const legacy={...frozen,status:'paused' as const,taskContract};
        assert.equal(isLegacyReadonlyBrowserContract(legacy),true,'旧通用路径没有 environment 或 Task 契约也须拒绝');
        trace.save('paused',legacy);
        assert.throws(()=>resumed.continue(id),/legacy-contract-requires-explicit-opt-in/);
        assert.equal(isLegacyReadonlyBrowserContract({...legacy,workflowRef:{id:'explicit',version:1,values:{},explicit:true}}),false);
      }
    } finally {await resumed.close();}
  } finally {await controller.close();trace.close();rmSync(dir,{recursive:true,force:true});}
});
