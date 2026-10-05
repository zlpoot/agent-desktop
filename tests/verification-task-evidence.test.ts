import {test} from 'node:test';
import assert from 'node:assert/strict';
import {taskEvidenceInput} from '../src/verification/task-evidence.js';
import {createLiveShadowVerifier} from '../src/verification/live-shadow.js';
import type {Observation} from '../src/actions/schema.js';
function observation(value:string):Observation{return {pageText:value,textEvidence:[{source:'dom',text:value}],
  capture:{epoch:'e',object:'page',sequence:2,startedAt:20,finishedAt:21,clock:'collector',atomic:false,
    fields:{pageText:{source:'dom',complete:true}}}};}
test('task contract checks independent field condition and original goal separately',async()=>{
  const normalized=taskEvidenceInput('t','在桌面保存报告文件',{pageTextIncludes:'报告已生成'},
    observation('报告已生成'));
  assert.ok(normalized.input);
  assert.deepEqual(normalized.input.contract.requirements,['pageTextIncludes','original-task-goal']);
  const verifier=createLiveShadowVerifier({baseUrl:'http://test.invalid',apiKey:'x',instructions:()=>'',model:{
    async evaluate(questions){assert.equal(questions[0].context?.scope,'task');
      assert.match(questions[0].instruction,/在桌面保存报告文件/);
      return {answers:[{id:'original-task-goal',verdict:'unknown',confidence:1}]};}}});
  const report=await verifier(normalized.input);
  assert.equal(report.checks[0].verdict,'pass');
  assert.equal(report.checks[1].verdict,'unknown');
  assert.equal(report.verdict,'unknown');
});
test('unsupported completion conditions cannot be silently dropped',()=>{
  assert.equal(taskEvidenceInput('t','goal',{unknownCriterion:1} as never,observation('done')).reason,
    'unsupported_task_criterion');
  assert.equal(taskEvidenceInput('t','goal',{},observation('done')).reason,'missing_independent_task_criteria');
});
test('browser URL criterion requires collector-stamped API URL',async()=>{
  const current=observation('完成');current.url='https://example.test/done';
  current.capture!.fields.url={source:'api',complete:true};
  const normalized=taskEvidenceInput('t','访问完成页',{urlIncludes:'/done'},current);
  assert.ok(normalized.input);
  const report=await createLiveShadowVerifier({baseUrl:'http://test.invalid',apiKey:'x',instructions:()=>'',model:{
    async evaluate(questions){return {answers:questions.map(q=>({id:q.id,verdict:'unknown',confidence:1}))};}
  }})(normalized.input);
  assert.equal(report.checks[0].verdict,'pass');
  assert.equal(report.verdict,'unknown');
  delete current.capture!.fields.url;
  assert.equal(taskEvidenceInput('t','访问完成页',{urlIncludes:'/done'},current).input?.evidence
    .some(e=>e.field==='url'),false);
});
test('incomplete original text leaves task unverified and does not call model',async()=>{
  const current=observation('完成');current.capture!.fields.pageText.complete=false;
  const normalized=taskEvidenceInput('t','goal',{pageTextIncludes:'完成'},current);
  assert.ok(normalized.input);
  let calls=0;
  const report=await createLiveShadowVerifier({baseUrl:'http://test.invalid',apiKey:'x',instructions:()=>'',model:{
    async evaluate(){calls++;throw Error('unexpected');}}})(normalized.input);
  assert.equal(report.verdict,'unknown');assert.equal(calls,0);
});
