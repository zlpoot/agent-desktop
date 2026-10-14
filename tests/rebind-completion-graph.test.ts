import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {FakeModel} from '../src/agent/model-adapter.js';
import {FakeRuntime} from '../src/runtime/runtime-adapter.js';
import {createAgentLoop,type AgentLoopOptions} from '../src/graph/graph.js';
import {initialState} from '../src/graph/state.js';
import {SqliteTrace} from '../src/trace/sqlite-trace.js';
import type {Observation,ComputerAction} from '../src/actions/schema.js';
import {verifyGoal,type CompletionCriteria} from '../src/verifier/verifier.js';
import type {PlannedVerificationContract} from '../src/agent/task-planner.js';
import type {ComputerState} from '../src/graph/state.js';
import {canManuallyReviewOutcome,reviewManualOutcome} from '../src/verification/manual-review.js';
import {FacetRegistry,type ObservationFacetProvider} from '../src/contracts/facets.js';
import {ContributorRegistry,type VerifierContributor} from '../src/contracts/verifier-contributor.js';
import {createDomainEvaluator} from '../src/verification/domain-evaluator.js';

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
  reboundTitle='客户资料';
  constructor(readonly terminal:(observation:Observation)=>Observation=observation=>observation) {super();}
  override async observe():Promise<Observation> {
    const step=this.executed.length;
    const observation:Observation={windowTitle:step===4?this.reboundTitle:'客户资料',pageText:`合成界面 ${step}`,
      dom:JSON.stringify(step===3?[]:[{role:'Edit',name:'手机号',
        value:step===0?OLD:NEW,runtimeId:step<4?[7,1]:[7,2],
        nameComplete:true,valueComplete:true,visible:true}]),
      capture:{epoch:'fixture-e',sequence:++this.sequence,object:'window:fixture-e:42',
        startedAt:Date.now(),finishedAt:Date.now()+0.5,clock:'collector',atomic:false,
        enumerationComplete:true,fields:{dom:{source:'uia',complete:true},
          pageText:{source:'uia',complete:true}}}};
    observation.textEvidence=[{source:'uia',text:observation.pageText!}];
    // The completion read is after the observe following the fourth action.
    return step===4&&this.sequence>5?this.terminal(observation):observation;
  }
}

