// Read-only replay through the production acceptance implementation.
// Usage: node --import tsx scripts/eval-hybrid-verifier.mjs <authorized replay-cases.json>
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { configuredVerifier } from '../src/agent/local-config.ts';
const fixture=JSON.parse(readFileSync(process.argv[2],'utf8'));
const verifier=configuredVerifier();
if (!verifier) throw new Error('Verifier is disabled');
const results=[];
for(const c of fixture.filter(c=>c.id.startsWith('real-'))) {
  const result=await verifier.evaluate(c.state.goal,
    {windowTitleIncludes:'2026-09-27.txt',accessibilityIncludes:'2026-09-27'},c.state.evidence,'task');
  results.push({id:c.id,expected:c.expected,result});
}
results.push({id:'deterministic-counterevidence',expected:'fail',result:await verifier.evaluate(
  '播放器停止播放',{mediaPlaying:false},{media:{playing:true}},'task')});
results.push({id:'missing-criteria',expected:'unknown',result:await verifier.evaluate(
  '完成所有要求',undefined,{windowTitle:'sample'},'task')});
const output=resolve('.artifacts/jev-verifier-eval/hybrid-replay.json');
mkdirSync(resolve('.artifacts/jev-verifier-eval'),{recursive:true});
writeFileSync(output,JSON.stringify(results,null,2));
console.log(JSON.stringify({output,results:results.map(r=>({id:r.id,expected:r.expected,verdict:r.result.verdict,
  confidence:r.result.auxiliary?.confidence,ms:r.result.auxiliary?.durationMs,error:r.result.auxiliary?.error}))},null,2));
