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
import {auditTaskContractCoverage} from '../src/verification/task-contract-coverage.js';
import {desktopFileExpectationsFromGoal,explicitGoalFileBody} from '../src/verification/goal-file-coverage.js';

const GOAL='打开记事本，将正文「P7C-GEN-OK」另存为当前用户桌面的 report.txt';
function obs(saved:boolean){
  const now=Date.now();
  return {windowTitle:saved?'report.txt - Notepad':'无标题 - 记事本',
    pageText:saved?'P7C-GEN-OK':'',textEvidence:[{source:'uia' as const,text:saved?'P7C-GEN-OK':''}],
    capture:{epoch:'e',object:'window:1',sequence:saved?2:1,
      startedAt:now,finishedAt:now+1,
      clock:'collector' as const,atomic:false as const,
      fields:{pageText:{source:'uia' as const,complete:true}}}};
}
function runtimeFor(body:string){
  let dispatched=0,reads=0;
  const runtime={name:'fake Desktop',
    inspectFile:async()=>{reads++;
      const exists=reads>1;
      const text=body;
      return {path:'C:\\Users\\agent\\Desktop\\report.txt',root:'C:\\Users\\agent\\Desktop',
        capturedAt:Date.now(),exists,complete:true,
        ...(exists?{kind:'file' as const,size:text.length,mtimeMs:1700000000000,
          sha256:'a'.repeat(64),text}:{})};},
    observe:async()=>obs(dispatched>0),
    execute:async()=>{dispatched++;return {ok:true,message:'clicked save',effect:'dispatched' as const};}};
  return {runtime,get dispatched(){return dispatched;},get reads(){return reads;}};
}

test('goal parser freezes exact desktop file name and pinned body',()=>{
  const expected=desktopFileExpectationsFromGoal(GOAL);
  assert.deepEqual(expected,[{kind:'desktop_file',path:'report.txt',contentEquals:'P7C-GEN-OK'}]);
  assert.equal(explicitGoalFileBody('正文为 ABC123 另存为 a.txt'),'ABC123');
  assert.equal(explicitGoalFileBody('随便写点内容另存为 a.txt'),undefined);
});

test('generic task passes deterministically from frozen goal file, without a model postcondition',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'generic-file-pass-'));
  const trace=new SqliteTrace(join(dir,'trace.sqlite'));
  try {
    const harness=runtimeFor('P7C-GEN-OK');
    let acceptanceCalls=0;
    const model=new FakeModel([{kind:'click',target:{kind:'role',role:'Button',name:'保存(S)'}},
      {kind:'done',summary:'saved'}]);
    const result=await createAgentLoop({model,runtime:harness.runtime,trace,
      checkpointer:new MemorySaver(),
      acceptanceVerifier:{evaluate:async()=>{acceptanceCalls++;throw Error('JEV must be skipped');}}})
      .invoke(initialState('generic-pass',GOAL,undefined,
        {windowTitleIncludes:'report.txt',pageTextIncludes:'P7C-GEN-OK'}),
        {configurable:{thread_id:'generic-pass'}});
    assert.equal(result.status,'done');
    assert.equal(result.acceptanceReport?.verdict,'pass');
    assert.equal(acceptanceCalls,0,'deterministic file gate must not call the model verifier');
    assert.equal(result.verifiedFiles?.length,1);
    assert.equal(result.verifiedFiles?.[0].expected.contentEquals,'P7C-GEN-OK');
    assert.equal(harness.dispatched,1);
  } finally {trace.close();rmSync(dir,{recursive:true,force:true});}
});

