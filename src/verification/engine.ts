import type { AuxiliaryVerifier, Check, Criterion, Evidence, Policy, SemanticQuestion,
  VerificationInput, VerificationReport, Verdict } from './contracts.js';

export const defaultPolicy: Readonly<Policy> = {
  maxAgeMs: 5000, modelTimeoutMs: 2000, maxModelBytes: 6000, confidenceThreshold: 0.85,
  allowModelPass: false,
};
const sources = new Set(['dom','uia','window','file','api','visual_model']);
const scalar = (value: unknown) => typeof value === 'string' || typeof value === 'boolean' ||
  typeof value === 'number' && Number.isFinite(value);
const activePhases = new Set(['pending','queued','running','processing','in_progress']);

function activePhaseFor(input:VerificationInput,criterion:Criterion,current:Evidence):boolean {
  // A phase marker is useful only when it belongs to the same captured object,
  // source, revision and moment as the result. Older UI text cannot mask a failure.
  if(!/(?:status|outcome|state|result)$/i.test(criterion.field)||
      criterion.predicate.op!=='equals')return false;
  return input.evidence.some(e=>e.field==='phase'&&e.object===current.object&&
    e.session===current.session&&e.source===current.source&&e.capturedAt===current.capturedAt&&
    e.revision===current.revision&&e.complete&&typeof e.value==='string'&&
    activePhases.has(e.value.toLowerCase()));
}

function contractError(input: VerificationInput): string | undefined {
  const c = input.contract;
  if (!c.id || !['action','stage','task'].includes(c.scope) || !input.session ||
      !Number.isFinite(input.now) || !Number.isFinite(input.notBefore) || input.notBefore > input.now)
    return 'invalid_context';
  if (!c.requirements.length || c.requirements.some(x=>!x.trim()) ||
      new Set(c.requirements).size !== c.requirements.length || !c.criteria.length) return 'empty_or_duplicate_requirements';
  if (new Set(c.criteria.map(x=>x.id)).size !== c.criteria.length) return 'duplicate_criteria';
  for (const x of c.criteria) {
    if (!x.id || !x.object || !x.field || !c.requirements.includes(x.requirement) ||
      !x.sources.length || x.sources.some(s=>!sources.has(s)) ||
      !Number.isInteger(x.samples ?? 1) || (x.samples ?? 1)<1 || (x.samples ?? 1)>5) return 'invalid_criterion';
    const p=x.predicate;
    if (!['equals','contains','atMost','changed','semantic','outcome'].includes(p.op)) return 'unsupported_predicate';
    if (p.op==='outcome') {
      if (![p.success,p.failure,p.pending].every(a=>Array.isArray(a)&&a.every(scalar)) || !p.success.length)
        return 'invalid_outcome';
      const values=[...p.success,...p.failure,...p.pending];
      if(new Set(values).size!==values.length) return 'ambiguous_outcome';
    }
    if (p.op==='equals' && !scalar(p.expected) || p.op==='contains' && (!p.expected || typeof p.expected!=='string') ||
        p.op==='atMost' && !Number.isFinite(p.expected) || p.op==='semantic' && !p.instruction?.trim()) return 'invalid_predicate';
  }
  if (c.requirements.some(r=>!c.criteria.some(x=>x.requirement===r))) return 'uncovered_requirement';
  if(input.specification) {
    const spec=input.specification;
    if(contractError({...input,contract:spec,specification:undefined})) return 'invalid_specification';
    if(spec.scope!==c.scope || spec.requirements.some(r=>!c.requirements.includes(r)) ||
      spec.criteria.some(required=>!c.criteria.some(actual=>
        actual.requirement===required.requirement && actual.object===required.object && actual.field===required.field &&
        JSON.stringify(actual.predicate)===JSON.stringify(required.predicate) &&
        actual.revision===required.revision && (actual.samples??1)>=(required.samples??1) &&
        actual.sources.every(s=>required.sources.includes(s))))) return 'specification_not_covered';
  }
  const ids=[...input.evidence,...input.before??[]].map(x=>x.id);
  if (new Set(ids).size !== ids.length) return 'duplicate_evidence_id';
  return undefined;
}

function stableSamples(evidence: Evidence[], current: Evidence): number {
  const times=[...new Set(evidence.map(e=>e.capturedAt))].sort((a,b)=>b-a);
  let count=0;
  for(const time of times) {
    const batch=evidence.filter(e=>e.capturedAt===time);
    if(batch.some(e=>!e.complete || e.value!==current.value || e.revision!==current.revision)) break;
    count++;
  }
  return count;
}

