import {VerificationEngine,defaultPolicy} from './engine.js';
import {enrichQuestions} from './semantic-context.js';
import {followUp,defaultFollowUpPolicy,type FollowUpPolicy,type FollowUpState} from './follow-up.js';
import type {AuxiliaryVerifier,Policy,VerificationInput} from './contracts.js';

/** Experimental orchestration. Returns suggestions only; never executes actions or invokes a planner. */
export class VerificationCoordinator {
  private readonly policy:Policy;
  constructor(private readonly model:AuxiliaryVerifier,policy:Partial<Policy>={},private readonly routing:FollowUpPolicy=defaultFollowUpPolicy) {
    this.policy={...defaultPolicy,...policy,allowModelPass:false};
  }
  async verify(input:VerificationInput,state:FollowUpState) {
    const rules=await new VerificationEngine(this.policy).verify(input);
    const unknown=rules.checks.filter(c=>c.verdict==='unknown');
    const bindingValid=state.session===input.session&&state.contractId===input.contract.id&&state.notBefore===input.notBefore&&
      [state.waits,state.collections,state.escalations].every(n=>Number.isInteger(n)&&n>=0);
    let report=rules;
    if(bindingValid && rules.verdict==='unknown'&&unknown.length&&unknown.every(c=>c.reason==='semantic_judgment_required')) {
      const auxiliary:AuxiliaryVerifier={evaluate:(questions,signal)=>{
        const enriched=enrichQuestions(questions,input,rules,this.policy.maxAgeMs);
        if(Buffer.byteLength(JSON.stringify(enriched))>this.policy.maxModelBytes)throw new Error('Full context budget exceeded');
        return this.model.evaluate(enriched,signal);
      }};
      report=await new VerificationEngine(this.policy,auxiliary).verify(input);
    }
    return {report,followUp:followUp(input,report,state,this.routing)};
  }
}
