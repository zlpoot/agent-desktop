import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {ChromeSession,LocalWorkspaceChromeProvider,KEY_SUBMIT_SELECTOR,CHROME_DISCOVERY_COLLECTOR,type ChromeNativeBackend} from '../src/desktop-provider/local-workspace-chrome-provider.js';
import {HiddenChromeTaskExecutor,HIDDEN_CHROME_READONLY_SCENARIO,HIDDEN_CHROME_CREATE_SCENARIO} from '../src/desktop-provider/hidden-chrome-task-executor.js';
import {WorkflowStore} from '../src/workflows/store.js';
import {workflowDigest} from '../src/workflows/recovery.js';
import {TaskDesktopSessions} from '../src/app/task-desktop-sessions.js';
import {createRootAssembly} from '../src/composition/root.js';
import {createDashboardServer} from '../src/app/server.js';
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
const fixture=`<form hidden><input name="name" value="SYNTHETIC_OTHER_FORM"></form><button role="tab" id="access-tab" onclick="document.querySelector('section').hidden=false;if(location.protocol==='http:')location.hash='access'">接入权限</button>
<section hidden><button type="button" id="new-api-key" onclick="document.getElementById('synthetic-key-form').hidden=false">生成 API Key</button>
<form id="synthetic-key-form" hidden><label>Key 名称<input name="name" required></label><label>每分钟请求<input name="rpm" type="number" value="5" required></label>
<input name="max_output_tokens" type="number" value="1024" required><select name="days"><option value="30">30 天</option></select>
${Array.from({length:9},(_,i)=>`<label>合成模型 ${i}<input name="allowed_models" type="checkbox"></label>`).join('')}
<button type="submit">确认生成</button></form><pre id="api-key-secret" hidden></pre></section>
<script>document.getElementById('synthetic-key-form').onsubmit=e=>{e.preventDefault();document.getElementById('api-key-secret').textContent='${seed}';document.getElementById('api-key-secret').hidden=false;document.getElementById('synthetic-key-form').hidden=true;};</script>`;

