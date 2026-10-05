import type { AuxiliaryVerifier, AuxiliaryResult, SemanticQuestion } from './contracts.js';
import { meteredModelRequest } from '../runtime/model-budget.js';

/** Only compact, scoped semantic questions reach the model. Exact checks never enter this adapter. */
export class JevSemanticVerifier implements AuxiliaryVerifier {
  constructor(private readonly options: {baseUrl:string;apiKey:string;instructions:()=>string;inputMode?:'compact'|'full'}) {}
  async evaluate(questions:SemanticQuestion[],signal:AbortSignal):Promise<AuxiliaryResult> {
    const payload=await meteredModelRequest('jev',async()=>{
    const response=await fetch(`${this.options.baseUrl.replace(/\/+$/,'').replace(/\/v1$/,'')}/v1/systemone`,{
      method:'POST',headers:{Authorization:`Bearer ${this.options.apiKey}`,'Content-Type':'application/json'},signal,
      // The engine has already checked session, time, version and completeness. Send only semantic facts.
      body:JSON.stringify({model:'jev',state:{evidence:questions.map((q,i)=>({question:`q${i}`,
        facts:this.options.inputMode==='full'?q.evidence:q.evidence.map(e=>({object:e.object,field:e.field,value:e.value,source:e.source})),
        ...(this.options.inputMode==='full'?{context:q.context}:{})}))},
        questions:Object.fromEntries(questions.map((q,i)=>[`q${i}`,{type:'choice',
          instructions:`${this.options.instructions()}\n需要验证的条件：${q.instruction}`,criteria:{
            pass:'已明确完成并满足要求。',fail:'已明确失败或确定违反要求；不包括等待和处理中。',
            unknown:'等待、处理中、无终态结果、证据缺失或矛盾。',
          }}]))}),
    });
    if(!response.ok)throw new Error(`JEV HTTP ${response.status}`);
    return await response.json() as {answers?:Record<string,{type?:string;choice?:string;confidence?:number}>;
      usage?:{input_tokens?:number;output_tokens?:number}};
    });
    if(!payload.answers || Object.keys(payload.answers).length!==questions.length)throw new Error('Invalid JEV answers');
    const answers=questions.map((q,i)=>{
      const a=payload.answers?.[`q${i}`];
      if(a?.type!=='choice'||!['pass','fail','unknown'].includes(a.choice??'')||typeof a.confidence!=='number')throw new Error('Invalid JEV answer');
      return {id:q.id,verdict:a.choice as 'pass'|'fail'|'unknown',confidence:a.confidence};
    });
    const usage=payload.usage;
    const validUsage=usage && [usage.input_tokens,usage.output_tokens].every(n=>typeof n==='number'&&Number.isInteger(n)&&n>=0);
    return {answers,usage:validUsage?{inputTokens:usage.input_tokens,outputTokens:usage.output_tokens}:undefined};
  }
}
