import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemorySaver} from '@langchain/langgraph';
import {FakeModel} from '../src/agent/model-adapter.js';
import {createAgentLoop} from '../src/graph/graph.js';
import {initialState} from '../src/graph/state.js';
import {SqliteTrace} from '../src/trace/sqlite-trace.js';
import {prepareWorkflowExecution} from '../src/workflows/execution.js';
import {workflowDigest} from '../src/workflows/recovery.js';
import type {Workflow} from '../src/workflows/schema.js';
import type {HostShadowRecord} from '../src/verification/host-shadow.js';

test('generic goal naming a file cannot finish from matching window text alone',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'original-file-goal-'));
  const trace=new SqliteTrace(join(dir,'trace.sqlite'));
  try {
    const model=new FakeModel([{kind:'done',summary:'saved'}]);
    const runtime={name:'fake Desktop',execute:async()=>({ok:true,message:'unused'}),
      observe:async()=>({windowTitle:'report.txt - Notepad',
      pageText:'report.txt',capture:{epoch:'e',object:'window:1',sequence:1,
        startedAt:1000,finishedAt:1001,clock:'collector' as const,atomic:false as const,
        fields:{pageText:{source:'uia' as const,complete:true}}}})};
    const state=initialState('missing-file-contract',
      '将准确文本保存为当前用户桌面的 report.txt',undefined,{windowTitleIncludes:'report.txt'});
    const result=await createAgentLoop({model,runtime,trace,checkpointer:new MemorySaver(),
      acceptanceVerifier:{evaluate:async()=>{throw Error('must not trust window-only acceptance');}}})
      .invoke(state,{configurable:{thread_id:state.taskId}});
    assert.equal(result.status,'paused');
    assert.match(result.error??'',/missing_declared_file_proof/);
  } finally {trace.close();rmSync(dir,{recursive:true,force:true});}
});

test('Graph freezes file condition before click and uses separate Guest reads for shadow result',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'desktop-file-shadow-'));
  const trace=new SqliteTrace(join(dir,'trace.sqlite'));
  try {
    const records:HostShadowRecord[]=[];
    const calls:string[]=[];
    let saved=false;
    const runtime={name:'fake Desktop',
      observe:async()=>({pageText:saved?'已请求保存':'准备保存'}),
      inspectFile:async(path:string)=>{calls.push(path);return {path:'C:\\Users\\agent\\Desktop\\result.txt',
        root:'C:\\Users\\agent\\Desktop',capturedAt:calls.length===1?1000:1100,
        exists:saved,complete:true,kind:saved?'file' as const:undefined,
        ...(saved?{mtimeMs:1050,size:5,sha256:'a'.repeat(64),text:'hello'}:{})};},
      execute:async()=>{saved=true;return {ok:true,message:'clicked',effect:'dispatched' as const};}};
    const model=new FakeModel([{kind:'click',target:{kind:'role',role:'Button',name:'Save'},
      postcondition:{kind:'desktop_file',path:'result.txt',contentEquals:'hello'}},
      {kind:'done',summary:'complete'}]);
    const final=await createAgentLoop({model,runtime,trace,shadowSink:r=>records.push(r)})
      .invoke(initialState('file-graph','save file',undefined,{pageTextIncludes:'已请求保存'}));
    assert.equal(final.status,'done');
    assert.equal(trace.events('file-graph').find(event=>event.node==='verify')?.state.lastVerification?.ok,true);
    assert.deepEqual(calls,['result.txt','result.txt']);
    assert.equal(records.find(r=>r.kind==='action-verification')?.report?.verdict,'pass');
    assert.equal(records.find(r=>r.kind==='action-verification')?.report?.metrics.modelCalls,0);
    assert.equal(records.find(r=>r.kind==='contract')?.contract?.action.postconditionStatus,'formalized');
  } finally {trace.close();rmSync(dir,{recursive:true,force:true});}
});

for(const scenario of ['wrong content','missing capture'] as const) test(
  `Graph rejects ${scenario} even when the window visibly changes, without replaying Save`,async()=>{
    const dir=mkdtempSync(join(tmpdir(),'desktop-file-gate-'));
    const trace=new SqliteTrace(join(dir,'trace.sqlite'));
    try {
      let dispatched=0;
      let reads=0;
      const runtime={name:'fake Desktop',
        observe:async()=>({pageText:dispatched?'Save dialog closed':'Save dialog open'}),
        inspectFile:async()=>{
          reads++;
          if(scenario==='missing capture'&&reads===2)throw new Error('collector unavailable');
          return {path:'C:\\Users\\agent\\Desktop\\result.txt',root:'C:\\Users\\agent\\Desktop',
            capturedAt:reads===1?1000:1100,exists:reads>1,complete:true,
            ...(reads>1?{kind:'file' as const,mtimeMs:1050,size:5,sha256:'b'.repeat(64),text:'wrong'}:{})};
        },
        execute:async()=>{dispatched++;return {ok:true,message:'clicked',effect:'dispatched' as const};}};
      const model=new FakeModel([{kind:'click',target:{kind:'role',role:'Button',name:'Save'},
        postcondition:{kind:'desktop_file',path:'result.txt',contentEquals:'hello'}},
        {kind:'done',summary:'must not reach'}]);
      const final=await createAgentLoop({model,runtime,trace,maxRetries:2})
        .invoke(initialState(`file-${scenario}`,'save file',undefined,{pageTextIncludes:'Save dialog closed'}));
      assert.equal(final.status,'failed');
      assert.equal(final.lastVerification?.ok,false);
      assert.match(final.error??'',/桌面文件未通过独立验收/);
      assert.equal(dispatched,1,'a save with contradicted or missing evidence is never retried');
      assert.equal(reads,2);
    } finally {trace.close();rmSync(dir,{recursive:true,force:true});}
  });

