import { requiredEndpoint } from '../src/agent/local-config.ts';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {VerificationEngine} from '../src/verification/engine.ts';
import {JevSemanticVerifier} from '../src/verification/jev.ts';
import {enrichQuestions} from '../src/verification/semantic-context.ts';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const root='testbench/verification/v1';
for(const [file,hash] of Object.entries(read(`${root}/manifest.json`).files))if(sha(`${root}/${file}`)!==hash)throw new Error('Dataset modified');
const cases=read(`${root}/development.json`).filter(c=>c.tier==='semantic').map(c=>({id:c.id,group:'frozen-development',input:c.input,expected:c.expected.verdict}));
for(const c of read('testbench/verification/context-development-v1.json').cases) {
  const evidence=(id,field,value)=>({id,field,value,object:'result',session:'s',source:'api',complete:true,capturedAt:95,revision:'r1'});
  cases.push({id:c.id,group:'context-development',expected:c.expected,input:{session:'s',now:100,notBefore:90,execution:'dispatched',
    contract:{id:'result',scope:'stage',requirements:['result'],criteria:[{id:'result',requirement:'result',object:'result',field:'status',sources:['api'],
      predicate:{op:'semantic',instruction:'当前请求是否已成功完成并产生可用的最终结果？'}}]},
    evidence:[evidence('status','status',c.status),evidence('detail','detail',c.detail)]}});
}
let key=process.env.COMPUTER_USE_API_KEY;
if(!key)key=readFileSync('.env.local','utf8').split(/\r?\n/).find(x=>/^\s*COMPUTER_USE_API_KEY\s*=/.test(x))?.replace(/^\s*COMPUTER_USE_API_KEY\s*=\s*/,'').trim().replace(/^(['"])(.*)\1$/,'$2');
if(!key)throw new Error('Missing JEV key');
const options={baseUrl:requiredEndpoint('JEV_BASE_URL'),apiKey:key,instructions:()=>readFileSync('prompts/verification-semantic.md','utf8')};
const compact=new JevSemanticVerifier(options),full=new JevSemanticVerifier({...options,inputMode:'full'});
const policy={...read('config/verification-lab.json'),allowModelPass:true,maxModelBytes:24000,modelTimeoutMs:4500};
const rows=[];
for(const c of cases) {
  const rules=await new VerificationEngine(policy).verify(c.input);
  for(const mode of ['compact','full','adaptive']) {
    const attempts=[];
    const auxiliary={async evaluate(q,signal) {
      async function call(client,questions) {
        if(Buffer.byteLength(JSON.stringify(questions))>policy.maxModelBytes)throw new Error('Context budget exceeded');
        const started=performance.now(),attempt={durationMs:0,status:'unavailable',usage:null};attempts.push(attempt);
        try {const r=await client.evaluate(questions,signal);attempt.status='answered';attempt.usage=r.usage??null;return r;}
        finally {attempt.durationMs=performance.now()-started;}
      }
      const rich=enrichQuestions(q,c.input,rules,policy.maxAgeMs);
      const first=await call(mode==='full'?full:compact,mode==='full'?rich:q);
      if(mode!=='adaptive')return first;
      // At most one retry, and only with additional observations; repeated rewording is not new evidence.
      const unresolved=first.answers.filter(a=>a.verdict==='unknown'||a.confidence<policy.confidenceThreshold);
      const extra=rich.filter(x=>unresolved.some(a=>a.id===x.id)&&((x.context?.related.length??0)+(x.context?.before.length??0)>0));
      if(!extra.length)return first;
      const second=await call(full,extra);
      return {...second,answers:first.answers.map(a=>second.answers.find(b=>b.id===a.id)??a)};
    }};
    const result=await new VerificationEngine(policy,auxiliary).verify(c.input);
    rows.push({id:c.id,group:c.group,mode,expected:c.expected,verdict:result.verdict,checks:result.checks,
      durationMs:result.metrics.durationMs,attempts,unresolved:result.verdict==='unknown'});
  }
}
function summary(rows) {
  const attempts=rows.flatMap(r=>r.attempts),times=rows.map(r=>r.durationMs).sort((a,b)=>a-b);
  return {cases:rows.length,correct:rows.filter(r=>r.expected===r.verdict).length,
    falsePass:rows.filter(r=>r.verdict==='pass'&&r.expected!=='pass').length,falseFail:rows.filter(r=>r.verdict==='fail'&&r.expected!=='fail').length,
    unresolved:rows.filter(r=>r.unresolved).length,incorrectDecisive:rows.filter(r=>!r.unresolved&&r.verdict!==r.expected).length,
    jevCalls:attempts.length,unavailable:attempts.filter(a=>a.status!=='answered').length,missingUsage:attempts.filter(a=>!a.usage).length,
    inputTokens:attempts.reduce((n,a)=>n+(a.usage?.inputTokens??0),0),outputTokens:attempts.reduce((n,a)=>n+(a.usage?.outputTokens??0),0),
    p50Ms:times[Math.floor(times.length*.5)],p95Ms:times[Math.ceil(times.length*.95)-1],deepseekCalls:0,deepseekTokens:0};
}
const report={createdAt:new Date().toISOString(),policy,limitations:'Synthetic development only. Unresolved is NOT a measured DeepSeek escalation. No prices or production savings inferred.',
  hashes:Object.fromEntries(['src/verification/engine.ts','src/verification/jev.ts','src/verification/semantic-context.ts','prompts/verification-semantic.md',`${root}/manifest.json`,'testbench/verification/context-development-v1.json','scripts/compare-jev-context.mjs'].map(p=>[p,sha(p)])),
  summary:Object.fromEntries(['compact','full','adaptive'].map(mode=>[mode,summary(rows.filter(r=>r.mode===mode))])),
  groups:Object.fromEntries(['frozen-development','context-development'].map(group=>[group,Object.fromEntries(['compact','full','adaptive'].map(mode=>[mode,summary(rows.filter(r=>r.mode===mode&&r.group===group))]))])),rows};
const output=resolve('.artifacts/jev-context',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(output,{recursive:true});
writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,summary:report.summary,groups:report.groups},null,2));
