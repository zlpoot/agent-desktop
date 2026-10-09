import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {ChromeSession,KEY_SUBMIT_SELECTOR,CHROME_DISCOVERY_COLLECTOR,type ChromeNativeBackend} from '../src/desktop-provider/local-workspace-chrome-provider.js';
import {ResourceInputControl} from '../src/desktop-provider/resource-input-control.js';
import type {InputAuthority} from '../src/contracts/desktop-input-control.js';
import {CreateOneKey} from '../testbench/live-01/hidden-chrome.js';
import {candidateFromLiveTrace} from '../testbench/live-01/workflow-candidate.js';
import {createAgentLoop} from '../src/graph/graph.js';
import {initialState} from '../src/graph/state.js';
import {SqliteTrace} from '../src/trace/sqlite-trace.js';
import {Command,MemorySaver} from '@langchain/langgraph';

process.env.PLAYWRIGHT_BROWSERS_PATH??=resolve('.playwright-browsers');
const seed='SYNTHETIC_ONLY_KEY_1234567890abcdef';
const fixture=`<form hidden><input name="name" value="SYNTHETIC_OTHER_FORM"></form><button role="tab" id="access-tab" onclick="document.querySelector('section').hidden=false">接入权限</button>
<section hidden><button type="button" id="new-api-key" onclick="document.getElementById('synthetic-key-form').hidden=false">生成 API Key</button>
<form id="synthetic-key-form" hidden><label>Key 名称<input name="name" required></label><label>每分钟请求<input name="rpm" type="number" value="5" required></label>
<input name="max_output_tokens" type="number" value="1024" required><select name="days"><option value="30">30 天</option></select>
<label>合成模型 A<input name="allowed_models" type="checkbox"></label><label>合成模型 B<input name="allowed_models" type="checkbox"></label>
<button type="submit">确认生成</button></form><pre id="api-key-secret" hidden></pre></section>
<script>document.getElementById('synthetic-key-form').onsubmit=e=>{e.preventDefault();document.getElementById('api-key-secret').textContent='${seed}';document.getElementById('api-key-secret').hidden=false;document.getElementById('synthetic-key-form').hidden=true;};</script>`;

class SyntheticNative implements ChromeNativeBackend {
  grant?:InputAuthority; stopped=false; drift=false; checks=0;
  slowPing=0;
  async request<T>(method:string,authority?:InputAuthority):Promise<T> {
    if(method==='stop'){this.stopped=true;return {ownedJobEmpty:true,desktopHandleClosed:true} as T;}
    if(method==='activate'){assert.equal(authority?.owner.kind,'agent');this.grant=authority;return {ready:true} as T;}
    assert.ok(!this.drift&&!this.stopped&&authority===this.grant,'synthetic native identity/grant gate');
    if(method==='ping'&&this.slowPing)await new Promise(done=>setTimeout(done,this.slowPing));
    this.checks++;return {ready:true} as T;
  }
  async close(){this.stopped=true;}
}
async function harness() {
  const directory=await mkdtemp(join(tmpdir(),'chrome-contract-'));
  const {chromium}=await import('playwright');
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext();const page=await context.newPage();await page.setContent(fixture);
  const input=new ResourceInputControl();const native=new SyntheticNative();
  const binding={providerId:'windows-local-workspace',environmentId:'local-workspace:chrome',sessionId:'synthetic',instanceId:'synthetic-native',inputResourceId:'synthetic-resource'};
  const session=new ChromeSession(binding,native,1,input,async()=>({}),async()=>browser);
  input.registerBackend(b=>session.valid(b),()=>session.drain(),a=>session.activate(a));
  const authority=await input.acquire(session,{kind:'agent',clientId:'synthetic-test'});
  session.setSecretOutputPath(join(directory,'AgentDesktop_8102_API_Key.txt'));
  await session.connectRuntime(authority);
  return {directory,browser,page,input,native,session,authority,async close(){try{await session.close();}finally{await browser.close();await rm(directory,{recursive:true,force:true});}}};
}

test('Chrome collector never exports values, unknown identifiers or generated Key; real UI roles remain intact',async()=>{
  const h=await harness();try{
    await h.page.setContent(`<button role="tab" id="access-tab">接入权限</button><label>${seed}<input name="${seed}" id="${seed}" value="${seed}"></label><pre id="api-key-secret">${seed}</pre>`);
    const result=await h.page.evaluate(CHROME_DISCOVERY_COLLECTOR);
    assert.ok(!JSON.stringify(result).includes(seed));
    assert.equal((result as {controls:Array<{role:string}>}).controls[0]?.role,'tab');
  }finally{await h.close();}
});

