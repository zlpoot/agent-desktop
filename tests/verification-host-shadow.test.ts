import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../src/graph/state.js';
import {freezeShadowContract,shadowObservation} from '../src/verification/host-shadow.js';
test('pre-dispatch contract is an independent copy, old observations cannot satisfy new boundary',()=>{
  const s=initialState('t','original');s.step=1;s.lastAction={kind:'keypress',keys:'Enter'};
  s.completionCriteria={pageTextIncludes:'original'};
  s.observation={capture:{epoch:'e',sequence:1,object:'o',startedAt:10,finishedAt:20,clock:'collector',atomic:false,fields:{pageText:{complete:true}}}};
  s.shadowContract=freezeShadowContract(s);s.goal='changed';s.completionCriteria.pageTextIncludes='changed';
  assert.equal(s.shadowContract.task.goal,'original');assert.equal(s.shadowContract.task.criteria.pageTextIncludes,'original');
  assert.ok(shadowObservation(s).reasons?.includes('capture_order_unconfirmed'));
  s.observation.capture={...s.observation.capture!,sequence:2,startedAt:21,finishedAt:30};
  assert.deepEqual(shadowObservation(s).reasons,['action_postcondition_not_formalized']);
  s.observation.capture.epoch='restarted';assert.ok(shadowObservation(s).reasons?.includes('capture_identity_changed'));
});
