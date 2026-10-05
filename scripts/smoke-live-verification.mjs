import { requiredEndpoint } from '../src/agent/local-config.ts';
import {readFileSync} from 'node:fs';
import {createLiveShadowVerifier} from '../src/verification/live-shadow.ts';
let key=process.env.COMPUTER_USE_API_KEY;
if(!key)key=readFileSync('.env.local','utf8').split(/\r?\n/).find(x=>/^\s*COMPUTER_USE_API_KEY\s*=/.test(x))
  ?.replace(/^\s*COMPUTER_USE_API_KEY\s*=\s*/,'').trim().replace(/^(['"])(.*)\1$/,'$2');
if(!key)throw new Error('JEV key missing');
const verify=createLiveShadowVerifier({baseUrl:requiredEndpoint('JEV_BASE_URL'),apiKey:key,
  instructions:()=>readFileSync('prompts/verification-semantic.md','utf8')});
const start=Date.now();
const result=await verify({session:'synthetic-stage:collector-1',now:10000,notBefore:9000,
  contract:{id:'synthetic-stage',scope:'stage',requirements:['stage-result'],criteria:[{
    id:'stage-result',requirement:'stage-result',object:'window:collector-1:1',field:'pageText',sources:['uia'],
    predicate:{op:'semantic',instruction:'当前报告已完成导出，并产生可读取的最终结果。'}}]},
  evidence:[{id:'collector-1:1',session:'synthetic-stage:collector-1',object:'window:collector-1:1',
    field:'pageText',source:'uia',value:'报告导出成功，结果文件已生成。',capturedAt:9500,complete:true,revision:'1'}]});
console.log(JSON.stringify({synthetic:true,verdict:result.verdict,checks:result.checks.map(c=>({reason:c.reason,advisory:c.advisory})),
  modelCalls:result.metrics.modelCalls,usageReported:result.metrics.usageReported,inputTokens:result.metrics.inputTokens,
  outputTokens:result.metrics.outputTokens,durationMs:Date.now()-start}));
