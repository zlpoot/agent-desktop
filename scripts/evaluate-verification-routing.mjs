import { requiredEndpoint } from '../src/agent/local-config.ts';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {VerificationCoordinator} from '../src/verification/coordinator.ts';
import {JevSemanticVerifier} from '../src/verification/jev.ts';
import {supplementInput} from './verification-input-supplement.mjs';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const root='testbench/verification/v1';
for(const [file,hash] of Object.entries(read(`${root}/manifest.json`).files))if(sha(`${root}/${file}`)!==hash)throw new Error('Dataset modified');
let key=process.env.COMPUTER_USE_API_KEY;
if(!key)key=readFileSync('.env.local','utf8').split(/\r?\n/).find(x=>/^\s*COMPUTER_USE_API_KEY\s*=/.test(x))?.replace(/^\s*COMPUTER_USE_API_KEY\s*=\s*/,'').trim().replace(/^(['"])(.*)\1$/,'$2');
if(!key)throw new Error('Missing JEV key');
const model=new JevSemanticVerifier({baseUrl:requiredEndpoint('JEV_BASE_URL'),apiKey:key,inputMode:'full',instructions:()=>readFileSync('prompts/verification-semantic.md','utf8')});
const policy={...read('config/verification-lab.json'),maxModelBytes:24000};
const routing=read('config/verification-follow-up.json');
const coordinator=new VerificationCoordinator(model,policy,routing);
const scenarios=read(`${root}/scenarios.json`).scenarios,supplement=read('testbench/verification/contract-supplement-v1.json');
const rows=[];
for(const c of read(`${root}/development.json`)) {
  const input=c.tier==='normalized'?supplementInput(c.input,scenarios,supplement):c.input;
  const state={session:input.session,contractId:input.contract.id,notBefore:input.notBefore,waits:0,collections:0,escalations:0,planningNeed:'none'};
  const result=await coordinator.verify(input,state);
  rows.push({id:c.id,tier:c.tier,expected:c.expected.verdict,...result});
}
const report={createdAt:new Date().toISOString(),policy:{...policy,allowModelPass:false},routing,
  scope:'Development replay, full JEV, fresh retry budgets. Suggestions only, no waits/actions/DeepSeek executed. Contract supplement enabled.',
  hashes:Object.fromEntries(['src/verification/coordinator.ts','src/verification/follow-up.ts','src/verification/semantic-context.ts','src/verification/engine.ts','src/verification/jev.ts','prompts/verification-semantic.md','config/verification-follow-up.json',`${root}/manifest.json`,'testbench/verification/contract-supplement-v1.json','scripts/verification-input-supplement.mjs','scripts/evaluate-verification-routing.mjs'].map(p=>[p,sha(p)])),
  summary:{cases:rows.length,routes:Object.fromEntries(['complete','wait','collect','review','escalate'].map(kind=>[kind,rows.filter(r=>r.followUp.kind===kind).length])),
    falsePass:rows.filter(r=>r.report.verdict==='pass'&&r.expected!=='pass').length,
    modelCalls:rows.reduce((n,r)=>n+r.report.metrics.modelCalls,0),modelUnavailable:rows.filter(r=>r.report.checks.some(c=>c.reason==='model_unavailable_or_invalid')).length,
    inputTokens:rows.reduce((n,r)=>n+r.report.metrics.inputTokens,0),outputTokens:rows.reduce((n,r)=>n+r.report.metrics.outputTokens,0),
    missingUsage:rows.filter(r=>r.report.metrics.modelCalls&&!r.report.metrics.usageReported).length,deepseekCalls:0},rows};
const output=resolve('.artifacts/verification-routing',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(output,{recursive:true});
writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,summary:report.summary},null,2));