test('generic task that writes the frozen file with wrong body terminally FAILs without replaying save',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'generic-file-wrong-'));
  const trace=new SqliteTrace(join(dir,'trace.sqlite'));
  try {
    const harness=runtimeFor('WRONG-CONTENT');
    const model=new FakeModel([{kind:'click',target:{kind:'role',role:'Button',name:'保存(S)'}},
      {kind:'done',summary:'saved'}]);
    const result=await createAgentLoop({model,runtime:harness.runtime,trace,
      checkpointer:new MemorySaver(),
      acceptanceVerifier:{evaluate:async()=>{throw Error('must not reach model verifier');}}})
      .invoke(initialState('generic-wrong',GOAL,undefined,
        {windowTitleIncludes:'report.txt',pageTextIncludes:'P7C-GEN-OK'}),
        {configurable:{thread_id:'generic-wrong'}});
    assert.equal(result.status,'failed');
    assert.equal(result.acceptanceReport?.verdict,'fail');
    assert.equal(harness.dispatched,1,'an attributable wrong-body save is never retried');
    assert.ok((result.taskFileContradictions?.length??0)>0);
  } finally {trace.close();rmSync(dir,{recursive:true,force:true});}
});

test('model action desktop_file postcondition does not shadow the frozen exact-body proof',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'generic-file-postcond-'));
  const trace=new SqliteTrace(join(dir,'trace.sqlite'));
  try {
    // File exists only AFTER the save action dispatches (true pre/post boundary),
    // independent of how many read-only inspections happen.
    let dispatched=0;
    const runtime={name:'fake Desktop',
      inspectFile:async()=>{const saved=dispatched>0;const text='P7C-GEN-OK';
        return {path:'C:\\Users\\agent\\Desktop\\report.txt',root:'C:\\Users\\agent\\Desktop',
          capturedAt:Date.now(),exists:saved,complete:true,
          ...(saved?{kind:'file' as const,size:text.length,mtimeMs:1700000000000,
            sha256:'a'.repeat(64),text}:{})};},
      observe:async()=>obs(dispatched>0),
      execute:async()=>{dispatched++;return {ok:true,message:'clicked save',effect:'dispatched' as const};}};
    const model=new FakeModel([
      {kind:'click',target:{kind:'role',role:'Button',name:'保存(S)'},
        // Model's own path-only postcondition (different casing, no pinned body).
        postcondition:{kind:'desktop_file',path:'REPORT.TXT'}} as never,
      {kind:'done',summary:'saved'}]);
    const result=await createAgentLoop({model,runtime,trace,
      checkpointer:new MemorySaver(),
      acceptanceVerifier:{evaluate:async()=>{throw Error('JEV must be skipped');}}})
      .invoke(initialState('generic-postcond',GOAL,undefined,
        {windowTitleIncludes:'report.txt',pageTextIncludes:'P7C-GEN-OK'}),
        {configurable:{thread_id:'generic-postcond'}});
    assert.equal(result.status,'done');
    assert.equal(result.acceptanceReport?.verdict,'pass');
    assert.equal(result.verifiedFiles?.length,1,'frozen proof must not be duplicated by thin action proof');
    assert.equal(result.verifiedFiles?.[0].expected.contentEquals,'P7C-GEN-OK');
    assert.equal(result.verifiedFiles?.[0].expected.path,'report.txt');
  } finally {trace.close();rmSync(dir,{recursive:true,force:true});}
});

