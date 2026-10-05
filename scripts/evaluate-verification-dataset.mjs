import { requiredEndpoint } from '../src/agent/local-config.ts';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { VerificationEngine } from '../src/verification/engine.ts';
import { JevSemanticVerifier } from '../src/verification/jev.ts';
import { supplementInput } from './verification-input-supplement.mjs';
const args=process.argv.slice(2);
const split=args.includes('--split')?args[args.indexOf('--split')+1]:'development';
if(!['development','holdout'].includes(split))throw new Error('Use --split development|holdout');
if(split==='holdout'&&!args.includes('--release-check'))throw new Error('Holdout requires --release-check. Do not tune against release results.');
const root=resolve('testbench/verification/v1');
const read=name=>JSON.parse(readFileSync(resolve(root,name),'utf8'));
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const manifest=read('manifest.json');
const enriched=args.includes('--with-contract-supplement');
if(enriched && split!=='development') throw new Error('Contract supplement is development only');
const supplementPath=resolve('testbench/verification/contract-supplement-v1.json');
const supplement=enriched?JSON.parse(readFileSync(supplementPath,'utf8')):undefined;
const scenarios=enriched?read('scenarios.json').scenarios:undefined;
for(const [file,hash] of Object.entries(manifest.files))if(sha(resolve(root,file))!==hash)throw new Error(`Dataset modified: ${file}. Review labels and version before regenerating manifest.`);
const fixtures=read(`${split}.json`),raw=read('raw-cases.json').filter(c=>c.split===split);
const policy=JSON.parse(readFileSync('config/verification-lab.json','utf8'));
if(args.includes('--experimental-model-pass')) {
  if(!args.includes('--jev'))throw new Error('Experimental model pass requires --jev');
  policy.allowModelPass=true;
}
let model;
if(args.includes('--jev')) {
  let key=process.env.COMPUTER_USE_API_KEY;
  if(!key)key=readFileSync('.env.local','utf8').split(/\r?\n/).find(x=>/^\s*COMPUTER_USE_API_KEY\s*=/.test(x))
    ?.replace(/^\s*COMPUTER_USE_API_KEY\s*=\s*/,'').trim().replace(/^(['"])(.*)\1$/,'$2');
  if(!key)throw new Error('Missing JEV key');
  model=new JevSemanticVerifier({baseUrl:requiredEndpoint('JEV_BASE_URL'),apiKey:key,
    instructions:()=>readFileSync('prompts/verification-semantic.md','utf8')});
}
const engine=new VerificationEngine(policy,model),rows=[];
for(const fixture of fixtures) {
  if(fixture.tier==='semantic'&&!model) {
    rows.push({id:fixture.id,family:fixture.family,category:fixture.category,tier:fixture.tier,status:'not_run',reason:'JEV not enabled'});continue;
  }
  // Do not pass expected labels, rationales or tags to the verifier/model.
  const input=enriched&&fixture.tier==='normalized'?supplementInput(fixture.input,scenarios,supplement):fixture.input;
  const result=await engine.verify(input);
  rows.push({id:fixture.id,family:fixture.family,category:fixture.category,tier:fixture.tier,status:'evaluated',
    expected:fixture.expected,match:result.verdict===fixture.expected.verdict,result});
}
for(const fixture of raw)rows.push({id:fixture.id,family:fixture.family,category:'raw-evidence',tier:'raw',
  status:'not_run',reason:'Raw replay is separate: scripts/evaluate-raw-verification.mjs; not executed in this run'});
function stats(group) {
  const run=group.filter(r=>r.status==='evaluated'),times=run.map(r=>r.result.metrics.durationMs).sort((a,b)=>a-b);
  const total=(select)=>run.reduce((n,r)=>n+select(r),0);
  const matrix=Object.fromEntries(['pass','fail','unknown'].map(expected=>[expected,
    Object.fromEntries(['pass','fail','unknown'].map(predicted=>[predicted,run.filter(r=>r.expected.verdict===expected&&r.result.verdict===predicted).length]))]));
  const actualPass=run.filter(r=>r.result.verdict==='pass').length;
  const goldenPass=run.filter(r=>r.expected.verdict==='pass').length;
  return {cases:group.length,evaluated:run.length,notRun:group.length-run.length,correct:run.filter(r=>r.match).length,
    falsePass:run.filter(r=>r.expected.verdict!=='pass'&&r.result.verdict==='pass').length,
    falseFail:run.filter(r=>r.expected.verdict!=='fail'&&r.result.verdict==='fail').length,
    falseUnknown:run.filter(r=>r.expected.verdict!=='unknown'&&r.result.verdict==='unknown').length,
    passPrecision:actualPass?matrix.pass.pass/actualPass:null,passRecall:goldenPass?matrix.pass.pass/goldenPass:null,
    unknownRate:run.length?run.filter(r=>r.result.verdict==='unknown').length/run.length:null,
    confusion:matrix,p50Ms:times.length?times[Math.floor(times.length*.5)]:null,
    p95Ms:times.length?times[Math.ceil(times.length*.95)-1]:null,
    modelCalls:total(r=>r.result.metrics.modelCalls),inputTokens:total(r=>r.result.metrics.inputTokens),
    outputTokens:total(r=>r.result.metrics.outputTokens),
    missingUsageCalls:run.filter(r=>r.result.metrics.modelCalls&&!r.result.metrics.usageReported).length,
    modelResponseCases:run.filter(r=>r.result.checks.some(c=>c.method==='model')).length,
    modelUnavailableCases:run.filter(r=>r.result.checks.some(c=>c.reason==='model_unavailable_or_invalid')).length};
}
const report={version:manifest.version,createdAt:new Date().toISOString(),split,policy,datasetHash:sha(resolve(root,'manifest.json')),
  inputMode:enriched?'independent-contract-supplement':'original-frozen-input',
  supplementHash:enriched?sha(supplementPath):null,
  supplementAdapterHash:enriched?sha(resolve('scripts/verification-input-supplement.mjs')):null,
  engineHashes:Object.fromEntries(['contracts','engine','jev'].map(f=>[f,sha(resolve(`src/verification/${f}.ts`))])),
  promptHash:sha(resolve('prompts/verification-semantic.md')),
  scope:'Evidence replay only; timing excludes collection. Labels are assistant authored, not independently adjudicated.',
  summary:stats(rows),byCategory:Object.fromEntries([...new Set(rows.map(r=>r.category))].map(c=>[c,stats(rows.filter(r=>r.category===c))])),
  mismatches:rows.filter(r=>r.status==='evaluated'&&!r.match).map(r=>({id:r.id,expected:r.expected.verdict,
    actual:r.result.verdict,rationale:r.expected.rationale,checks:r.result.checks}))};
const output=resolve('.artifacts/verification-dataset',new Date().toISOString().replace(/[:.]/g,'-'));
mkdirSync(output,{recursive:true});writeFileSync(resolve(output,'results.json'),JSON.stringify(rows,null,2));
writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({output,...report},null,2));
// Only opt-in gates fail CI: preserving a red baseline must not break the project's normal unit tests.
if(args.includes('--strict')&&(report.mismatches.length||report.summary.notRun))process.exitCode=1;