async function run(terminal:(observation:Observation)=>Observation,
  conditions=criteria,contract:PlannedVerificationContract|null=frozen(conditions),
  options:Partial<AgentLoopOptions>={},statePatch:Partial<ComputerState>={},expectRebound=true,
  reboundTitle='客户资料') {
  const dir=mkdtempSync(join(tmpdir(),'b5a-graph-'));
  const trace=new SqliteTrace(join(dir,'trace.sqlite'));
  const runtime=new RebindRuntime(terminal);
  runtime.reboundTitle=reboundTitle;
  try {
    const state={...initialState('b5a-fixture',goal,undefined,structuredClone(conditions)),
      verificationContract:contract??undefined,...statePatch};
    const result=await createAgentLoop({model:new FakeModel(actions),runtime,trace,maxSteps:6,...options})
      .invoke(state,{recursionLimit:100});
    const events=trace.events(state.taskId);
    if(process.env.B5A_EVIDENCE_DIR) {
      mkdirSync(process.env.B5A_EVIDENCE_DIR,{recursive:true});
      writeFileSync(join(process.env.B5A_EVIDENCE_DIR,`trace-${runNumber++}.json`),
        JSON.stringify({result,events,executed:runtime.executed},null,2));
    }
    assert.equal(runtime.executed.length,4,'save/navigation actions must not replay');
    const chain=events.filter(event=>event.node==='verify').at(-1)?.state.rebindState?.[0];
    assert.equal(chain?.baseline?.runtimeId,'[7,1]');
    assert.ok(chain?.editedSequence!<chain?.committedSequence!);
    assert.ok(chain?.committedSequence!<chain?.absentSequence!);
    if(expectRebound) {
      assert.ok(chain?.absentSequence!<chain?.rebound?.sequence!);
      assert.equal(chain?.rebound?.runtimeId,'[7,2]');
    } else assert.equal(chain?.rebound,undefined,'missing rebind proof must stay missing');
    const acceptance=events.filter(event=>event.node==='acceptance_task').at(-1);
    assert.ok(acceptance,'raw Trace must retain the terminal acceptance');
    assert.deepEqual(acceptance.state.acceptanceReport,JSON.parse(JSON.stringify(result.acceptanceReport)));
    if(!result.goalVerification?.ok) {
      const paused={...result,status:'paused' as const};
      assert.equal(canManuallyReviewOutcome(paused),false,'Manual cannot upgrade missing/contradicted proof');
      assert.throws(()=>reviewManualOutcome(paused,true,'人工声称已完成'),/不符合/);
      assert.equal(result.humanReview,undefined);
      assert.equal(result.acceptanceReport?.auxiliary,undefined);
      assert.equal(result.finalReviewPending??false,false);
    }
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

test('B5a Graph: original verifyGoal FAIL cannot be overwritten by rebind PASS',async()=>{
  const {result,events}=await run(observation=>observation,criteria,frozen(),{}, {},true,'其他窗口');
  const beforeComplete=events.filter(event=>event.node==='decide').at(-1)!.state;
  assert.equal(verifyGoal(criteria,beforeComplete.observation).ok,false);
  assert.equal(result.status,'waiting_user');
  assert.equal(result.goalVerification?.ok,false);
  assert.equal(result.acceptanceReport?.verdict,'fail');
  assert.deepEqual(result.acceptanceReport?.checks.map(check=>[check.criterion,check.verdict]),
    [['windowTitleIncludes','fail'],['structuredStates:0','pass']]);
});

for(const scenario of ['missing title','wrong title source','missing structured source',
  'wrong structured source','missing contract','goal drift','criteria drift','extra source',
  'read throws','incomplete enumeration','incomplete structured stamp','old sequence',
  'epoch drift','object drift'] as const) test(`B5a Graph UNKNOWN: ${scenario}`,async()=>{
  const contract=frozen();
  if(scenario==='wrong title source')contract.evidenceSources.windowTitleIncludes='uia';
  if(scenario==='missing structured source')delete contract.evidenceSources.structuredStates;
  if(scenario==='wrong structured source')contract.evidenceSources.structuredStates='dom';
  if(scenario==='goal drift')contract.goal='另一个目标';
  if(scenario==='criteria drift')delete contract.successConditions.windowTitleIncludes;
  if(scenario==='extra source')contract.evidenceSources.unfrozen='uia';
  const {result,events}=await run(observation=>{
    if(scenario==='read throws')throw Error('synthetic completion read unavailable');
    if(scenario==='missing title')delete observation.windowTitle;
    if(scenario==='incomplete enumeration')observation.capture!.enumerationComplete=false;
    if(scenario==='incomplete structured stamp')observation.capture!.fields.dom.complete=false;
    if(scenario==='old sequence')observation.capture!.sequence--;
    if(scenario==='epoch drift')observation.capture!.epoch='other-epoch';
    if(scenario==='object drift')observation.capture!.object='window:other';
    return observation;
  },criteria,scenario==='missing contract'?null:contract);
  assert.equal(result.status,'waiting_user');
  assert.equal(result.goalVerification?.ok,false);
  assert.equal(result.acceptanceReport?.verdict,'unknown');
  assert.ok(result.acceptanceReport?.checks.some(check=>check.verdict==='unknown'&&check.reason));
  assert.equal(events.filter(event=>event.node==='acceptance_task').at(-1)?.state.observation?.capture?.sequence,
    ['read throws','old sequence','epoch drift','object drift'].includes(scenario)?undefined:6);
});

for(const key of ['domIncludes','accessibilityIncludes','pageTextIncludes'] as const) {
  for(const scenario of (key==='domIncludes'?['missing','wrong source']:['missing','wrong source','partial','pass']) as
    Array<'missing'|'wrong source'|'partial'|'pass'>)
    test(`B5a mixed scalar ${key}: ${scenario}`,async()=>{
      const conditions={...criteria,[key]:'合成附加证据'};
      const contract=frozen(conditions);
      contract.evidenceSources[key]=key==='domIncludes'?'dom':'uia';
      const {result}=await run(observation=>{
        const field=key==='domIncludes'?'dom':key==='accessibilityIncludes'?'accessibility':'pageText';
        // For DOM this is deliberately a source mismatch with the UIA rebind;
        // there is no compatible same-capture DOM+UIA proof in this fixture.
        if(key!=='domIncludes') {
          if(scenario!=='missing')observation[field]='合成附加证据';
          else delete observation[field];
          observation.capture!.fields[field]={source:scenario==='wrong source'?'dom':'uia',
            complete:scenario!=='partial'};
          if(field==='pageText'&&scenario!=='missing')
            observation.textEvidence=[{source:'uia',text:observation.pageText!}];
        }
        return observation;
      },conditions,contract);
      const pass=key!=='domIncludes'&&scenario==='pass';
      assert.equal(result.acceptanceReport?.verdict,pass?'pass':'unknown');
      assert.equal(result.goalVerification?.ok,pass);
      assert.equal(result.status,pass?'done':'waiting_user');
      assert.equal(result.acceptanceReport?.checks.find(check=>check.criterion===key)?.verdict,pass?'pass':'unknown');
    });
}

const extraCondition:NonNullable<CompletionCriteria['structuredStates']>[number]=
  {target:{role:'Edit',name:'备注'},field:'value',equals:'正确备注'};
for(const scenario of ['pass','wrong value','missing target','ambiguous target'] as const)
  test(`B5a ordinary structured: ${scenario}`,async()=>{
    const conditions={...criteria,structuredStates:[...criteria.structuredStates!,extraCondition]};
    const {result}=await run(observation=>{
      const controls=JSON.parse(observation.dom!);
      const control={role:'Edit',name:'备注',value:scenario==='wrong value'?'错误备注':'正确备注',
        runtimeId:[8,1],nameComplete:true,valueComplete:true,visible:true};
      if(scenario!=='missing target')controls.push(control);
      if(scenario==='ambiguous target')controls.push({...control,runtimeId:[8,2]});
      observation.dom=JSON.stringify(controls);
      return observation;
    },conditions);
    const verdict=scenario==='pass'?'pass':scenario==='wrong value'?'fail':'unknown';
    assert.equal(result.acceptanceReport?.verdict,verdict);
    assert.equal(result.goalVerification?.ok,verdict==='pass');
    assert.equal(result.status,verdict==='pass'?'done':verdict==='fail'?'failed':'waiting_user');
    const check=result.acceptanceReport?.checks.find(check=>check.criterion==='structuredStates:1');
    assert.equal(check?.verdict,verdict);
    assert.equal(check?.evidence?.captureSequence,6);
    if(scenario==='ambiguous target')assert.equal(check?.reason,'target_ambiguous');
  });

test('B5a Graph: unknown criterion is retained and blocks completion',async()=>{
  const conditions={...criteria,unsupportedFixtureKey:'unrecognized'};
  const {result}=await run(observation=>observation,conditions);
  assert.equal(result.acceptanceReport?.verdict,'unknown');
  assert.equal(result.goalVerification?.ok,false);
  assert.equal(result.acceptanceReport?.checks.find(check=>check.criterion==='unsupportedFixtureKey')?.reason,
    'unsupported_condition');
});

test('B5a Graph: a trusted FAIL outranks a different condition UNKNOWN',async()=>{
  const conditions={...criteria,accessibilityIncludes:'额外证据'};
  const contract=frozen(conditions);contract.evidenceSources.accessibilityIncludes='uia';
  const {result}=await run(observation=>({...observation,windowTitle:'其他窗口'}),conditions,contract);
  assert.equal(result.acceptanceReport?.verdict,'fail');
  assert.equal(result.goalVerification?.ok,false);
  assert.equal(result.acceptanceReport?.checks.find(check=>check.criterion==='accessibilityIncludes')?.verdict,'unknown');
});

test('B5a Graph: an ordinary stale save banner cannot borrow the rebind proof',async()=>{
  const conditions={...criteria,structuredStates:[...criteria.structuredStates!,
    {target:{role:'Text',name:'结果'},field:'text' as const,equals:'已保存'}]};
  const {result}=await run(observation=>{
    const controls=JSON.parse(observation.dom!);
    controls.push({role:'Text',name:'结果',value:'已保存',runtimeId:[9],
      visible:true,nameComplete:true,valueComplete:true});
    // UIA text is name, so expose expected text in a structured snapshot.
    observation.structured={source:'uia',complete:true,items:[
      {role:'Text',name:'结果',text:'已保存',complete:true}]};
    observation.capture!.fields.structured={source:'uia',complete:true};
    return observation;
  },conditions,frozen(conditions),{},
  {baselineChecks:[{criterion:'structuredStates:1',verdict:'pass',message:'pre-existing result'}]});
  assert.equal(result.acceptanceReport?.verdict,'unknown');
  assert.equal(result.acceptanceReport?.checks.find(check=>check.criterion==='structuredStates:1')?.reason,'observation_stale');
});

test('B5a Graph: final R1 contradicts expected value -> attributable terminal FAIL, no replay',async()=>{
  const {result}=await run(observation=>{
    const controls=JSON.parse(observation.dom!);controls[0].value=OLD;
    observation.dom=JSON.stringify(controls);return observation;
  });
  assert.equal(result.status,'failed');
  assert.equal(result.goalVerification?.ok,false);
  assert.equal(result.acceptanceReport?.verdict,'fail');
  assert.equal(result.acceptanceReport?.checks.find(check=>check.criterion==='windowTitleIncludes')?.verdict,'pass');
  assert.equal(result.acceptanceReport?.checks.find(check=>check.criterion==='structuredStates:0')?.evidence?.actual,OLD);
});

test('B5a Graph: Stage/JEV cannot promote missing rebind evidence',async()=>{
  let stageCalls=0,acceptanceCalls=0;
  class StageModel extends FakeModel {
    async planStage() {return {goal:'保存字段',successCondition:'看似保存',isFinal:true};}
    async verifyStage() {stageCalls++;return {ok:true,confidence:1,evidence:'weak visual claim',source:'visual_model' as const};}
  }
  const {result}=await run(observation=>{observation.capture!.enumerationComplete=false;return observation;},
    criteria,frozen(),{model:new StageModel(actions),acceptanceVerifier:{async evaluate(){
      acceptanceCalls++;throw Error('must not call auxiliary acceptance');}}},
    {taskContract:{target:goal,constraint:'合成任务',stageActionLimit:6,taskActionLimit:6},
      stage:{id:'final',goal:'保存字段',successCondition:'看似保存',isFinal:true,
        startedAtStep:0,actionCount:0,planVersion:1}},false);
  assert.equal(result.status,'waiting_user');
  assert.equal(result.acceptanceReport?.verdict,'unknown');
  assert.notEqual(result.goalVerification?.ok,true);
  // Frozen final checks take precedence even over fake Stage/JEV PASS claims.
  assert.equal(stageCalls,0);assert.equal(acceptanceCalls,0);
});

const domain='test.b5a';
function domainFixture(refs=true) {
  const provider:ObservationFacetProvider={id:domain,schemaVersion:1,providerVersion:'1',
    environment:'windows',source:'uia',validate:()=>({ok:true}),
    async collect(){return {complete:true,data:{value:1}};}};
  const contributor:VerifierContributor={id:domain,criterionSchemaVersion:1,
    canEvaluate:()=>true,validateCriterion:()=>({ok:true}),evaluate(criterion,bound){
      const facet=bound.requireFacet(domain);
      const actual=(facet.data as {value:number}).value;
      return {verdict:actual===criterion.args.value?'pass':'fail',criterionSchemaVersion:1,
        message:'synthetic domain predicate',evidenceRefs:refs?[{facetId:domain,captureId:bound.captureId,
          subjectRef:bound.subject,providerVersion:facet.providerVersion,schemaVersion:1}]:[]};
    }};
  const facets=new FacetRegistry();facets.register(provider);
  class RevocableRegistry extends ContributorRegistry {
    active=true;
    override get(id:string) {return this.active?super.get(id):undefined;}
  }
  const contributors=new RevocableRegistry();contributors.register(contributor);
  return {provider,contributors,domainEvaluator:createDomainEvaluator(contributors,facets)};
}
for(const scenario of ['pass','fail','unregistered','revoked','no refs'] as const)
  test(`B5a Graph Domain/FACET: ${scenario}`,async()=>{
    const fixture=domainFixture(scenario!=='no refs');
    if(scenario==='unregistered')fixture.contributors.active=false;
    const conditions={...criteria,domainChecks:[{domain,predicate:'equals',args:{value:scenario==='fail'?2:1}}]};
    const {result,events}=await run(observation=>{
      if(scenario==='revoked')fixture.contributors.active=false;
      return observation;
    },conditions,frozen(conditions),{facetProviders:[fixture.provider],domainEvaluator:fixture.domainEvaluator});
    const verdict=scenario==='pass'?'pass':scenario==='fail'?'fail':'unknown';
    assert.equal(result.acceptanceReport?.verdict,verdict);
    assert.equal(result.status,verdict==='pass'?'done':'waiting_user');
    assert.equal(result.goalVerification?.ok,verdict==='pass');
    const check=result.acceptanceReport?.checks.find(check=>check.criterion.startsWith('domainChecks:'));
    assert.equal(check?.verdict,verdict);assert.ok(check?.domainAudit);
    assert.equal(check.domainAudit.captureId,'fixture-e:6');
    if(verdict!=='unknown')assert.equal(check.domainAudit.evidenceRefs[0]?.captureId,'fixture-e:6');
    if(verdict==='pass')assert.ok(result.goalVerification?.evidence?.some(item=>item.source===domain));
    assert.ok(events.some(event=>event.node==='acceptance_task'&&
      event.state.acceptanceReport?.checks.some(item=>item.domainAudit?.captureId==='fixture-e:6')));
  });

test('B5a Graph: rebind PASS plus every remaining frozen condition PASS completes',async()=>{
  const {result}=await run(observation=>observation);
  assert.equal(result.status,'done');
  assert.equal(result.goalVerification?.ok,true);
  assert.equal(result.acceptanceReport?.verdict,'pass');
  assert.deepEqual(result.acceptanceReport?.checks.map(check=>[check.criterion,check.verdict]),
    [['windowTitleIncludes','pass'],['structuredStates:0','pass']]);
  assert.equal(result.goalVerification?.evidence?.find(item=>item.criterion==='windowTitleIncludes')?.source,'window');
});

test('B5a Graph: a single correct R1 snapshot cannot replace the persistence chain',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'b5a-graph-'));
  const trace=new SqliteTrace(join(dir,'trace.sqlite'));
  class SnapshotRuntime extends RebindRuntime {
    override async observe() {
      const observation=await super.observe();
      const controls=JSON.parse(observation.dom!);
      controls[0].value=NEW;controls[0].runtimeId=[7,2];
      observation.dom=JSON.stringify(controls);return observation;
    }
  }
  const runtime=new SnapshotRuntime();
  try {
    const result=await createAgentLoop({model:new FakeModel([{kind:'done',summary:'单快照声明'}]),
      runtime,trace,maxSteps:2}).invoke({...initialState('b5a-snapshot',goal,undefined,criteria),
        verificationContract:frozen()});
    assert.equal(result.status,'waiting_user');
    assert.equal(result.goalVerification?.ok,false);
    assert.equal(result.acceptanceReport?.verdict,'unknown');
    assert.equal(result.acceptanceReport?.checks.find(check=>check.criterion==='structuredStates:0')?.verdict,'unknown');
    assert.match(result.acceptanceReport?.message??'',/missing_rebind_baseline/);
    assert.equal(runtime.executed.length,0);
    assert.equal(canManuallyReviewOutcome({...result,status:'paused'}),false);
    const events=trace.events('b5a-snapshot');
    assert.ok(events.some(event=>event.node==='verify_task'&&event.state.goalVerification?.ok===false));
    if(process.env.B5A_EVIDENCE_DIR)writeFileSync(join(process.env.B5A_EVIDENCE_DIR,'trace-snapshot.json'),
      JSON.stringify({result,events,executed:runtime.executed},null,2));
  }finally{
    trace.close();const target=resolve(dir);
    if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('b5a-graph-'))
      throw Error('Refusing to remove an unexpected test directory');
    rmSync(target,{recursive:true,force:true});
  }
});
