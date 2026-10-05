import {test} from 'node:test';
import assert from 'node:assert/strict';
import {actionEvidenceInput} from '../src/verification/action-evidence.js';
import {createLiveShadowVerifier} from '../src/verification/live-shadow.js';
import type {Observation,Target} from '../src/actions/schema.js';
import type {TargetBinding} from '../src/actions/semantic-target.js';

const target:Target={kind:'role',role:'Edit',name:'正文'};
const binding:TargetBinding={selected:target,strategy:'role',detail:'UIA 唯一匹配',context:{windowHandle:42}};
const action={kind:'type' as const,target,text:'新内容'};
function control(id:number,value:string,name='正文') {
  return {name,value,runtimeId:[1,id],nameComplete:true,valueComplete:true,role:'Edit',autoId:'body',
    className:'Edit',enabled:true,visible:true};
}
function observation(sequence:number,rows:ReturnType<typeof control>[]):Observation {
  const dom=JSON.stringify(rows);
  return {windowHandle:42,dom,accessibility:rows.map(r=>r.value).join('\n'),
    capture:{epoch:'e',object:'window:e:42',sequence,startedAt:sequence*100,finishedAt:sequence*100+1,
      clock:'collector',atomic:false,enumerationComplete:true,
      fields:{dom:{source:'uia',complete:true},accessibility:{source:'uia',complete:true}}}};
}
const verify=createLiveShadowVerifier({baseUrl:'http://test.invalid',apiKey:'test',instructions:()=>'',
  model:{async evaluate(){throw Error('Exact bound values must not reach JEV');}}});

test('same UIA runtimeId and exact value pass by rule without JEV',async()=>{
  const before=observation(1,[control(7,'旧'),{...control(8,'','旁边'),valueComplete:false}]);
  const after=observation(2,[control(7,'新内容'),{...control(8,'','旁边'),valueComplete:false}]);
  before.capture!.fields.dom.complete=false;after.capture!.fields.dom.complete=false;
  after.capture!.startedAt=21_500;after.capture!.finishedAt=21_503;
  const normalized=actionEvidenceInput('t',1,action,before,after,'dispatched',binding);
  assert.ok(normalized.input);
  assert.equal(normalized.input.before?.[0].value,'旧');
  assert.equal(normalized.input.evidence[0].object,'window:e:42:uia:[1,7]');
  const report=await verify(normalized.input);
  assert.equal(report.verdict,'pass');
  assert.equal(report.metrics.modelCalls,0);
});

test('same text in another control cannot stand in for the selected input',async()=>{
  const before=observation(1,[control(7,'旧'),control(8,'', '旁边')]);
  const after=observation(2,[control(7,'旧'),control(8,'新内容','旁边')]);
  const normalized=actionEvidenceInput('t',1,action,before,after,'dispatched',binding);
  assert.ok(normalized.input);
  const report=await verify(normalized.input);
  assert.equal(report.verdict,'fail');
  assert.equal(report.metrics.modelCalls,0);
});

test('target recreation, duplicate target, missing identity and uncertain dispatch stay blocked',()=>{
  const before=observation(1,[control(7,'旧')]);
  assert.equal(actionEvidenceInput('t',1,action,before,observation(2,[control(9,'新内容')]),
    'dispatched',binding).reason,'result_target_identity_or_value_unconfirmed');
  assert.equal(actionEvidenceInput('t',1,action,before,
    observation(2,[control(7,'新内容'),control(8,'新内容')]),'dispatched',binding).reason,
    'result_target_identity_or_value_unconfirmed');
  assert.equal(actionEvidenceInput('t',1,action,observation(1,[control(7,'旧'),control(8,'旧')]),
    observation(2,[control(7,'新内容')]),'dispatched',binding).reason,'baseline_target_not_unique');
  const noId=observation(1,[control(7,'旧')]);
  noId.dom=JSON.stringify([{...control(7,'旧'),runtimeId:null}]);
  assert.equal(actionEvidenceInput('t',1,action,noId,observation(2,[control(7,'新内容')]),
    'dispatched',binding).reason,'baseline_target_identity_or_value_incomplete');
  const partial=observation(2,[{...control(7,'新内容'),valueComplete:false}]);
  assert.equal(actionEvidenceInput('t',1,action,before,partial,'dispatched',binding).reason,
    'result_target_identity_or_value_unconfirmed');
  assert.equal(actionEvidenceInput('t',1,action,before,observation(2,[control(7,'新内容')]),
    'uncertain',binding).reason,'action_dispatch_not_confirmed');
});