for(const scenario of ['current file intact','file deleted','file modified','current capture missing',
  'action proof missing'] as const) test(`Pinned file Workflow task gate: ${scenario}`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'desktop-file-task-'));
  const trace=new SqliteTrace(join(dir,'trace.sqlite'));
  try {
    const workflow:Workflow={id:'file-task-test',version:1,status:'candidate',scope:'task',
      environment:'windows',taskPattern:'Save {{content}} as {{filename}}',
      inputs:[{name:'content',example:'hello'},{name:'filename',example:'result.txt'}],
      preconditions:[],steps:[{goal:'Save',action:{kind:'click',
        target:{kind:'role',role:'Button',name:'Save'},
        postcondition:{kind:'desktop_file',path:'{{filename}}',contentEquals:'{{content}}'}},
        preferredMethods:['accessibility'],successCondition:{kind:'state_changed'}}],
      successConditions:{windowTitleIncludes:'{{filename}}',pageTextIncludes:'{{content}}'},
      knownFailures:[],sourceTaskId:'seed',sourceTrace:'fixture',createdAt:'',
      successCount:0,failureCount:0};
    const prepared=prepareWorkflowExecution(workflow,{id:workflow.id,version:1,
      definitionHash:workflowDigest(workflow),values:{content:'hello',filename:'result.txt'},
      destination:'windows',trial:true});
    assert.equal(prepared.ref.requiredFiles?.[0]?.path,'result.txt');
    if(scenario==='action proof missing')prepared.ref.requiredFiles![0].contentEquals='other';
    let decisions=0,dispatched=0,reads=0,acceptanceCalls=0;
    const now=Date.now();
    const runtime={name:'fake Desktop',
      observe:async()=>({windowTitle:dispatched?'result.txt - Notepad':'Save As',
        pageText:dispatched?'hello':'Save',textEvidence:[{source:'uia' as const,text:dispatched?'hello':'Save'}],
        capture:{epoch:'e',object:'window:7',sequence:dispatched+1,startedAt:now+dispatched*100,
          finishedAt:now+dispatched*100+1,clock:'collector' as const,atomic:false as const,
          fields:{pageText:{source:'uia' as const,complete:true}}}}),
      inspectFile:async()=>{reads++;
        if(reads===3&&scenario==='current capture missing')throw new Error('file RPC unavailable');
        const exists=reads!==1&&!(reads===3&&scenario==='file deleted');
        return {path:'C:\\Users\\agent\\Desktop\\result.txt',root:'C:\\Users\\agent\\Desktop',
          capturedAt:now+reads*100,exists,complete:true,
          ...(exists?{kind:'file' as const,size:5,mtimeMs:now+200,
            sha256:reads===3&&scenario==='file modified'?'b'.repeat(64):'a'.repeat(64),
            text:reads===3&&scenario==='file modified'?'other':'hello'}:{})};},
      execute:async()=>{dispatched++;return {ok:true,message:'clicked',effect:'dispatched' as const};}};
    const model={name:'pinned fixture',kind:'rule' as const,
      decide:async()=>++decisions===1?prepared.workflow.steps[0].action:
        {kind:'done' as const,summary:'complete'},
      snapshotState:()=>({nextIndex:Math.min(decisions,1),exploring:false}),
      currentWorkflowRef:()=>prepared.ref};
    const state={...initialState(`task-${scenario}`,prepared.goal,undefined,
      prepared.workflow.successConditions),workflowRef:prepared.ref};
    const result=await createAgentLoop({model,runtime,trace,
      checkpointer:new MemorySaver(),
      acceptanceVerifier:{evaluate:async()=>{acceptanceCalls++;throw Error('JEV must be skipped');}},
      shadowSink:()=>{}}).invoke(state,{configurable:{thread_id:state.taskId}});
    assert.equal(dispatched,1);
    assert.equal(acceptanceCalls,0);
    assert.equal(reads,scenario==='action proof missing'?2:3);
    assert.equal(result.status==='done',scenario==='current file intact');
    assert.equal(result.status,scenario==='current file intact'?'done':
      scenario==='file deleted'||scenario==='file modified'?'failed':'paused');
    assert.equal(result.goalVerification?.ok,scenario==='current file intact');
    assert.equal(result.acceptanceReport?.verdict,
      scenario==='current file intact'?'pass':
        scenario==='file deleted'||scenario==='file modified'?'fail':'unknown');
    if(scenario==='current capture missing') {
      assert.match(result.error??'',/missing_current_file_capture/);
      assert.equal(dispatched,1,'file RPC failure does not repeat Save or imply Worker outage');
    }
    if(scenario==='file deleted'||scenario==='file modified') {
      assert.match(result.error??'',/verified-file:1:/);
      assert.equal(dispatched,1,'a contradicted file is terminal and never saved again');
    }
    assert.equal(result.verifiedFiles?.length,1);
    assert.equal(trace.events(result.taskId).find(event=>event.node==='verify')?.state.lastVerification?.ok,true);
  } finally {trace.close();rmSync(dir,{recursive:true,force:true});}
});