function observations(input: VerificationInput, criterion: Criterion, policy: Policy, before=false): Evidence[] {
  return (before ? input.before ?? [] : input.evidence).filter(e=>e.id && e.session===input.session &&
    e.object===criterion.object && e.field===criterion.field && criterion.sources.includes(e.source) && scalar(e.value) &&
    Number.isFinite(e.capturedAt) && e.capturedAt<=input.now && input.now-e.capturedAt<=policy.maxAgeMs &&
    (before ? e.capturedAt<input.notBefore : e.capturedAt>=input.notBefore));
}

/** Evaluation is stateless: cached successful checks cannot leak into a new observation/session. */
export class VerificationEngine {
  private readonly policy: Policy;
  constructor(policy: Partial<Policy> = {}, private readonly auxiliary?: AuxiliaryVerifier) {
    this.policy={...defaultPolicy,...policy};
    for (const k of ['maxAgeMs','modelTimeoutMs','maxModelBytes'] as const)
      if (!Number.isFinite(this.policy[k]) || this.policy[k]<=0) throw new Error(`Invalid ${k}`);
    if (!Number.isFinite(this.policy.confidenceThreshold) || this.policy.confidenceThreshold<0 ||
        this.policy.confidenceThreshold>1) throw new Error('Invalid confidenceThreshold');
    if (typeof this.policy.allowModelPass!=='boolean') throw new Error('Invalid allowModelPass');
  }

