import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {parseTaskPlan} from '../src/agent/task-planner.js';
import {readonlyBrowserContract,readonlyBrowserStagePlan} from '../src/agent/readonly-browser-plan.js';
import {FakeModel} from '../src/agent/model-adapter.js';
import {StageWorkflowModel} from '../src/agent/stage-workflow-model.js';
import {FakeRuntime} from '../src/runtime/runtime-adapter.js';
import {initialState} from '../src/graph/state.js';
import {createAgentLoop} from '../src/graph/graph.js';
import {SqliteTrace} from '../src/trace/sqlite-trace.js';
import {WorkflowStore} from '../src/workflows/store.js';
import {auditTaskContractCoverage} from '../src/verification/task-contract-coverage.js';
import type {ComputerAction,Observation} from '../src/actions/schema.js';

const url='http://example.test/synthetic.html',title='Synthetic Planner Title',marker='SYNTHETIC-PLANNER-42';
const goal=`仅打开 ${url}，读取网页标题和页面唯一标记 ${marker}，并报告观察结果。只读，不访问其他地址，不点击、输入、下载或登录。
完成条件：最终 URL 为 ${url}，网页标题为 ${title}，页面正文含唯一标记 ${marker}。以实际页面 DOM 和最终 URL 独立核验。
操作限制：仅允许导航到 ${url} 并读取观察。禁止其他地址、第三方站点、账号登录、点击、输入、下载、文件或站点写入及 Native/VM 输入。`;
function raw(target=goal,field='windowTitleIncludes',source='window') {
  return JSON.stringify({environment:'browser',plan:['打开页面'],verificationContract:{goal:target,
    successConditions:{[field]:title},evidenceSources:{[field]:source},verifierStrategy:'rules_then_jev'}});
}
function plannedState(){
  const plan=parseTaskPlan(raw(),[],goal);
  return {...initialState('synthetic-planning',goal,plan.plan,plan.completionCriteria),
    verificationContract:plan.verificationContract,
    contractCoverage:auditTaskContractCoverage(goal,plan.completionCriteria),
    taskContract:{target:goal,environment:'browser' as const,constraint:'只读',stageActionLimit:4,taskActionLimit:4}};
}
function cleanup(dir:string){
  const path=resolve(dir);
  if(dirname(path)!==resolve(tmpdir())||!basename(path).startsWith('readonly-planning-'))throw Error('Unexpected temp path');
  rmSync(path,{recursive:true,force:true});
}

test('raw planning freezes all explicit page requirements before execution, replacing unsupported browser chrome',()=>{
  const state=plannedState();
  assert.deepEqual(state.verificationContract,readonlyBrowserContract(goal));
  assert.deepEqual(state.completionCriteria,{urlIncludes:url,domIncludes:`<title>${title}</title>`,pageTextIncludes:marker});
  assert.equal(state.contractCoverage.covered,true);
  assert.equal(readonlyBrowserStagePlan(state)?.isFinal,true,'initial blank page may have a final target');
  assert.throws(()=>parseTaskPlan(raw(goal,'invented','dom'),[],goal),/Success Conditions/);
});

test('unknown wording, added goals, inconsistent targets and legacy executing stages never get rewritten',()=>{
  for(const target of [goal+' 然后填写表单',goal.replace('并报告观察结果','并保存报告'),
    goal.replace(`最终 URL 为 ${url}`,`最终 URL 为 ${url}?other=1`),
    goal.replace(`正文含唯一标记 ${marker}`,`正文含唯一标记 OTHER-MARKER`)]){
    assert.equal(readonlyBrowserContract(target),undefined);
    assert.throws(()=>parseTaskPlan(raw(target),[],target),/window\/UIA/);
  }
  const state=plannedState();
  const stage={id:'legacy',goal:'中间阶段',successCondition:'旧条件',isFinal:false,startedAtStep:0,actionCount:0,planVersion:1};
  for(const changed of [{...state,stage},{...state,step:1},{...state,stagePlanVersion:1},
    {...state,recoveryRequired:true},{...state,taskContract:{...state.taskContract,environment:'windows' as const}},
    {...state,completionCriteria:{windowTitleIncludes:title}},{...state,contractCoverage:{...state.contractCoverage,covered:false}}])
    assert.equal(readonlyBrowserStagePlan(changed),undefined);
  assert.equal(stage.isFinal,false);
});

