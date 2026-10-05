import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {auditTaskContractCoverage} from '../src/verification/task-contract-coverage.js';
import {VerificationEngine} from '../src/verification/engine.js';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemorySaver} from '@langchain/langgraph';
import {createAgentLoop} from '../src/graph/graph.js';
import {initialState} from '../src/graph/state.js';
import {FakeModel} from '../src/agent/model-adapter.js';
import {SqliteTrace} from '../src/trace/sqlite-trace.js';

const cases=JSON.parse(readFileSync('testbench/verification/v1/development.json','utf8')) as Array<{
  id:string;goal:string;input:Parameters<VerificationEngine['verify']>[0];
}>;
const fixture=(id:string)=>structuredClone(cases.find(item=>item.id===id)!);

test('original file destination is audited before action without consulting outcome evidence',()=>{
  const item=fixture('challenge/contract-omits-path');
  const declared=item.input.contract.criteria.filter(c=>c.field==='canonicalPath')
    .map(c=>String((c.predicate as {expected?:unknown}).expected));
  assert.deepEqual(declared,[]);
  assert.deepEqual(auditTaskContractCoverage(item.goal,{pageTextIncludes:'approved'},declared),{
    covered:false,reason:'original_file_name_not_covered',requiredFiles:['report.txt'],reviewRequired:true});
  assert.equal(auditTaskContractCoverage(item.goal,{pageTextIncludes:'approved'},['report.txt']).covered,true);
  assert.equal(auditTaskContractCoverage('保存客户修改',{
    structuredStates:[{target:{role:'Text',name:'保存结果'},field:'text',equals:'已保存'}]}).covered,true);
  assert.equal(auditTaskContractCoverage('保存客户修改',{
    structuredStates:[{target:{role:'Edit',name:'手机号'},field:'value',equals:'123'}]}).reason,
    'durable_result_source_missing');
});

test('a bound active phase keeps an unfinished result UNKNOWN; terminal contradiction still FAILS',async()=>{
  const item=fixture('challenge/pending-not-terminal-failure');
  const engine=new VerificationEngine();
  let result=await engine.verify(item.input);
  assert.equal(result.verdict,'unknown');
  assert.equal(result.checks.find(c=>c.id==='resultStatus')?.reason,'outcome_pending');
  assert.equal(result.metrics.modelCalls,0);
  const completed=structuredClone(item.input);
  completed.evidence.find(e=>e.field==='phase')!.value='done';
  result=await engine.verify(completed);
  assert.equal(result.verdict,'fail');
  const stale=structuredClone(item.input);
  stale.evidence.find(e=>e.field==='phase')!.capturedAt=9300;
  assert.equal((await engine.verify(stale)).verdict,'fail');
  const foreign=structuredClone(item.input);
  foreign.evidence.find(e=>e.field==='phase')!.object='result-B';
  assert.equal((await engine.verify(foreign)).verdict,'fail');
  const wrongRequest=structuredClone(item.input);
  wrongRequest.evidence.find(e=>e.field==='requestId')!.value='another-request';
  assert.equal((await engine.verify(wrongRequest)).verdict,'fail');
});

test('a frozen preflight gap remains UNKNOWN after a visually successful action',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'p7b-preflight-'));
  const trace=new SqliteTrace(join(dir,'trace.sqlite'));
  let dispatched=0;
  try {
    const goal='将准确文本保存为当前用户桌面的 report.txt';
    const criteria={windowTitleIncludes:'report.txt'};
    const state={...initialState('p7b-preflight',goal,undefined,criteria),
      contractCoverage:auditTaskContractCoverage(goal,criteria,[])};
    const runtime={async observe(){return {windowTitle:'report.txt - Notepad'};},
      async execute(){dispatched++;return {ok:true,message:'saved'};}};
    const result=await createAgentLoop({model:new FakeModel([
      {kind:'click',target:{kind:'role',role:'Button',name:'Save'}},
      {kind:'done',summary:'saved'}]),runtime,trace,checkpointer:new MemorySaver(),
      acceptanceVerifier:{async evaluate(){throw Error('missing contract must not reach verifier');}}})
      .invoke(state,{configurable:{thread_id:state.taskId}});
    assert.equal(dispatched,1);
    assert.equal(result.status,'paused');
    assert.equal(result.acceptanceReport?.verdict,'unknown');
    assert.equal(result.acceptanceReport?.reason,'unsupported_condition');
    assert.match(result.error??'',/original_file_name_not_covered/);
  }finally{trace.close();rmSync(dir,{recursive:true,force:true});}
});