  async verify(input: VerificationInput): Promise<VerificationReport> {
    const started=performance.now();
    const metrics={durationMs:0,modelCalls:0,modelBytes:0,inputTokens:0,outputTokens:0,usageReported:false};
    const checks: Check[]=[];
    const pending: SemanticQuestion[]=[];
    const error=contractError(input);
    // Collector revisions describe the object snapshot, including fields checked by other criteria.
    const objectRevisions=new Map<string,Set<string|undefined>>();
    for(const c of input.contract.criteria) {
      const all=observations(input,c,this.policy);
      const times=new Map<string,number>();
      for(const e of all) times.set(e.source,Math.max(times.get(e.source)??-Infinity,e.capturedAt));
      const revisions=objectRevisions.get(c.object)??new Set<string|undefined>();
      for(const e of all.filter(e=>e.capturedAt===times.get(e.source))) revisions.add(e.revision);
      objectRevisions.set(c.object,revisions);
    }
    if (error) checks.push({id:'contract',verdict:'unknown',reason:error,evidenceIds:[],method:'rule'});
    else for (const c of input.contract.criteria) {
      const check: Check={id:c.id,verdict:'unknown',reason:'missing_fresh_bound_evidence',evidenceIds:[],method:'rule'};
      checks.push(check);
      const all=observations(input,c,this.policy);
      if (!all.length) continue;
      // Keep newest observation from EACH source: disagreement is not resolved by arbitrarily picking one.
      const newest=new Map<string,number>();
      for(const e of all)newest.set(e.source,Math.max(newest.get(e.source)??-Infinity,e.capturedAt));
      const latest=all.filter(e=>e.capturedAt===newest.get(e.source));
      check.evidenceIds=latest.map(e=>e.id);
      if(c.revision && latest.some(e=>e.revision!==c.revision)) {check.reason='requested_revision_superseded_or_unconfirmed';continue;}
      if((objectRevisions.get(c.object)?.size??0)>1) {check.reason='mixed_object_revisions';continue;}
      if (new Set(latest.map(e=>JSON.stringify(e.value))).size>1) {check.reason='conflicting_evidence';continue;}
      if (new Set(latest.map(e=>e.revision).filter(x=>x!==undefined)).size>1) {check.reason='mixed_revisions';continue;}
      const authoritative=latest.filter(e=>e.source!=='visual_model');
      const p=c.predicate;
      if (p.op==='semantic') {
        if (!latest.every(e=>e.complete)) {check.reason='partial_evidence';continue;}
        const stable=stableSamples(all,latest[0]);
        if(stable<(c.samples??1)) {check.reason='insufficient_stable_samples';continue;}
        check.reason='semantic_judgment_required';
        pending.push({id:c.id,instruction:p.instruction,evidence:latest});continue;
      }
      if (!authoritative.length) {check.reason='model_text_is_not_original_evidence';continue;}
      const current=authoritative[0];
      const stable=stableSamples(all.filter(e=>e.source!=='visual_model'),current);
      if ((c.samples??1)>1 && stable<(c.samples??1)) {check.reason='insufficient_stable_samples';continue;}
      if (p.op!=='contains' && !current.complete) {check.reason='partial_evidence';continue;}
      let success: boolean;
      if(p.op==='outcome') {
        if(p.pending.includes(current.value)) {check.reason='outcome_pending';continue;}
        if(!p.success.includes(current.value) && !p.failure.includes(current.value)) {check.reason='unrecognized_outcome';continue;}
        success=p.success.includes(current.value);
      } else if(p.op==='equals') success=current.value===p.expected;
      else if(p.op==='contains') {
        if(typeof current.value!=='string') {check.reason='type_mismatch';continue;}
        success=current.value.includes(p.expected);
        if(!success && !current.complete) {check.reason='partial_evidence';continue;}
      } else if(p.op==='atMost') {
        if(typeof current.value!=='number') {check.reason='type_mismatch';continue;}
        success=current.value<=p.expected;
      } else {
        const baseline=observations(input,c,this.policy,true).filter(e=>e.complete && e.source!=='visual_model');
        if(!baseline.length) {check.reason='missing_baseline';continue;}
        const at=Math.max(...baseline.map(e=>e.capturedAt));
        const previous=baseline.filter(e=>e.capturedAt===at);
        if(new Set(previous.map(e=>JSON.stringify(e.value))).size!==1) {check.reason='conflicting_baseline';continue;}
        check.evidenceIds.push(...previous.map(e=>e.id));success=previous[0].value!==current.value;
      }
      if(!success && activePhaseFor(input,c,current)) {check.reason='outcome_pending';continue;}
      check.verdict=success?'pass':'fail';check.reason=success?'predicate_satisfied':'predicate_contradicted';
    }
    // No model can change a failed predicate, invent missing evidence, or repair an incomplete contract.
    if(!error && !checks.some(c=>c.verdict==='fail') && pending.length && this.auxiliary) {
      metrics.modelBytes=Buffer.byteLength(JSON.stringify(pending),'utf8');
      if(metrics.modelBytes>this.policy.maxModelBytes) {
        for(const q of pending) checks.find(c=>c.id===q.id)!.reason='model_budget_exceeded';
      } else {
        const controller=new AbortController();let timer: ReturnType<typeof setTimeout> | undefined;
        metrics.modelCalls=1;
        try {
          const result=await Promise.race([this.auxiliary.evaluate(pending,controller.signal),
            new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('timeout'));},this.policy.modelTimeoutMs);})]);
          const valid=Array.isArray(result.answers) && result.answers.length===pending.length &&
            new Set(result.answers.map(a=>a.id)).size===pending.length && result.answers.every(a=>
              pending.some(q=>q.id===a.id) && ['pass','fail','unknown'].includes(a.verdict) &&
              Number.isFinite(a.confidence) && a.confidence>=0 && a.confidence<=1);
          if(!valid) throw new Error('invalid_model_response');
          metrics.usageReported=result.usage!==undefined;
          metrics.inputTokens=result.usage?.inputTokens??0;metrics.outputTokens=result.usage?.outputTokens??0;
          for(const answer of result.answers) {
            const c=checks.find(c=>c.id===answer.id)!;c.method='model';
            c.advisory={verdict:answer.verdict,confidence:answer.confidence};
            if(answer.confidence<this.policy.confidenceThreshold) {c.reason='low_model_confidence';continue;}
            if(answer.verdict==='pass'&&!this.policy.allowModelPass) {c.reason='model_pass_requires_review';continue;}
            c.verdict=answer.verdict;c.reason=`model_${answer.verdict}`;
          }
        } catch {for(const q of pending) checks.find(c=>c.id===q.id)!.reason='model_unavailable_or_invalid';}
        finally {if(timer)clearTimeout(timer);}
      }
    }
    const verdict: Verdict=checks.some(c=>c.verdict==='fail')?'fail':checks.length&&checks.every(c=>c.verdict==='pass')?'pass':'unknown';
    metrics.durationMs=performance.now()-started;
    return {contractId:input.contract.id,scope:input.contract.scope,verdict,checks,
      next:verdict==='pass'?'complete':verdict==='fail'||error?'review':'collect_evidence',
      missing:input.contract.criteria.filter(c=>checks.some(check=>check.id===c.id&&check.verdict==='unknown'))
        .map(c=>({criterion:c.id,object:c.object,field:c.field,sources:c.sources})),metrics};
  }
}