class SyntheticNative implements ChromeNativeBackend {
  grant?:InputAuthority; stopped=false; drift=false; checks=0;
  slowPing=0;
  failure?:string;
  async request<T>(method:string,authority?:InputAuthority):Promise<T> {
    if(method==='stop'){this.stopped=true;return {ownedJobEmpty:true,desktopHandleClosed:true} as T;}
    if(method==='activate'){assert.equal(authority?.owner.kind,'agent');this.grant=authority;return {ready:true} as T;}
    if(method==='inspect'){assert.ok(!this.drift&&!this.stopped);return {ready:true} as T;}
    if(this.failure)throw new Error(this.failure);
    assert.ok(!this.drift&&!this.stopped&&authority===this.grant,'synthetic native identity/grant gate');
    if(method==='ping'&&this.slowPing)await new Promise(done=>setTimeout(done,this.slowPing));
    this.checks++;return {ready:true} as T;
  }
  async close(){this.stopped=true;}
}
class DiagnosticInput extends ResourceInputControl {
  lastRenew=performance.now();failure?:{state:string;sinceRenewMs:number};
  override assertAuthority(...args:Parameters<ResourceInputControl['assertAuthority']>) {
    try {super.assertAuthority(...args);}catch(error){
      this.failure??={state:this.view(args[0]).state,sinceRenewMs:Math.round(performance.now()-this.lastRenew)};throw error;
    }
  }
  override renewAuthority(...args:Parameters<ResourceInputControl['renewAuthority']>) {
    super.renewAuthority(...args);this.lastRenew=performance.now();
  }
}
async function unclaimedHarness(now?:()=>number) {
  const directory=await mkdtemp(join(tmpdir(),'chrome-contract-'));
  const {chromium}=await import('playwright');
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext();const page=await context.newPage();await page.setContent(fixture);
  const input=new DiagnosticInput(now);const native=new SyntheticNative();
  const provider=new LocalWorkspaceChromeProvider(input,resolve('.'),resolve('synthetic/chrome.exe'),directory);
  const binding={providerId:'windows-local-workspace',environmentId:'local-workspace:chrome',sessionId:'synthetic',instanceId:'synthetic-native',inputResourceId:'synthetic-resource'};
  const session=new ChromeSession(binding,native,1,input,()=>provider.capabilities(),async()=>browser);
  input.registerBackend(b=>session.valid(b),()=>session.drain(),a=>session.activate(a));
  return {directory,browser,page,input,native,session,provider,async close(){try{await session.close();}finally{await provider.close();await browser.close();await rm(directory,{recursive:true,force:true});}}};
}
async function harness(now?:()=>number) {
  const h=await unclaimedHarness(now);
  const authority=await h.input.acquire(h.session,{kind:'agent',clientId:'synthetic-test'});
  h.session.setSecretOutputPath(join(h.directory,'AgentDesktop_8102_API_Key.txt'));
  await h.session.connectRuntime(authority);
  return {...h,authority};
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

test('an explicitly expired 3-second Host grant still blocks Hidden Chrome before any UI effect',async()=>{
  let now=0;const h=await harness(()=>now);
  try {
    await h.session.observe();now=3001;
    await assert.rejects(h.session.execute({kind:'navigate',url:'http://192.168.2.3:8102/'}),/invalid-input-authority/);
    assert.equal(h.page.url(),'about:blank');assert.equal(h.session.creationDispatched,false);
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

test('Native Task errors expose only recognized protocol codes, never arbitrary failure text',async()=>{
  for(const [failure,suffix] of [['Chrome native bridge: native_ack_timeout',': native_ack_timeout'],[seed,'']]) {
    const h=await harness();
    try {
      h.native.failure=failure;
      await assert.rejects(h.session.observe(),error=>{
        assert.equal((error as Error).message,'Chrome native identity or grant unavailable'+suffix);
        assert.ok(!String(error).includes(seed));return true;
      });
    }finally{await h.close();}
  }
});

test('synthetic live-path regression: risk gate stays pending, one submit, private file equality, no secret in trace/candidate',async()=>{
  // Exercise all nine checkboxes with the production clock and FULL WAL trace.
  // A frozen clock would hide writer stalls that expire input/capture authority.
  const h=await harness();let claims=0;const trace=new SqliteTrace(join(h.directory,'task.sqlite'),{journalMode:'wal'});
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
    assert.equal(pending.status,'waiting_user',pending.error??pending.summary??'synthetic risk gate not reached');assert.equal(claims,0,'risk interrupt cannot submit without approval');
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

test('Dashboard lists Hidden Chrome, requires explicit read-only scenario, uses fixed Task chain without model or Key creation',async()=>{
  const h=await unclaimedHarness();
  // Page routing fulfills the synthetic document; no request reaches 8102.
  await h.page.route('http://192.168.2.3:8102/**',route=>route.request().method()==='GET'
    ? route.fulfill({contentType:'text/html; charset=utf-8',body:fixture}):route.fallback());
  let opens=0;
  const provider={id:h.provider.id,kind:h.provider.kind,capabilities:()=>h.provider.capabilities(),
    discover:async()=>[{providerId:h.provider.id,environmentId:h.session.environmentId,kind:h.provider.kind}],
    open:async()=>{opens++;return h.session;}};
  const sessions=new TaskDesktopSessions([provider],new Map([[provider.id,new HiddenChromeTaskExecutor(h.provider)]]));
  const assembly=await createRootAssembly({rootDir:h.directory,desktopSessions:sessions,
    model:{createModel(){assert.fail('finite read-only scenario must not construct a model');}}});
  const server=createDashboardServer(h.directory,assembly.controller);
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const {chromium}=await import('playwright');
  const dashboardBrowser=await chromium.launch({headless:true});
  const dashboard=await dashboardBrowser.newPage();
  try {
    const options=await assembly.controller.desktopOptions();
    assert.equal(opens,0);assert.equal(h.native.grant,undefined,'discovery does not acquire input');
    assert.equal(options[0]!.executable,false);assert.equal(options[0]!.scenarios?.length,1);
    assert.throws(()=>sessions.assertTarget(options[0]!),/generic-task-unavailable/);
    await assert.rejects(h.session.execute({kind:'click',target:{kind:'selector',selector:KEY_SUBMIT_SELECTOR}}),/unavailable/);
    await dashboard.goto(`http://127.0.0.1:${address.port}`);
    const value=JSON.stringify([provider.id,h.session.environmentId]);
    await dashboard.waitForFunction(value=>!!document.querySelector(`#task-destination option`)&&
      [...(document.querySelector('#task-destination') as HTMLSelectElement).options].some(o=>o.value===value),value);
    assert.match(await dashboard.locator('#task-destination').innerText(),/Hidden Workspace Chrome/);
    await dashboard.locator('#task-destination').selectOption(value);
    assert.equal(opens,0);assert.equal(await dashboard.locator('#task-submit').isDisabled(),true);
    await dashboard.locator('#task-scenario').selectOption(HIDDEN_CHROME_READONLY_SCENARIO);
    await dashboard.locator('#task-submit').click();
    await dashboard.waitForFunction(()=>/阶段：完成|BLOCKED/.test(document.querySelector('#scenario-status')?.textContent??''));
    const runs=await (await fetch(`http://127.0.0.1:${address.port}/api/runs`)).json() as {runs:Array<{taskId:string}>};
    const trace=new SqliteTrace(join(h.directory,'web-tasks.sqlite'));
    const final=trace.load(runs.runs[0]!.taskId);trace.close();
    assert.match(await dashboard.locator('#scenario-status').innerText(),/执行 PASS.*验证 PASS.*清理 PASS/,final?.error??'synthetic Dashboard task incomplete');
    assert.match(await dashboard.locator('#scenario-facts').innerText(),/"keyCreationAdmitted": false/);
    assert.equal(opens,1);assert.equal(h.session.creationDispatched,false);assert.equal(h.session.keyFileSaved,false);
    assert.equal(h.session.readOnlyRestricted,true);
    assert.throws(()=>h.session.setSecretOutputPath(join(h.directory,'forbidden.txt')),/read-only/);
    assert.throws(()=>h.session.authorizeCreation({keyName:'agent-desktop-hidden-chrome-20261009',maxOutputTokens:40000,allModels:true,claim:async()=>assert.fail('no creation intent')}),/not authorized/);
    assert.equal(h.native.stopped,true);
  }finally{await dashboardBrowser.close();await new Promise<void>(done=>server.close(()=>done()));await assembly.dispose();await h.close();}
});

test('read-only session blocks mutating page requests and cannot admit a Key configuration',async()=>{
  const h=await unclaimedHarness();
  try {
    const context=h.browser.contexts()[0]!;
    const originalRoute=context.route.bind(context);
    let policy:((route:import('playwright').Route)=>unknown)|undefined;
    context.route=async(pattern,handler,options)=>{policy=route=>handler(route,route.request());return originalRoute(pattern,handler,options);};
    h.session.restrictToReadOnly();
    assert.throws(()=>h.session.setSecretOutputPath(join(h.directory,'forbidden.txt')),/read-only/);
    const authority=await h.input.acquire(h.session,{kind:'agent',clientId:'synthetic-read-only'});
    await h.session.connectRuntime(authority);
    let denied=false;
    assert.ok(policy);
    // Invoke the actual installed request fence with a synthetic Route. No
    // browser request can reach the private site even if this regression fails.
    await policy({request:()=>({url:()=> 'http://192.168.2.3:8102/synthetic-no-network',method:()=> 'POST'}),
      abort:async()=>{denied=true;},continue:async()=>assert.fail('read-only POST cannot leave the browser')} as unknown as import('playwright').Route);
    assert.equal(denied,true);assert.equal(h.session.creationDispatched,false);
  }finally{await h.close();}
});

test('read-only acceptance requires the exact access fragment, not the root or an unrelated URL',async()=>{
  const h=await unclaimedHarness();
  await h.page.route('http://192.168.2.3:8102/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:fixture}));
  const executor=new HiddenChromeTaskExecutor(h.provider),control=executor.taskControl(h.session);
  let prepared:import('../src/contracts/desktop-scenario.js').PreparedDesktopScenario|undefined;
  try {
    prepared=await executor.prepareScenario(h.session,'',HIDDEN_CHROME_READONLY_SCENARIO);
    await control.beginTask('synthetic-fragment');await prepared.observe();await prepared.execute();
    assert.equal((await prepared.verify()).verdict,'pass');
    for(const suffix of ['', '#other', '?unrelated=1#access']) {
      await h.page.evaluate(suffix=>history.replaceState(null,'','/'+suffix),suffix);
      const result=await prepared.verify();
      assert.equal(result.verdict,'pending');assert.equal(result.facts.siteConfirmed,false);
    }
    assert.equal(h.session.creationDispatched,false);
  }finally{await prepared?.close();await h.close();}
});

test('Dashboard newly authorized one-Key scenario uses the real Task/Agent Loop/file gate, saves a secret-free candidate and refuses reuse',async()=>{
  const h=await unclaimedHarness();
  await h.page.route('http://192.168.2.3:8102/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:fixture}));
  const config={authorizationId:'33333333-3333-4333-8333-333333333333',keyName:'agent-desktop-hidden-chrome-20261009-2',
    outputFile:'AgentDesktop_8102_API_Key_20261009_2.txt',allModels:true as const,maxOutputTokens:40000 as const,otherDefaults:true as const};
  let opens=0;
  const provider={id:h.provider.id,kind:h.provider.kind,capabilities:()=>h.provider.capabilities(),
    discover:async()=>[{providerId:h.provider.id,environmentId:h.session.environmentId,kind:h.provider.kind}],
    open:async()=>{opens++;return h.session;}};
  const executor=new HiddenChromeTaskExecutor(h.provider,h.directory,config,()=>h.directory);
  const sessions=new TaskDesktopSessions([provider],new Map([[provider.id,executor]]));
  const assembly=await createRootAssembly({rootDir:h.directory,desktopSessions:sessions,
    model:{createModel(){assert.fail('finite creation must not construct a model');}}});
  const server=createDashboardServer(h.directory,assembly.controller);
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const {chromium}=await import('playwright'),dashboardBrowser=await chromium.launch({headless:true});
  const dashboard=await dashboardBrowser.newPage();
  try {
    const originalOutput=join(h.directory,'AgentDesktop_8102_API_Key.txt');await writeFile(originalOutput,'SYNTHETIC_OLD_KEY');
    const options=await assembly.controller.desktopOptions();assert.equal(options[0]!.scenarios?.length,2);assert.equal(opens,0);
    await dashboard.goto(`http://127.0.0.1:${address.port}`);
    const value=JSON.stringify([provider.id,h.session.environmentId]);
    await dashboard.waitForFunction(value=>[...(document.querySelector('#task-destination') as HTMLSelectElement).options].some(o=>o.value===value),value);
    await dashboard.locator('#task-destination').selectOption(value);
    await dashboard.locator('#task-scenario').selectOption(HIDDEN_CHROME_CREATE_SCENARIO);
    await dashboard.locator('#task-submit').click();
    await dashboard.waitForFunction(()=>/阶段：完成|BLOCKED/.test(document.querySelector('#scenario-status')?.textContent??''),undefined,{timeout:55000});
    const runs=await (await fetch(`http://127.0.0.1:${address.port}/api/runs`)).json() as {runs:Array<{taskId:string}>};
    const taskId=runs.runs[0]!.taskId,trace=new SqliteTrace(join(h.directory,'web-tasks.sqlite'));
    const final=trace.load(taskId);trace.close();
    const diagnostic=new SqliteTrace(join(h.directory,'.artifacts/web-tasks',taskId,'live-01/task.sqlite'));
    const stopped=diagnostic.load(taskId);diagnostic.close();
    assert.equal(final?.status,'done',JSON.stringify({outerError:final?.error,innerStatus:stopped?.status,
      innerError:stopped?.error,innerSummary:stopped?.summary,lastAction:stopped?.lastAction,input:h.input.failure,nativeFailure:h.session.nativeFailure}));
    assert.equal(opens,1);assert.equal(h.session.creationDispatched,true);assert.equal(h.session.keyFileSaved,true);
    assert.equal(await readFile(join(h.directory,config.outputFile),'utf8'),seed+'\n');
    assert.equal(await readFile(originalOutput,'utf8'),'SYNTHETIC_OLD_KEY');
    const inner=new SqliteTrace(join(h.directory,'.artifacts/web-tasks',taskId,'live-01/task.sqlite'));
    const accepted=inner.load(taskId);assert.equal(accepted?.acceptanceReport?.verdict,'pass');
    assert.ok(accepted?.verifiedFiles?.length);assert.ok(!JSON.stringify(inner.events(taskId)).includes(seed));
    assert.equal(inner.events(taskId).filter(e=>e.node==='execute'&&e.state.lastAction?.kind==='click'&&
      e.state.lastAction.target.kind==='selector'&&e.state.lastAction.target.selector===KEY_SUBMIT_SELECTOR).length,1);inner.close();
    const store=new WorkflowStore(join(h.directory,'workflows.sqlite'));
    const candidates=store.list();store.close();assert.equal(candidates.length,1);assert.equal(candidates[0]!.status,'candidate');
    assert.ok(!JSON.stringify(candidates).includes(seed));assert.ok(candidates[0]!.taskPattern.includes('{{keyName}}'));
    assert.throws(()=>assembly.controller.submitWorkflow({id:candidates[0]!.id,version:candidates[0]!.version,
      definitionHash:workflowDigest(candidates[0]!),destination:'browser',trial:true,
      values:Object.fromEntries(candidates[0]!.inputs.map(input=>[input.name,input.example!]))}),/创建候选仅供查看/);
    assert.ok(!JSON.stringify(final).includes(seed));assert.ok(!(await dashboard.locator('#scenario-facts').innerText()).includes(seed));
    assert.throws(()=>assembly.controller.submitScenario({desktopTarget:options[0]!,scenarioId:HIDDEN_CHROME_CREATE_SCENARIO}),/authorization-unavailable/);
    assert.equal((await assembly.controller.desktopOptions())[0]!.scenarios![1]!.availability,'unavailable');
    assert.equal(h.native.stopped,true);
  }finally{await dashboardBrowser.close();await new Promise<void>(done=>server.close(()=>done()));await assembly.dispose();await h.close();}
});