test('Browser rejects native window/UIA requirements before runtime, and explicit page text overrides use DOM',()=>{
  for(const [field,source] of [['windowTitleIncludes','window'],['accessibilityIncludes','uia'],['pageTextIncludes','uia']])
    assert.throws(()=>parseTaskPlan(raw('读取原生窗口',field,source),[],'读取原生窗口'),/window\/UIA/);
  const override=parseTaskPlan(raw('读取正文','pageTextIncludes','dom'),[],'读取正文',[],{pageTextIncludes:marker});
  assert.equal(override.verificationContract.evidenceSources.pageTextIncludes,'dom');
});

class PlanningModel extends FakeModel {
  stageCalls=0;
  async planStage(){this.stageCalls++;return {goal:'错误中间阶段',successCondition:'原生标题可见',isFinal:false};}
  async verifyStage(){return {ok:false,confidence:1,evidence:'截图没有浏览器标题栏',source:'visual_model' as const};}
}
class PlanningRuntime extends FakeRuntime {
  sequence=0;
  constructor(private readonly change?:(observation:Observation)=>void){super();}
  override async observe(){
    const current=await super.observe(),sequence=++this.sequence;
    const blank=current.url==='about:blank';
    const o:Observation={url:blank?'about:blank':url,
      dom:`<html><head><title>${blank?'Blank':title}</title></head><body>${blank?'Blank':marker}</body></html>`,
      pageText:blank?'Blank':marker,textEvidence:[{source:'dom',text:blank?'Blank':marker}],
      capture:{epoch:'synthetic',sequence,object:'page:synthetic',startedAt:sequence*10,finishedAt:sequence*10+1,
        clock:'collector',atomic:false,fields:{url:{complete:true,source:'api'},dom:{complete:true,source:'dom'},pageText:{complete:true,source:'dom'}}}};
    if(!blank)this.change?.(o);
    return o;
  }
}

test('planning -> frozen contract -> first final stage -> independent acceptance uses no auxiliary model or network',async t=>{
  const fetchMock=t.mock.method(globalThis,'fetch',async()=>{throw Error('No network permitted');});
  for(const variant of ['pass','wrong-title','missing-marker','partial-capture'] as const){
    const dir=mkdtempSync(join(tmpdir(),'readonly-planning-'));
    const trace=new SqliteTrace(join(dir,'trace.sqlite')),store=new WorkflowStore(join(dir,'workflows.sqlite'));
    const model=new PlanningModel([{kind:'navigate',url},{kind:'done',summary:'读取了标题和唯一标记'}]);
    const runtime=new PlanningRuntime(o=>{
      if(variant==='wrong-title')o.dom=o.dom!.replace(title,'Wrong Title');
      if(variant==='missing-marker'){o.pageText='Missing';o.textEvidence=[{source:'dom',text:'Missing'}];}
      if(variant==='partial-capture')o.capture!.fields.dom.complete=false;
    });
    const state=plannedState();
    try{
      const result=await createAgentLoop({model:new StageWorkflowModel(model,store,undefined,'browser'),runtime,trace,maxSteps:4}).invoke(state);
      assert.equal(model.stageCalls,0,'closed request uses Host planning before any action');
      assert.deepEqual(result.verificationContract,state.verificationContract,'frozen contract stays unchanged');
      assert.equal(runtime.executed.length,1);
      assert.equal(runtime.executed[0].kind,'navigate');
      if(variant==='pass'){
        assert.equal(result.status,'done');assert.equal(result.acceptanceReport?.verdict,'pass');
        assert.equal(result.goalVerification?.ok,true);assert.equal(result.acceptanceReport?.auxiliary,undefined);
      }else{assert.notEqual(result.status,'done',variant);assert.notEqual(result.goalVerification?.ok,true,variant);}
    }finally{trace.close();store.close();cleanup(dir);}
  }
  assert.equal(fetchMock.mock.calls.length,0);
});

test('the production stage action fence rejects input and every other URL before execution',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'readonly-planning-')),store=new WorkflowStore(join(dir,'workflows.sqlite'));
  const state=plannedState();
  const stage={id:'first',...readonlyBrowserStagePlan(state)!,startedAtStep:0,actionCount:0,planVersion:1};
  const actions:ComputerAction[]=[{kind:'navigate',url:url+'?other=1'},
    {kind:'click',target:{kind:'text',text:'Button'}},{kind:'type',text:'bad',target:{kind:'text',text:'Input'}}];
  try{
    for(const action of actions)await assert.rejects(new StageWorkflowModel(new FakeModel([action]),store,undefined,'browser').decide({...state,stage}),/单页只读/);
    const allowed=await new StageWorkflowModel(new FakeModel([{kind:'navigate',url}]),store,undefined,'browser').decide({...state,stage});
    assert.deepEqual(allowed,{kind:'navigate',url});
  }finally{store.close();cleanup(dir);}
});
