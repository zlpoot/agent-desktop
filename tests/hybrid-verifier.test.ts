import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { HybridVerifier, applyAcceptance, normalizeEvidence, deterministicChecks,
  type AcceptanceVerifier } from '../src/verifier/hybrid-verifier.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteTrace } from '../src/trace/sqlite-trace.js';
import { createAgentLoop } from '../src/graph/graph.js';
import { initialState } from '../src/graph/state.js';
import { FakeModel } from '../src/agent/model-adapter.js';

test('确定性反证/缺失/未知条件不可被模型放行，缺失文本不伪装成反证', async()=>{
  const verifier=new HybridVerifier({baseUrl:'http://127.0.0.1:1',apiKey:'test',mode:'assist',
    confidenceThreshold:0.8,timeoutMs:100,instructions:()=>''});
  const failed=await verifier.evaluate('窗口到达暂停态',{windowTitleIncludes:'已暂停'},{windowTitle:'正在播放'},'task');
  assert.equal(failed.verdict,'fail'); assert.equal(failed.auxiliary,undefined);
  assert.equal(failed.reason,undefined);
  const missing=await verifier.evaluate('找到文字',{accessibilityIncludes:'目标'},{accessibility:'部分文本'},'task');
  assert.equal(missing.verdict,'unknown'); assert.equal(missing.auxiliary,undefined);
  assert.equal(missing.reason,'evidence_unavailable');
  const contradicted=await verifier.evaluate('到达目标网址',{urlIncludes:'/done'},
    {url:'https://example.test/error'},'task');
  assert.equal(contradicted.verdict,'fail'); assert.equal(contradicted.reason,undefined);
  assert.equal(deterministicChecks({unexpected:'value'} as never,{})[0].verdict,'unknown');
  assert.equal(deterministicChecks({unexpected:'value'} as never,{})[0].reason,'unsupported_condition');
  assert.equal(applyAcceptance({ok:false,message:'反证'},{...failed,verdict:'pass'}).ok,false);
});

test('规范化保留来源和对象身份，不发送图片、不把桌面目录伪装成文件证明',()=>{
  const e=normalizeEvidence({windowHandle:123,windowTitle:'sample',desktopPath:'C:\\Desktop',
    screenshot:'secret-image',textEvidence:[{source:'visual_model',text:'123'}]});
  assert.equal(e.facts.window.handle,123);
  assert.equal(e.facts.text?.[0].authoritative,false);
  assert.match(e.facts.desktopDirectory.meaning,/不证明/);
  assert.equal(JSON.stringify(e).includes('secret-image'),false);
});

test('JEV请求包含完整目标，校验返回格式、置信度、HTTP异常；shadow不改变结果',async()=>{
  let body: any; let answer: unknown={type:'choice',choice:'pass',confidence:0.95}; let status=200;
  const server=createServer(async(req,res)=>{
    let raw=''; for await(const chunk of req) raw+=String(chunk); body=JSON.parse(raw);
    res.statusCode=status;res.end(JSON.stringify({answers:{verdict:answer},usage:{input_tokens:20,output_tokens:4}}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address(); if(!address||typeof address==='string') throw new Error('address');
  const verifier=new HybridVerifier({baseUrl:`http://127.0.0.1:${address.port}`,apiKey:'test',mode:'assist',
    confidenceThreshold:0.8,timeoutMs:1000,instructions:()=> 'instructions'});
  const run=()=>verifier.evaluate('完整目标包含目标窗口',{windowTitleIncludes:'sample'},{windowTitle:'sample'},'task');
  try {
    let r=await run();assert.equal(r.verdict,'pass');assert.equal(body.state.goal,'完整目标包含目标窗口');
    assert.equal(r.auxiliary?.usage?.inputTokens,20);
    answer={type:'choice',choice:'pass',confidence:0.4};r=await run();assert.equal(r.verdict,'unknown');
    assert.equal(r.reason,'evidence_unavailable');
    assert.equal(applyAcceptance({ok:true,message:'原始通过'},r).ok,false);
    assert.equal(applyAcceptance({ok:true,message:'原始通过'},{...r,mode:'shadow'}).ok,true);
    answer={type:'choice',choice:'invented',confidence:1};r=await run();assert.equal(r.verdict,'unknown');assert.ok(r.auxiliary?.error);
    status=503;r=await run();assert.equal(r.verdict,'unknown');assert.match(r.auxiliary!.error!,/503/);
    assert.equal(r.reason,'verification_error');
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

for(const resume of [false,true]) test(`完整目标验收不足时${resume?'恢复':'正常完成'}不会放行或重复动作`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'hybrid-goal-')); const trace=new SqliteTrace(join(dir,'trace.sqlite'));
  let calls=0;let actions=0;
  const acceptanceVerifier:AcceptanceVerifier={async evaluate(goal){
    calls++; assert.match(goal,/保存到桌面/);
    return {mode:'assist',verdict:'unknown',observationId:'current',checks:[],message:'缺少保存路径证据'};
  }};
  try {
    const result=await createAgentLoop({acceptanceVerifier,trace,
      model:new FakeModel([{kind:'done',summary:'完成'}]),runtime:{async observe(){return{windowTitle:'sample.txt'};},
        async execute(){actions++;return{ok:true,message:'动作'};}}}).invoke({
          ...initialState('task','保存到桌面',undefined,{windowTitleIncludes:'sample.txt'}),resumeReconcile:resume});
    assert.equal(result.status,'waiting_user');assert.equal(result.goalVerification?.ok,false);
    assert.equal(actions,0);assert.equal(calls,1);
  } finally {trace.close();rmSync(dir,{recursive:true,force:true});}
});

test('阶段通过后总目标证据不足，禁止生成完成阶段与候选流程',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'hybrid-stage-'));const trace=new SqliteTrace(join(dir,'trace.sqlite'));
  let learned=0;
  const acceptanceVerifier:AcceptanceVerifier={async evaluate(_goal,_criteria,_observation,scope){
    return {mode:'assist',verdict:scope==='stage'?'pass':'unknown',observationId:'current',checks:[],message:'验收',
      auxiliary:{verdict:'pass',confidence:.95,durationMs:1}};
  }};
  try {
    const result=await createAgentLoop({acceptanceVerifier,trace,onStageCompleted:async()=>{learned++;},
      model:{async decide(){throw new Error('不应再执行');},async verifyStage(){throw new Error('不应再调截图模型');}},
      runtime:{async observe(){return{windowTitle:'sample'};},async execute(){throw new Error('不应执行');}}}).invoke({
        ...initialState('task','完整目标',undefined,{windowTitleIncludes:'sample'}),
        taskContract:{target:'完整目标',constraint:'',stageActionLimit:5,taskActionLimit:10},
        stage:{id:'s',goal:'阶段',successCondition:'条件',isFinal:true,startedAtStep:0,actionCount:1,planVersion:1}});
    assert.equal(result.status,'waiting_user');assert.equal(result.completedStages?.length??0,0);assert.equal(learned,0);
  } finally {trace.close();rmSync(dir,{recursive:true,force:true});}
});
