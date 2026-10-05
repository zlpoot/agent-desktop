import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLiveShadowVerifier} from '../src/verification/live-shadow.js';
import type {VerificationInput} from '../src/verification/contracts.js';
function input():VerificationInput {return {session:'s',now:100,notBefore:90,contract:{id:'stage',scope:'stage',requirements:['r'],criteria:[
  {id:'r',requirement:'r',object:'window',field:'pageText',sources:['uia'],predicate:{op:'semantic',instruction:'stage completed'}}]},
  evidence:[{id:'e',session:'s',object:'window',field:'pageText',source:'uia',value:'current result',capturedAt:95,complete:true,revision:'v1'}]};}
test('full JEV context is advisory even at confidence 1; usage retained',async()=>{
  const shadow=createLiveShadowVerifier({baseUrl:'http://test.invalid',apiKey:'test',instructions:()=>'',model:{
    async evaluate(q){assert.equal(q[0].context?.criterion.object,'window');
      return {answers:[{id:q[0].id,verdict:'pass',confidence:1}],usage:{inputTokens:20,outputTokens:3}};}}});
  const r=await shadow(input());assert.equal(r.verdict,'unknown');assert.equal(r.checks[0].reason,'model_pass_requires_review');
  assert.equal(r.metrics.inputTokens,20);assert.equal(r.metrics.outputTokens,3);
});
test('partial/stale evidence and contract omission cause no network call',async()=>{
  let calls=0;const shadow=createLiveShadowVerifier({baseUrl:'http://test.invalid',apiKey:'test',instructions:()=>'',model:{
    async evaluate(){calls++;throw new Error('should not call');}}});
  const x=input();x.evidence[0].complete=false;assert.equal((await shadow(x)).verdict,'unknown');
  x.evidence[0].complete=true;x.evidence[0].capturedAt=80;assert.equal((await shadow(x)).verdict,'unknown');
  x.evidence[0].capturedAt=95;x.specification={...x.contract,requirements:['r','missing'],criteria:[...x.contract.criteria,
    {...x.contract.criteria[0],id:'missing',requirement:'missing',field:'other'}]};
  assert.equal((await shadow(x)).checks[0].reason,'specification_not_covered');assert.equal(calls,0);
});
test('JEV outage remains unknown and reports one attempt',async()=>{
  const shadow=createLiveShadowVerifier({baseUrl:'http://test.invalid',apiKey:'test',instructions:()=>'',model:{
    async evaluate(){throw new Error('outage');}}});
  const r=await shadow(input());assert.equal(r.verdict,'unknown');assert.equal(r.metrics.modelCalls,1);
  assert.equal(r.checks[0].reason,'model_unavailable_or_invalid');
});
test('hung JEV is bounded by timeout and cannot turn semantic uncertainty into pass',async()=>{
  const shadow=createLiveShadowVerifier({baseUrl:'http://test.invalid',apiKey:'test',instructions:()=>'',
    modelTimeoutMs:25,model:{async evaluate(_questions,signal){
      await new Promise<never>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),
        {once:true}));throw Error('unreachable');}}});
  const started=performance.now();const report=await shadow(input());
  assert.ok(performance.now()-started<500);
  assert.equal(report.verdict,'unknown');assert.equal(report.checks[0].reason,'model_unavailable_or_invalid');
  assert.equal(report.metrics.modelCalls,1);
});
