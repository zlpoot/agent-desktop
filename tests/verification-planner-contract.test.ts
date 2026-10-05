import {test} from 'node:test';
import assert from 'node:assert/strict';
import {freezeStageEvidence,parseEvidencePlan,stageEvidenceInput} from '../src/verification/planner-contract.js';
import {VerificationEngine} from '../src/verification/engine.js';
import type {Observation} from '../src/actions/schema.js';
const plan={requirements:[{id:'stage-result',field:'pageText',source:'uia'}]};
const boundary:NonNullable<Observation['capture']>={epoch:'e',sequence:1,object:'window',startedAt:10,finishedAt:20,clock:'collector',atomic:false,fields:{pageText:{complete:true,source:'uia'}}};
function observation():Observation{return {pageText:'display text + OCR',textEvidence:[{source:'uia',text:'original UIA'},{source:'visual_model',text:'success'}],
  capture:{...structuredClone(boundary),sequence:2,startedAt:21,finishedAt:30}};}
test('planner channel proposal must cover all Host requirement IDs, cannot rewrite requirement text',()=>{
  assert.ok(parseEvidencePlan(plan,['stage-result']));
  for(const p of [null,{}, {requirements:[]},{requirements:[...plan.requirements,...plan.requirements]},
    {requirements:[{...plan.requirements[0],id:'other'}]},{requirements:[{...plan.requirements[0],source:'visual_model'}]}])
    assert.equal(parseEvidencePlan(p,['stage-result']),undefined);
  const frozen=freezeStageEvidence('s','Goal','Full condition','Original task',plan);
  assert.equal(frozen.requirements[0].text,'Goal\n成功条件：Full condition');
  const parsed=stageEvidenceInput(frozen,observation(),boundary).input!;
  assert.equal(parsed.evidence[0].value,'original UIA');assert.notEqual(parsed.contract,parsed.specification);
  assert.equal(parsed.now,30);assert.equal(parsed.notBefore,20);
});
test('old capture, restarted collector, missing source and partial fields never become success',async()=>{
  const c=freezeStageEvidence('s','Goal','condition','Original',plan);
  const old=observation();old.capture=structuredClone(boundary);
  assert.equal(stageEvidenceInput(c,old,boundary).reason,'capture_order_unconfirmed');
  const restarted=observation();restarted.capture!.epoch='new';assert.equal(stageEvidenceInput(c,restarted,boundary).reason,'capture_identity_changed');
  for(const mutate of [(o:Observation)=>{delete o.capture!.fields.pageText.source;},(o:Observation)=>{o.capture!.fields.pageText.complete=false;}]) {
    const o=observation();mutate(o);
    const input=stageEvidenceInput(c,o,boundary).input!;
    const r=await new VerificationEngine({}, {async evaluate(){throw new Error('must not call');}}).verify(input);
    assert.equal(r.verdict,'unknown');assert.equal(r.metrics.modelCalls,0);
  }
});
