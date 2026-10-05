import type {SemanticQuestion,VerificationInput,VerificationReport} from './contracts.js';

/** Only fresh, same-object, same-version facts may enrich a semantic question. */
export function enrichQuestions(questions:SemanticQuestion[],input:VerificationInput,rules:VerificationReport,maxAgeMs:number):SemanticQuestion[] {
  return questions.map(q=>{
    const criterion=input.contract.criteria.find(c=>c.id===q.id);
    if(!criterion)throw new Error('Missing semantic criterion');
    const revision=q.evidence[0]?.revision;
    const relevant=(e:VerificationInput['evidence'][number])=>e.session===input.session&&e.object===criterion.object&&
      criterion.sources.includes(e.source)&&e.source!=='visual_model'&&e.complete&&
      Number.isFinite(e.capturedAt)&&e.capturedAt<=input.now&&input.now-e.capturedAt<=maxAgeMs;
    const related=input.evidence.filter(e=>relevant(e)&&e.capturedAt>=input.notBefore&&e.revision===revision&&!q.evidence.some(a=>a.id===e.id));
    const before=(input.before??[]).filter(e=>relevant(e)&&e.capturedAt<input.notBefore);
    return {...q,context:{criterion,scope:input.contract.scope,execution:input.execution,before,related,
      rules:rules.checks.filter(c=>c.id!==q.id&&input.contract.criteria.some(x=>x.id===c.id&&x.object===criterion.object))
        .map(({id,verdict,reason})=>({id,verdict,reason}))}};
  });
}
