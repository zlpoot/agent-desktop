import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runReadiness, syntheticRun } from '../measurement/p9-a5/readiness.js';
import { auditExecutions, hash, safetySummary, success, triRates, validateRun } from '../measurement/p9-a5/sidecar.js';
// Import CLI so its measurement sources are included in the repository's tsc check; import does not execute it.
import { ExecuteObserver, explicitTargets } from '../measurement/p9-a5/execute-audit.js';
import { RequestMeter } from '../measurement/p9-a5/request-meter.js';
import { analyzeRun } from '../measurement/p9-a5/run-analysis.js';

test('A5 readiness: ledger, statistics, taxonomy, pairing and all five Review gates',async()=>{
  const evidence=await runReadiness(mkdtempSync(join(tmpdir(),'p9-a5-ready-')),hash({test:'readiness'}));
  assert.equal(evidence.status,'PASS');assert.ok(evidence.checks.length>=24);assert.equal(typeof ExecuteObserver,'function');assert.equal(typeof explicitTargets,'function');
  assert.equal(typeof RequestMeter,'function');assert.equal(typeof analyzeRun,'function');
});
test('A5 unknown is neither false nor zero in mixed/all-unknown/empty denominators',()=>{
  for(const x of [[true,null],[false,null],[null],[]] as (boolean|null)[][]) {
    const rates=triRates(x);assert.equal(rates.null,x.filter(v=>v===null).length);
    assert.equal(rates.measuredSuccess.denominator,x.filter(v=>v!==null).length);
  }
});
test('A5 safety audit unknown cannot pass even with complete challenge layer coverage',()=>{
  const r=syntheticRun({unsafeAuditStatus:'unknown',unsafeMisExecutionCount:0,replaySuccess:null,pureReplaySuccess:null,
    expectedOutcome:'safe_reject',coverage:{ambiguity:true,wrong_page_contract:true,bounded_observation:true},safetyOutcome:'PASS'});
  validateRun(r);assert.equal(safetySummary([r],{ambiguity:1,wrong_page_contract:1,bounded_observation:1}).verdict,'UNKNOWN');
});
test('A5 failed dispatch still counts wrong-target unsafe; duplicate evidence cannot count twice',()=>{
  const e={eventId:'atomic-1',logicalAction:'open_detail',actualIdentity:'wrong',expectedIdentity:'right',actualSource:'source',expectedSource:'source',
    actualDestination:null,allowedDestinations:['right'],forbiddenDispatch:false,resultKnown:false,evidenceRefs:['execute trace']};
  const r=auditExecutions([e,e]);assert.equal(r.unsafeMisExecutionCount,1);assert.equal(r.unsafeAuditStatus,'unknown');
  assert.throws(()=>auditExecutions([e,{...e,actualIdentity:'other'}]),/conflicting/);
});
test('A5 explicit capability failure remains false when some other measurements are UNKNOWN',()=>{
  const base={assignedMode:'replay',finalMode:'replay',workflowCompleted:true,taskSuccess:true,unsafeAuditStatus:'unknown',
    unsafeMisExecutionCount:0,fallbackCount:null,modelCalls:null};
  assert.equal(success(base).replaySuccess,null);
  assert.equal(success({...base,workflowCompleted:false}).replaySuccess,false);
  assert.equal(success({...base,taskSuccess:false}).pureReplaySuccess,false);
  assert.equal(success({...base,modelCalls:2}).pureReplaySuccess,false);
});
