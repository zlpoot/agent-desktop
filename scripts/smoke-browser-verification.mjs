import { requiredEndpoint } from '../src/agent/local-config.ts';
import {createServer} from 'node:http';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PlaywrightRuntime} from '../src/runtime/browser/playwright-runtime.ts';
import {createAgentLoop} from '../src/graph/graph.ts';
import {initialState} from '../src/graph/state.ts';
import {SqliteTrace} from '../src/trace/sqlite-trace.ts';
import {createLiveShadowVerifier} from '../src/verification/live-shadow.ts';
import {writeHostShadow} from '../src/verification/host-shadow.ts';
let key=process.env.COMPUTER_USE_API_KEY;
if(!key)key=readFileSync('.env.local','utf8').split(/\r?\n/).find(x=>/^\s*COMPUTER_USE_API_KEY\s*=/.test(x))
  ?.replace(/^\s*COMPUTER_USE_API_KEY\s*=\s*/,'').trim().replace(/^(['"])(.*)\1$/,'$2');
if(!key)throw new Error('JEV key missing');
const root=resolve('.artifacts/verification-live-browser',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(root,{recursive:true});
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end('<label for="body">报告正文</label><textarea id="body" aria-label="报告正文"></textarea><main id="result">等待输入</main><script>document.querySelector("#body").addEventListener("input",e=>document.querySelector("#result").textContent=e.target.value)</script>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const address=server.address(),url=`http://127.0.0.1:${address.port}/`;
let runtime,trace;
try {
  runtime=await PlaywrightRuntime.launch({artifactDir:resolve(root,'screenshots'),headless:true});
  trace=new SqliteTrace(resolve(root,'trace.sqlite'));
  let decisions=0;
  const model={kind:'rule',name:'shadow-smoke',
    async planStage(){return {goal:'填写报告正文',successCondition:'页面显示结果文件已生成',isFinal:true,
      verification:{requirements:[{id:'stage-result',field:'pageText',source:'dom'}]}};},
    async decide(){return decisions++===0?{kind:'navigate',url}:decisions===2
      ?{kind:'type',target:{kind:'role',role:'textbox',name:'报告正文'},text:'结果文件已生成'}
      :{kind:'done',summary:'页面已经显示最终结果'};},
    async verifyStage(_stage,observation){return {ok:observation.pageText?.includes('结果文件已生成')??false,
      confidence:1,evidence:observation.pageText??'',source:'dom'};}};
  const shadowVerify=createLiveShadowVerifier({baseUrl:requiredEndpoint('JEV_BASE_URL'),apiKey:key,
    instructions:()=>readFileSync('prompts/verification-semantic.md','utf8')});
  const records=[];
  const taskId=`browser-shadow-${randomUUID()}`;
  const state={...initialState(taskId,'在报告正文输入结果文件已生成',undefined,{pageTextIncludes:'结果文件已生成'}),
    taskContract:{target:'在报告正文输入结果文件已生成',stageActionLimit:8,taskActionLimit:12,
      constraint:'仅操作本地测试页',environment:'browser'}};
  const final=await createAgentLoop({model,runtime,trace,maxSteps:12,shadowVerify,
    shadowSink:r=>{records.push(r);writeHostShadow(root,r);}}).invoke(state);
  const stage=records.filter(r=>r.kind==='stage-verification');
  const action=records.filter(r=>r.kind==='action-verification');
  const task=records.filter(r=>r.kind==='task-verification');
  const summary={taskId,status:final.status,steps:final.step,stageRecords:stage.length,
    taskRecords:task.length,task:task.map(r=>({status:r.status,reasons:r.reasons,
      verdict:r.report?.verdict,checks:r.report?.checks.map(c=>({reason:c.reason,advisory:c.advisory})),
      modelCalls:r.report?.metrics.modelCalls})),
    actionRecords:action.length,action:action.map(r=>({status:r.status,reasons:r.reasons,
      verdict:r.report?.verdict,checks:r.report?.checks.map(c=>({reason:c.reason,advisory:c.advisory})),
      modelCalls:r.report?.metrics.modelCalls})),
    stage:stage.map(r=>({status:r.status,reason:r.reasons,verdict:r.report?.verdict,
      checks:r.report?.checks.map(c=>({reason:c.reason,advisory:c.advisory})),
      modelCalls:r.report?.metrics.modelCalls,usageReported:r.report?.metrics.usageReported,
      inputTokens:r.report?.metrics.inputTokens,outputTokens:r.report?.metrics.outputTokens})),
    latestCapture:final.observation?.capture,oldStageVerification:final.lastStageVerification,
    limitation:'Real local Chromium and real LAN JEV, synthetic local page and scripted planner; no Hyper-V Guest tested.'};
  writeFileSync(resolve(root,'report.json'),JSON.stringify(summary,null,2));
  console.log(JSON.stringify({output:root,...summary}));
  if(final.status!=='done'||!stage.some(r=>r.report?.metrics.modelCalls===1)||
    !action.some(r=>r.input&&r.report?.metrics.modelCalls===1)||
    !task.some(r=>r.input&&r.report?.checks.some(c=>c.id==='original-task-goal')))
    process.exitCode=1;
} finally {await runtime?.close();trace?.close();await new Promise(r=>server.close(r));}
