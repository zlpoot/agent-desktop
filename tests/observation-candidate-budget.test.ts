import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyCandidateObservation} from '../src/observation/candidate-budget.js';
import type {Observation} from '../src/actions/schema.js';

const observed = (): Observation => ({url:'https://example.test/source',
  pageText:'完整正文 '.repeat(15)+'尾部目标',structured:{source:'dom',complete:false,
    candidateCount:501,retainedCount:500,candidateBudget:500,budgetSaturated:true,items:[]}});

test('A5: bounded observation miss 属 observation；饱和不覆盖 captured / C8 / C9 / undetermined',()=>{
  const obs=observed();
  assert.equal(classifyCandidateObservation(obs,'尾部目标').reason,'observation_budget_exhausted');
  obs.structured!.items=[{role:'link',text:'尾部目标'}];
  assert.equal(classifyCandidateObservation(obs,'尾部目标').reason,'captured');
  obs.structured!.items=[];
  assert.equal(classifyCandidateObservation(obs,'不存在').reason,'undetermined');
  assert.equal(classifyCandidateObservation(obs,'源页目标',{observation:{url:'https://example.test/other',
    pageText:'源页目标',items:[]}}).reason,'wrong-page-contract');
  obs.pageText='搜索';
  assert.equal(classifyCandidateObservation(obs,'尾部目标').reason,'not-rendered');
});

test('A5: complete=false 不等于预算耗尽；legacy metadata 缺失不猜 saturation',()=>{
  const obs=observed();
  obs.structured!.budgetSaturated=false;
  assert.equal(classifyCandidateObservation(obs,'尾部目标').reason,'observation_evidence_gap');
  delete obs.structured!.budgetSaturated;
  const legacy=classifyCandidateObservation(obs,'尾部目标');
  assert.equal(legacy.reason,'observation_evidence_gap');
  assert.equal(legacy.budget.budgetSaturated,null);
});