test('incomplete, changed or stale boundaries never produce a positive result',()=>{
  const before=observation(1,[control(7,'旧')]),after=observation(2,[control(7,'新内容')]);
  after.windowHandle=43;
  assert.equal(actionEvidenceInput('t',1,action,before,after,'dispatched',binding).reason,
    'missing_bound_input_target');
  after.windowHandle=42;
  after.capture!.epoch='other';
  assert.equal(actionEvidenceInput('t',1,action,before,after,'dispatched',binding).reason,'capture_identity_changed');
  after.capture!.epoch='e';after.capture!.enumerationComplete=false;
  assert.equal(actionEvidenceInput('t',1,action,before,after,'dispatched',binding).reason,
    'missing_original_target_controls');
  after.capture!.enumerationComplete=true;after.capture!.startedAt=70_000;after.capture!.finishedAt=70_001;
  assert.equal(actionEvidenceInput('t',1,action,before,after,'dispatched',binding).reason,'partial_or_stale_baseline');
  after.capture!.startedAt=200;after.capture!.finishedAt=201;
  assert.equal(actionEvidenceInput('t',1,action,observation(1,[control(7,'新内容')]),after,
    'dispatched',binding).reason,'input_already_present_before_action');
  assert.equal(actionEvidenceInput('t',1,action,before,after,'dispatched').reason,'missing_bound_input_target');
});

test('unformalized actions remain blocked',()=>{
  assert.equal(actionEvidenceInput('t',1,{kind:'click',target},observation(1,[control(7,'旧')]),
    observation(2,[control(7,'新内容')]),'dispatched',binding).reason,'action_postcondition_not_formalized');
});

test('navigation and declared click URL outcomes use collector URL, never screen changes',async()=>{
  const before=observation(1,[]),after=observation(2,[]);
  before.url='https://example.test/start';after.url='https://example.test/result';
  before.capture!.fields.url={source:'api',complete:true};after.capture!.fields.url={source:'api',complete:true};
  const navigate=actionEvidenceInput('t',2,{kind:'navigate',url:after.url},before,after,'dispatched');
  assert.ok(navigate.input);assert.equal((await verify(navigate.input)).verdict,'pass');
  const click=actionEvidenceInput('t',2,{kind:'click',target:{kind:'role',role:'link',name:'结果'},
    postcondition:{kind:'url_includes',value:'/result'}},before,after,'dispatched');
  assert.ok(click.input);assert.equal((await verify(click.input)).verdict,'pass');
  const wrong=actionEvidenceInput('t',2,{kind:'keypress',keys:'Enter',
    postcondition:{kind:'url_equals',value:'https://example.test/other'}},before,after,'dispatched');
  assert.ok(wrong.input);assert.equal((await verify(wrong.input)).verdict,'fail');
  before.url=after.url;
  assert.equal(actionEvidenceInput('t',2,{kind:'navigate',url:after.url},before,after,'dispatched').reason,
    'postcondition_already_satisfied_before_action');
  before.capture!.fields.url.complete=false;
  assert.equal(actionEvidenceInput('t',2,{kind:'navigate',url:after.url},before,after,'dispatched').reason,
    'missing_original_url_evidence');
});

test('declared UIA appearance requires unique new identity and complete enumeration',async()=>{
  const declared={kind:'uia_present' as const,target:{kind:'role' as const,role:'TabItem',name:'新标签'}};
  const click={kind:'click' as const,target:{kind:'role' as const,role:'Button',name:'添加'},
    postcondition:declared};
  const tab={...control(9,'','新标签'),role:'TabItem'};
  const before=observation(1,[]),after=observation(2,[tab]);
  const found=actionEvidenceInput('t',2,click,before,after,'dispatched');
  assert.ok(found.input);assert.equal((await verify(found.input)).verdict,'pass');
  const absent=actionEvidenceInput('t',2,click,before,observation(2,[]),'dispatched');
  assert.ok(absent.input);assert.equal((await verify(absent.input)).verdict,'fail');
  assert.equal(actionEvidenceInput('t',2,click,observation(1,[tab]),after,'dispatched').reason,
    'postcondition_already_satisfied_before_action');
  assert.equal(actionEvidenceInput('t',2,click,before,observation(2,[tab,{...tab,runtimeId:[1,10]}]),
    'dispatched').reason,'result_target_not_unique');
  const hidden=observation(1,[{...tab,name:'新标',nameComplete:false}]);
  assert.equal(actionEvidenceInput('t',2,click,hidden,after,'dispatched').reason,'ui_target_name_incomplete');
  after.capture!.enumerationComplete=false;
  assert.equal(actionEvidenceInput('t',2,click,before,after,'dispatched').reason,'missing_original_target_controls');
});
