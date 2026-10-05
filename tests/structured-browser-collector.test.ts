import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve as resolvePath} from 'node:path';
import {PlaywrightRuntime} from '../src/runtime/browser/playwright-runtime.js';
import {HybridVerifier} from '../src/verifier/hybrid-verifier.js';
import {createAgentLoop} from '../src/graph/graph.js';
import {initialState} from '../src/graph/state.js';
import {FakeModel} from '../src/agent/model-adapter.js';
import {SqliteTrace} from '../src/trace/sqlite-trace.js';
import type {CompletionCriteria} from '../src/verifier/verifier.js';
import type {Observation} from '../src/actions/schema.js';

test('real Chromium collector verifies Todo positive, parameter variant and wrong state',async()=>{
  const server=createServer((request,response)=>{
    response.setHeader('Content-Type','text/html; charset=utf-8');
    const query=new URL(request.url??'/','http://127.0.0.1').searchParams;
    const title=query.get('title')==='green'?'核对绿色样本':'核对蓝色样本';
    const done=query.get('done')!=='false';
    response.end(`<ul class="todo-list"><li class="${done?'completed':''}"><input type="checkbox" aria-label="${title}" ${done?'checked':''}><label>${title}</label></li></ul><input type="password" value="fixture-secret">`);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw Error('server unavailable');
  const dir=mkdtempSync(join(tmpdir(),'p1-collector-'));
  const trace=new SqliteTrace(join(dir,'trace.sqlite'));
  let runtime:PlaywrightRuntime|undefined;
  try {
    runtime=await PlaywrightRuntime.launch({headless:true,artifactDir:join(dir,'screenshots')});
    const verifier=new HybridVerifier({baseUrl:'http://127.0.0.1:1',apiKey:'unused',mode:'assist',
      confidenceThreshold:0.8,timeoutMs:100,instructions:()=>''});
    for(const [title,done,expected] of [
      ['核对蓝色样本',true,'pass'],['核对绿色样本',true,'pass'],
      ['核对蓝色样本',false,'fail']] as const) {
      const url=`http://127.0.0.1:${address.port}/?title=${title==='核对绿色样本'?'green':'blue'}&done=${done}`;
      await runtime.execute({kind:'navigate',url});
      const observation:Observation=await runtime.observe();
      assert.equal(observation.capture?.fields.structured.source,'dom');
      assert.equal(observation.structured?.items.find(item=>item.role==='listitem')?.checked,done);
      assert.equal(observation.structured?.items.find(item=>item.role==='checkbox')?.text,title);
      assert.equal(observation.structured?.items.find(item=>item.role==='textbox')?.value,undefined);
      const goal=`添加并完成“${title}”`;
      const criteria:CompletionCriteria={structuredStates:[{target:{role:'listitem',text:title},
        field:'checked',equals:true}]};
      const report=await verifier.evaluate(goal,criteria,observation,'task',
        {goal,successConditions:criteria,evidenceSources:{structuredStates:'dom'},
          verifierStrategy:'rules_then_jev'});
      assert.equal(report.verdict,expected);assert.equal(report.auxiliary,undefined);
      const checkboxCriteria:CompletionCriteria={structuredStates:[{target:{role:'checkbox',text:title},
        field:'checked',equals:true}]};
      const checkboxReport=await verifier.evaluate(goal,checkboxCriteria,observation,'task',
        {goal,successConditions:checkboxCriteria,evidenceSources:{structuredStates:'dom'},
          verifierStrategy:'rules_then_jev'});
      assert.equal(checkboxReport.verdict,expected);
      const taskId=`p1-browser-${title==='核对绿色样本'?'variant':done?'positive':'negative'}`;
      const state={...initialState(taskId,goal,undefined,criteria),verificationContract:
        {goal,successConditions:criteria,evidenceSources:{structuredStates:'dom' as const},
          verifierStrategy:'rules_then_jev' as const}};
      const run=await createAgentLoop({model:new FakeModel([{kind:'done',summary:'已处理'}]),
        runtime,trace,acceptanceVerifier:verifier,maxSteps:2}).invoke(state);
      assert.equal(run.acceptanceReport?.verdict,expected);
      assert.ok(trace.events(taskId).some(event=>event.node==='acceptance_task'));
    }
  } finally {
    trace.close();await runtime?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));
    const target=resolvePath(dir);
    if(dirname(target)!==resolvePath(tmpdir())||!basename(target).startsWith('p1-collector-'))
      throw new Error('Refusing to remove an unexpected test directory');
    rmSync(target,{recursive:true,force:true});
  }
});
