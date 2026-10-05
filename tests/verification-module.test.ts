import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VerificationEngine } from '../src/verification/engine.js';
import { verificationCases } from './fixtures/verification-cases.js';
import type { AuxiliaryVerifier, VerificationInput } from '../src/verification/contracts.js';

for(const c of verificationCases) test(`验收模块 ${c.id}`,async()=>{
  const engine=new VerificationEngine({}, {async evaluate(){throw new Error('规则用例不应调用模型');}});
  const result=await engine.verify(c.input);
  assert.equal(result.verdict,c.expected);assert.equal(result.metrics.modelCalls,0);
  assert.equal(result.metrics.inputTokens+result.metrics.outputTokens,0);
});
function semantic():VerificationInput {
  const x=structuredClone(verificationCases[0].input);
  x.contract.criteria[0].predicate={op:'semantic',instruction:'证据说明操作已结束且没有错误'};return x;
}
const good:AuxiliaryVerifier={async evaluate(q){return{answers:q.map(x=>({id:x.id,verdict:'pass',confidence:.95})),usage:{inputTokens:20,outputTokens:5}};}};
test('语义默认仅建议；显式试验策略才允许模型放行',async()=>{
  const advisory=await new VerificationEngine({},good).verify(semantic());
  assert.equal(advisory.verdict,'unknown');assert.equal(advisory.checks[0].reason,'model_pass_requires_review');
  const enabled=await new VerificationEngine({allowModelPass:true},good).verify(semantic());
  assert.equal(enabled.verdict,'pass');assert.equal(enabled.metrics.modelCalls,1);assert.equal(enabled.metrics.inputTokens,20);
});
test('只发送相关证据、合并语义问题；确定性反证跳过模型',async()=>{
  let calls=0;
  const model:AuxiliaryVerifier={async evaluate(q){calls++;assert.equal(q.length,2);assert.equal(q[0].evidence.length,1);return good.evaluate(q,new AbortController().signal);}};
  const x=semantic();x.contract.criteria.push({...x.contract.criteria[0],id:'meaning2'});
  x.evidence.push({...x.evidence[0],id:'irrelevant',object:'unrelated',value:'large irrelevant data'});
  await new VerificationEngine({},model).verify(x);assert.equal(calls,1);
  x.contract.criteria.push({...x.contract.criteria[0],id:'exact',predicate:{op:'equals',expected:'wrong'}});
  assert.equal((await new VerificationEngine({},model).verify(x)).verdict,'fail');assert.equal(calls,1);
});
test('缺失或冲突不让模型猜；payload 超预算不截断冒充完整证据',async()=>{
  const x=semantic();x.evidence=[];
  assert.equal((await new VerificationEngine({},good).verify(x)).metrics.modelCalls,0);
  const large=semantic();large.evidence[0].value='x'.repeat(7000);
  const result=await new VerificationEngine({},good).verify(large);
  assert.equal(result.metrics.modelCalls,0);assert.equal(result.checks[0].reason,'model_budget_exceeded');
});
test('模型超时、无效回答、低置信度均不放行',async()=>{
  const stalled:AuxiliaryVerifier={evaluate(_q,signal){return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))));}};
  assert.equal((await new VerificationEngine({modelTimeoutMs:10},stalled).verify(semantic())).verdict,'unknown');
  const invalid:AuxiliaryVerifier={async evaluate(){return{answers:[{id:'wrong-id',verdict:'pass',confidence:1}]};}};
  assert.equal((await new VerificationEngine({allowModelPass:true},invalid).verify(semantic())).verdict,'unknown');
  const low:AuxiliaryVerifier={async evaluate(q){return{answers:q.map(x=>({id:x.id,verdict:'pass',confidence:.4}))};}};
  assert.equal((await new VerificationEngine({allowModelPass:true},low).verify(semantic())).verdict,'unknown');
});
test('会话或观察改变后不复用历史成功',async()=>{
  const engine=new VerificationEngine();const x=structuredClone(verificationCases[0].input);
  assert.equal((await engine.verify(x)).verdict,'pass');x.session='new-session';
  assert.equal((await engine.verify(x)).verdict,'unknown');
});