test('file gate re-observes at completion so a post-save delay cannot make window evidence stale',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'generic-file-terminal-'));
  const trace=new SqliteTrace(join(dir,'trace.sqlite'));
  try {
    // Live C2F: Save verifies at t~2100, then stage diagnosis/done takes ~45s with
    // no observation node. verify_task re-reads the file at t~9200. The last stored
    // window capture (2100) is then older than the 5s freshness window -> the gate
    // must take ONE fresh end-of-task observation (9000) and pass, never relax time.
    let dispatched=0, afterReads=0, observeCalls=0;
    const mk=(fin:number,saved:boolean)=>{const now=fin;
      return {windowTitle:saved?'report.txt - Notepad':'无标题 - 记事本',
        pageText:saved?'P7C-GEN-OK':'',
        textEvidence:[{source:'uia' as const,text:saved?'P7C-GEN-OK':''}],
        capture:{epoch:'e',object:'window:1',sequence:saved?observeCalls:1,
          startedAt:now-1,finishedAt:now,clock:'collector' as const,atomic:false as const,
          fields:{pageText:{source:'uia' as const,complete:true}}}};};
    const runtime={name:'fake Desktop',
      inspectFile:async(path:string)=>{
        const lower=String(path).toLowerCase();
        const saved=dispatched>0;
        // 1st/2nd after-exists reads belong to the save-action boundary (t=2100);
        // the next read is the completion anti-replay re-read (t=9200).
        const terminal=saved&&(++afterReads)>=2;
        const cap=saved?(terminal?9200:2100):2000;
        const text='P7C-GEN-OK';
        return {path:saved?'C:\\Users\\agent\\Desktop\\REPORT.TXT':'C:\\Users\\agent\\Desktop\\report.txt',
          root:'C:\\Users\\agent\\Desktop',capturedAt:cap,exists:saved,complete:true,
          ...(saved?{kind:'file' as const,size:text.length,mtimeMs:1700000000000,
            sha256:'a'.repeat(64),text}:{})};},
      observe:async()=>{observeCalls++;
        if(!dispatched)return mk(1000,false);
        return mk(observeCalls>=3?9000:2100,true);},
      execute:async()=>{dispatched++;return {ok:true,message:'clicked save',effect:'dispatched' as const};}};
    const model=new FakeModel([{kind:'click',target:{kind:'role',role:'Button',name:'保存(S)'}},
      {kind:'done',summary:'saved'}]);
    const result=await createAgentLoop({model,runtime,trace,
      checkpointer:new MemorySaver(),
      acceptanceVerifier:{evaluate:async()=>{throw Error('JEV must be skipped');}}})
      .invoke(initialState('generic-terminal',GOAL,undefined,
        {windowTitleIncludes:'report.txt',pageTextIncludes:'P7C-GEN-OK'}),
        {configurable:{thread_id:'generic-terminal'}});
    assert.equal(result.status,'done');
    assert.equal(result.acceptanceReport?.verdict,'pass');
    assert.ok(observeCalls>=3,'completion must take a fresh end-of-task observation');
  } finally {trace.close();rmSync(dir,{recursive:true,force:true});}
});

test('explicit non-Desktop (drive/UNC) output path is an unsupported evidence contract -> UNKNOWN',()=>{
  const goal='打开记事本，将正文「P7C-OUT-OK」另存为 C:\\Users\\agent\\Documents\\report.txt';
  const names=desktopFileExpectationsFromGoal(goal).map(f=>f.path);
  const coverage=auditTaskContractCoverage(goal,undefined,names);
  assert.equal(coverage.covered,false);
  assert.equal(coverage.reason,'original_file_path_outside_frozen_desktop_contract');
  assert.equal(coverage.reviewRequired,true);
  // UNC paths are outside the frozen Desktop contract too.
  const unc=auditTaskContractCoverage('把正文「x」保存到 \\\\server\\share\\report.txt',undefined,
    desktopFileExpectationsFromGoal('把正文「x」保存到 \\\\server\\share\\report.txt').map(f=>f.path));
  assert.equal(unc.covered,false);
  assert.equal(unc.reason,'original_file_path_outside_frozen_desktop_contract');
});

test('ambiguous file goal with no concrete name stays a not-covered UNKNOWN, never a pass',()=>{
  const coverage=auditTaskContractCoverage('把内容保存到桌面文件',undefined,
    desktopFileExpectationsFromGoal('把内容保存到桌面文件').map(f=>f.path));
  assert.equal(coverage.covered,false);
  assert.equal(coverage.reason,'original_file_goal_has_no_file_contract');
  assert.equal(coverage.reviewRequired,true);
});
