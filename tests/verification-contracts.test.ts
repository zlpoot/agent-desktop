import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VerificationEngine } from '../src/verification/engine.js';
import type { VerificationInput } from '../src/verification/contracts.js';

function fixture(): VerificationInput {
  return {session:'s',now:100,notBefore:50,contract:{id:'c',scope:'stage',requirements:['r'],criteria:[
    {id:'a',requirement:'r',object:'object',field:'status',sources:['api'],predicate:{op:'equals',expected:'ok'}}]},
    evidence:[{id:'e',session:'s',object:'object',field:'status',source:'api',value:'ok',complete:true,capturedAt:80,revision:'v1'}]};
}
test('independent specification detects omitted or weakened requirements',async()=>{
  const x=fixture();x.specification=structuredClone(x.contract);
  x.specification.requirements.push('destination');
  x.specification.criteria.push({...x.specification.criteria[0],id:'destination',requirement:'destination',field:'path'});
  let result=await new VerificationEngine().verify(x);
  assert.equal(result.verdict,'unknown');assert.equal(result.checks[0].reason,'specification_not_covered');
  x.specification=structuredClone(x.contract);x.contract.criteria[0].predicate={op:'contains',expected:'o'};
  result=await new VerificationEngine().verify(x);assert.equal(result.verdict,'unknown');assert.equal(result.metrics.modelCalls,0);
});
test('cross-field revisions must match, separate objects can have different versions',async()=>{
  const x=fixture();x.contract.criteria.push({...x.contract.criteria[0],id:'b',field:'other'});
  x.evidence.push({...x.evidence[0],id:'b',field:'other',revision:'v2'});
  assert.equal((await new VerificationEngine().verify(x)).verdict,'unknown');
  x.contract.criteria[1].object='another';x.evidence[1].object='another';
  assert.equal((await new VerificationEngine().verify(x)).verdict,'pass');
});
test('new revision invalidates a requested old revision, even if values still agree',async()=>{
  const x=fixture();x.contract.criteria[0].revision='v1';
  x.evidence.push({...x.evidence[0],id:'new',revision:'v2',capturedAt:90});
  assert.equal((await new VerificationEngine().verify(x)).verdict,'unknown');
});
test('explicit outcomes distinguish pending, failure, success and unknown state without model calls',async()=>{
  const x=fixture();x.contract.criteria[0].predicate={op:'outcome',success:['ok'],failure:['error'],pending:['busy']};
  for(const [value,expected] of [['busy','unknown'],['ok','pass'],['error','fail'],['unlisted','unknown']]) {
    x.evidence[0].value=value;
    const result=await new VerificationEngine().verify(x);assert.equal(result.verdict,expected);assert.equal(result.metrics.modelCalls,0);
  }
  x.contract.criteria[0].predicate={op:'outcome',success:['ok'],failure:['ok'],pending:[]};
  assert.equal((await new VerificationEngine().verify(x)).verdict,'unknown');
});
test('ordinary equality remains strict and incomplete outcome evidence cannot pass',async()=>{
  const x=fixture();x.evidence[0].value='busy';
  assert.equal((await new VerificationEngine().verify(x)).verdict,'fail');
  x.contract.criteria[0].predicate={op:'outcome',success:['busy'],failure:[],pending:[]};x.evidence[0].complete=false;
  assert.equal((await new VerificationEngine().verify(x)).verdict,'unknown');
});
