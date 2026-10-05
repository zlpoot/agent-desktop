import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {PlaywrightRuntime} from '../src/runtime/browser/playwright-runtime.js';
import {HybridVerifier} from '../src/verifier/hybrid-verifier.js';
import type {CompletionCriteria} from '../src/verifier/verifier.js';

test('Todo fixture actions produce independent PASS, variant PASS and blocked FAIL',async()=>{
  const probe=createServer();
  await new Promise<void>(done=>probe.listen(0,'127.0.0.1',done));
  const address=probe.address();if(!address||typeof address==='string')throw Error('No fixture port');
  await new Promise<void>(done=>probe.close(()=>done()));
  const port=address.port;
  const base=`http://127.0.0.1:${port}`;
  const fixture=spawn(process.execPath,['testbench/todo-server.mjs'],{
    cwd:process.cwd(),env:{...process.env,AGENT_DESKTOP_TODO_PORT:String(port)},
    stdio:'ignore',windowsHide:true});
  const dir=mkdtempSync(join(tmpdir(),'p1-todo-actions-'));
  let runtime:PlaywrightRuntime|undefined;
  try {
    let ready=false;
    for(let attempt=0;attempt<40;attempt++){
      try {const response=await fetch(base);if(response.ok){ready=true;break;}}catch { /* Launching. */ }
      await delay(100);
    }
    assert.ok(ready,'fixture did not start');
    runtime=await PlaywrightRuntime.launch({headless:true,artifactDir:join(dir,'screenshots')});
    const verifier=new HybridVerifier({baseUrl:'http://127.0.0.1:1',apiKey:'unused',mode:'assist',
      confidenceThreshold:0.8,timeoutMs:100,instructions:()=>''});
    for(const [title,blocked] of [
      ['核对蓝色样本',false],['核对绿色样本',false],['核对失败样本',true],
    ] as const){
      await fetch(`${base}/__reset`,{method:'POST'});
      const page=blocked?`${base}/?mode=blocked`:`${base}/`;
      assert.equal((await runtime.execute({kind:'navigate',url:page})).ok,true);
      assert.equal((await runtime.execute({kind:'type',target:{kind:'label',label:'任务'},text:title})).ok,true);
      assert.equal((await runtime.execute({kind:'click',target:{kind:'role',role:'button',name:'添加任务'}})).ok,true);
      const criteria:CompletionCriteria={structuredStates:[{
        target:{role:'checkbox',name:title},field:'checked',equals:true}]};
      const goal=`添加并完成“${title}”`;
      const contract={goal,successConditions:criteria,evidenceSources:{structuredStates:'dom' as const},
        verifierStrategy:'rules_then_jev' as const};
      const before=await verifier.evaluate(goal,criteria,await runtime.observe(),'task',contract);
      assert.equal(before.verdict,'fail');
      if(!blocked){
        assert.equal((await runtime.execute({kind:'click',target:{kind:'role',role:'checkbox',name:title}})).ok,true);
      }
      const after=await verifier.evaluate(goal,criteria,await runtime.observe(),'task',contract);
      assert.equal(after.verdict,blocked?'fail':'pass');
      assert.equal(after.auxiliary,undefined);
      const oracle=await (await fetch(`${base}/__state`)).json() as Array<{title:string;completed:boolean}>;
      assert.deepEqual(oracle,[{title,completed:!blocked}]);
    }
  } finally {
    await runtime?.close();fixture.kill();
    const target=resolve(dir);
    if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('p1-todo-actions-'))
      throw Error('Refusing to remove an unexpected test directory');
    rmSync(target,{recursive:true,force:true});
  }
});