test('pending native heartbeat does not suppress the live Host client heartbeat; lease remains 3 seconds',async()=>{
  const h=await harness();try{
    h.native.slowPing=2900;
    await new Promise(done=>setTimeout(done,3700));
    h.input.assertAuthority(h.session,h.authority);
    assert.equal((await h.session.status()).state,'open');
    await h.session.observe();
  }finally{await h.close();}
});

test('Chrome runtime preserves native authority, fresh observation, same-origin and submission admission',async()=>{
  const h=await harness();try{
    await assert.rejects(h.session.execute({kind:'navigate',url:'https://example.invalid'}),/Fresh/);
    await h.session.observe();
    await assert.rejects(h.session.execute({kind:'navigate',url:'https://example.invalid'}),/Origin/);
    await h.session.observe();
    await assert.rejects(h.session.execute({kind:'click',target:{kind:'selector',selector:KEY_SUBMIT_SELECTOR}}),/one-time/);
    h.native.drift=true;
    await assert.rejects(h.session.observe(),/native identity/);
    assert.equal((await h.session.status()).state,'stale');
  }finally{await h.close();}
});

test('synthetic live-path regression: risk gate stays pending, one submit, private file equality, no secret in trace/candidate',async()=>{
  const h=await harness();let claims=0;const trace=new SqliteTrace(join(h.directory,'task.sqlite'));
  try{
    h.session.authorizeCreation({keyName:'agent-desktop-hidden-chrome-20261009',maxOutputTokens:40000,allModels:true,claim:async()=>{claims++;assert.equal(claims,1);}});
    // about:blank carries a synthetic fixture; use the real rule decisions after
    // the initial fixture observation without navigating to ANY external site.
    const model=new CreateOneKey();
    const graph=createAgentLoop({runtime:h.session,model:{kind:'rule',name:'synthetic LIVE-01 contract',decide:async state=>{
      const projected={...state,observation:{...state.observation,url:'http://192.168.2.3:8102/'}};
      return model.decide(projected);
    }},trace,maxSteps:24,maxRetries:0,checkpointer:new MemorySaver(),acceptanceVerifier:{evaluate:async()=>{
      const facts=await h.session.verifyKeyOutcome();const ok=Object.values(facts).every(Boolean);
      return {mode:'assist',verdict:ok?'pass':'unknown',observationId:'synthetic',checks:[],message:'synthetic independent check'};
    }}});
    const state={...initialState('synthetic-task','创建 Key 并保存到当前用户桌面 AgentDesktop_8102_API_Key.txt',undefined,{pageTextIncludes:'"apiKeyGenerated":true'}),executorId:'live-01-hidden-chrome'};
    const config={configurable:{thread_id:state.taskId}};
    await graph.invoke(state,config);
    const pending=(await graph.getState(config)).values;
    assert.equal(pending.status,'waiting_user');assert.equal(claims,0,'risk interrupt cannot submit without approval');
    const result=await graph.invoke(new Command({resume:{approved:true}}),config);
    assert.equal(result.status,'done',result.error??result.summary??'synthetic live-path did not complete');assert.equal(claims,1);assert.equal(h.session.creationDispatched,true);
    assert.equal(await readFile(join(h.directory,'AgentDesktop_8102_API_Key.txt'),'utf8'),seed+'\n');
    assert.deepEqual(await h.session.verifyKeyOutcome(),{uiConfirmed:true,fileMatchesUi:true,settingsMatch:true});
    const snapshot=await h.session.inspectFile('AgentDesktop_8102_API_Key.txt');assert.equal(snapshot.text,undefined);
    assert.ok(!JSON.stringify(trace.events(state.taskId)).includes(seed));
    const candidate=candidateFromLiveTrace(trace,state.taskId,join(h.directory,'task.sqlite'));
    assert.equal(candidate.status,'candidate');assert.ok(!JSON.stringify(candidate).includes(seed));
    await h.session.observe();await assert.rejects(h.session.execute({kind:'click',target:{kind:'selector',selector:KEY_SUBMIT_SELECTOR}}),/one-time/);
    await writeFile(join(h.directory,'AgentDesktop_8102_API_Key.txt'),'SYNTHETIC_CHANGED_BODY');
    assert.equal((await h.session.verifyKeyOutcome()).fileMatchesUi,false);
  }finally{trace.close();await h.close();}
});
