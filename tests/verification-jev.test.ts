import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JevSemanticVerifier} from '../src/verification/jev.js';
import type {SemanticQuestion} from '../src/verification/contracts.js';
import {enrichQuestions} from '../src/verification/semantic-context.js';
import {VerificationEngine} from '../src/verification/engine.js';
const questions:SemanticQuestion[]=[{id:'internal-id',instruction:'Has the operation completed?',evidence:[{
  id:'e',session:'private-session',object:'target',field:'status',value:'pending',source:'api',capturedAt:42,revision:'v1',complete:true}]}];
test('JEV sends scoped compact facts without labels, session or capture internals',async()=>{
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async(_url,options)=>{
      const body=JSON.parse(String(options?.body));
      assert.deepEqual(body.state.evidence,[{question:'q0',facts:[{object:'target',field:'status',value:'pending',source:'api'}]}]);
      assert.equal(body.questions.q0.type,'choice');
      return Response.json({answers:{q0:{type:'choice',choice:'unknown',confidence:.99}},usage:{input_tokens:20,output_tokens:4}});
    };
    const result=await new JevSemanticVerifier({baseUrl:'http://example.invalid',apiKey:'test',instructions:()=>''}).evaluate(questions,new AbortController().signal);
    assert.equal(result.answers[0].id,'internal-id');assert.equal(result.usage?.inputTokens,20);
  } finally {globalThis.fetch=original;}
});
test('missing or invalid usage is not reported as zero-token verified usage',async()=>{
  const original=globalThis.fetch;
  try {
    for(const usage of [undefined,{}, {input_tokens:2},{input_tokens:-1,output_tokens:2}]) {
      globalThis.fetch=async()=>Response.json({answers:{q0:{type:'choice',choice:'unknown',confidence:.9}},usage});
      const result=await new JevSemanticVerifier({baseUrl:'http://example.invalid',apiKey:'test',instructions:()=>''}).evaluate(questions,new AbortController().signal);
      assert.equal(result.usage,undefined);
    }
  } finally {globalThis.fetch=original;}
});
test('full context includes only bound current facts and labelled prior observations',async()=>{
  const e={...questions[0].evidence[0],capturedAt:95};
  const input={session:e.session,now:100,notBefore:90,contract:{id:'c',scope:'stage' as const,requirements:['r'],criteria:[{
    id:'internal-id',requirement:'r',object:'target',field:'status',sources:['api' as const],predicate:{op:'semantic' as const,instruction:'completed?'}}]},
    evidence:[e,{...e,id:'detail',field:'detail',value:'result available'},
      {...e,id:'foreign',object:'another'}, {...e,id:'old',capturedAt:1}, {...e,id:'partial',complete:false},
      {...e,id:'other-version',revision:'v2'}, {...e,id:'future',capturedAt:101}],
    before:[{...e,id:'before',capturedAt:85,revision:'v0'}]};
  const rules=await new VerificationEngine().verify({...input,evidence:[e]});
  const enriched=enrichQuestions([{...questions[0],evidence:[e]}],input,rules,20);
  assert.deepEqual(enriched[0].context?.related.map(e=>e.id),['detail']);
  assert.deepEqual(enriched[0].context?.before.map(e=>e.id),['before']);
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async(_url,options)=>{
      const body=JSON.parse(String(options?.body));assert.deepEqual(body.state.evidence[0].context,JSON.parse(JSON.stringify(enriched[0].context)));
      return Response.json({answers:{q0:{type:'choice',choice:'unknown',confidence:.9}}});
    };
    await new JevSemanticVerifier({baseUrl:'http://example.invalid',apiKey:'test',instructions:()=>'',inputMode:'full'}).evaluate(enriched,new AbortController().signal);
  } finally {globalThis.fetch=original;}
});
