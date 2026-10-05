import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectShadowEvent,evaluateShadow} from '../src/verification/shadow.js';
import {VerificationCoordinator} from '../src/verification/coordinator.js';
import type {VerificationInput} from '../src/verification/contracts.js';
test('legacy successful trace is blocked, not promoted to verified evidence',()=>{
  const event={eventId:1,taskId:'t',step:1,node:'verify',createdAt:'2026-09-27',state:{lastVerification:{ok:true},observation:{pageText:'done',screenshot:'old.png'}}};
  const before=JSON.stringify(event),receipt=inspectShadowEvent(event);
  assert.equal(receipt.status,'blocked');assert.equal(receipt.verdict,null);assert.equal(receipt.jevCalls,0);
  assert.equal(JSON.stringify(event),before);assert.equal('state' in receipt,false);
});
test('typed shadow returns advice without mutating input or Host retry counters',async()=>{
  const input:VerificationInput={session:'s',now:100,notBefore:90,contract:{id:'c',scope:'action',requirements:['r'],criteria:[
    {id:'x',requirement:'r',object:'o',field:'x',sources:['api'],predicate:{op:'equals',expected:true}}]},evidence:[]};
  const state={session:'s',contractId:'c',notBefore:90,waits:0,collections:0,escalations:0};
  const before=JSON.stringify({input,state});
  const result=await evaluateShadow(new VerificationCoordinator({async evaluate(){throw new Error('unexpected');}}),input,state);
  assert.equal(result.status,'evaluated');if(result.status==='evaluated')assert.equal(result.followUp.kind,'collect');
  assert.equal(JSON.stringify({input,state}),before);
});
