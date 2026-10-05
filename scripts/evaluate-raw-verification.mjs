import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {checkFrame,decodeFile} from '../src/verification/raw-evidence.ts';
import {collectDom,inspectUi,parseLegacyUia} from '../src/verification/ui-evidence.ts';
import {VerificationEngine} from '../src/verification/engine.ts';
process.env.PLAYWRIGHT_BROWSERS_PATH??=resolve('.playwright-browsers');
const {chromium}=await import('playwright');
const uiContracts=JSON.parse(readFileSync('testbench/verification/raw-ui-contracts-v1.json','utf8'));
let browser,context;
async function evaluateUi(raw,contract) {
  if(!contract)return undefined;
  const binding={session:'offline-replay',expectedSession:'offline-replay',object:'target',expectedObject:'target',
    capturedAt:90,now:100,notBefore:80,maxAgeMs:30};
  if(raw.uia!==undefined) {
    const snapshot={id:'legacy-replay',source:'uia',binding,complete:false,nodes:parseLegacyUia(raw.uia)};
    return inspectUi(snapshot,contract.query,contract.field);
  }
  if(raw.html!==undefined) {
    browser??=await chromium.launch({headless:true});
    if(!context) {
      context=await browser.newContext({javaScriptEnabled:false,serviceWorkers:'block'});
      await context.route('**/*',route=>route.abort());
    }
    const page=await context.newPage();
    try {
      await page.setContent(contract.wrapper==='table'?`<table><tbody>${raw.html}</tbody></table>`:raw.html);
      const snapshot=await collectDom(page,binding,{...contract,id:'dom-replay'});
      const extracted=inspectUi(snapshot,{owner:contract.scope},contract.field);
      if(extracted.verdict!=='pass')return extracted;
      const result=await new VerificationEngine().verify({session:binding.session,now:100,notBefore:80,evidence:extracted.evidence,
        contract:{id:'raw-field',scope:'action',requirements:['field'],criteria:[{id:'field',requirement:'field',object:'target',
          field:contract.field,sources:['dom'],predicate:contract.predicate}]}});
      return {verdict:result.verdict,reason:result.checks[0].reason,evidence:extracted.evidence};
    } finally {await page.close();}
  }
}
const root=resolve('testbench/verification/v1');
const sha=b=>createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'));
for(const [file,hash] of Object.entries(manifest.files))if(sha(readFileSync(resolve(root,file)))!==hash)throw new Error(`Modified fixture ${file}`);
const fixtures=JSON.parse(readFileSync(resolve(root,'raw-cases.json'),'utf8'));
// Only raw payload and requested facts are used for extraction; expected labels are comparison-only.
function evaluate(raw,facts) {
  if(raw.image) {
    const path=resolve(root,raw.image.file),rel=relative(root,path);
    if(rel.startsWith('..')||isAbsolute(rel))throw new Error('Asset outside dataset');
    const bytes=readFileSync(path);
    if(facts.includes('frame.coverage'))return checkFrame(bytes,{...raw.image,captureType:raw.captureType});
    return {verdict:'unknown',reason:'image_does_not_prove_persisted_file_content'};
  }
  if(raw.bytesHex!==undefined) {
    if(!/^(?:[a-f0-9]{2})*$/i.test(raw.bytesHex))return {verdict:'unknown',reason:'invalid_bytes'};
    const decoded=decodeFile(Buffer.from(raw.bytesHex,'hex'));
    if(!decoded)return {verdict:'unknown',reason:'invalid_encoding'};
    // Isolated byte-content assertion only. A content match cannot prove canonical file identity.
    if(decoded.text!==raw.requestedText)return {verdict:'fail',reason:'decoded_content_differs'};
    return {verdict:'unknown',reason:'missing_canonical_file_binding'};
  }
  if(raw.httpStatus!==undefined)return {verdict:'unknown',reason:'missing_request_binding_and_outcome_contract'};
  return undefined;
}
const rows=[];
try {for(const f of fixtures.filter(f=>f.split==='development')) {
  const start=performance.now();let result,error;
  try {result=evaluate(f.raw,f.requiredFacts)??await evaluateUi(f.raw,uiContracts.cases[f.id]);}
  catch(e) {error=e.message;}
  rows.push({id:f.id,expected:f.expected.verdict,status:result?'evaluated':'not_run',result,
    match:result?result.verdict===f.expected.verdict:null,durationMs:performance.now()-start,
    limitation:result?undefined:error??'No adapter; not counted as pass'});
}} finally {await context?.close();await browser?.close();}
const run=rows.filter(r=>r.status==='evaluated');
const report={createdAt:new Date().toISOString(),datasetHash:sha(readFileSync(resolve(root,'manifest.json'))),
  adapterHash:sha(readFileSync('src/verification/raw-evidence.ts')),runnerHash:sha(readFileSync('scripts/evaluate-raw-verification.mjs')),
  uiAdapterHash:sha(readFileSync('src/verification/ui-evidence.ts')),uiContractsHash:sha(readFileSync('testbench/verification/raw-ui-contracts-v1.json')),
  scope:'Offline raw development replay; no live capture, OCR or semantic image judgment. Frozen labels unchanged.',
  summary:{evaluated:run.length,correct:run.filter(r=>r.match).length,notRun:rows.length-run.length,
    falsePass:run.filter(r=>r.result.verdict==='pass'&&r.expected!=='pass').length,modelCalls:0,tokens:0},rows};
const output=resolve('.artifacts/verification-raw',new Date().toISOString().replace(/[:.]/g,'-'));
mkdirSync(output,{recursive:true});writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({output,...report},null,2));
