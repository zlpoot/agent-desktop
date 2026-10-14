import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {FakeModel} from '../src/agent/model-adapter.js';
import {createAgentLoop} from '../src/graph/graph.js';
import {initialState} from '../src/graph/state.js';
import {FakeRuntime} from '../src/runtime/runtime-adapter.js';
import {SqliteTrace} from '../src/trace/sqlite-trace.js';
import {DesktopTaskController} from '../src/app/task-runner.js';
import {createDashboardServer} from '../src/app/server.js';

test('U9b terminal Trace is exposed as failed and real Controller rejects continue/resume',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'u9b-control-'));
  const trace=new SqliteTrace(join(dir,'web-tasks.sqlite'));
  const runtime=new FakeRuntime();
  const controller=new DesktopTaskController(dir,{modelProvider:{createModel(){throw Error('must not create a model');}}});
  let server:ReturnType<typeof createDashboardServer>|undefined;
  try{
    await createAgentLoop({runtime,trace,model:new FakeModel([]),pauseRequested:()=>true})
      .invoke(initialState('terminal','synthetic goal'));
    const saved=structuredClone(trace.load('terminal'));
    assert.equal(saved?.status,'failed');
    assert.throws(()=>controller.continue('terminal'),/任务未处于暂停状态/);
    assert.throws(()=>controller.resume('terminal',{approved:true}),/任务未处于等待人工状态/);
    server=createDashboardServer(dir,controller);
    await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
    const address=server.address();
    if(!address||typeof address==='string')throw Error('no synthetic port');
    const base='http://127.0.0.1:'+address.port;
    const details=await fetch(base+'/api/runs/web-tasks.sqlite/terminal').then(response=>response.json());
    assert.equal(details.status,'failed');assert.equal(details.error,saved?.error);assert.equal(details.summary,saved?.summary);
    const response=await fetch(base+'/api/tasks/terminal/continue',{method:'POST',
      headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(response.status,400);
    assert.match((await response.json()).error,/任务未处于暂停状态/);
    assert.deepEqual(trace.load('terminal'),saved);
    assert.equal(runtime.executed.length,0);
  }finally{
    if(server)await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));
    await controller.close();trace.close();rmSync(dir,{recursive:true,force:true});
  }
});
