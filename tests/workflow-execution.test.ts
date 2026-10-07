import { fixtureDesktopSessions, fixtureDesktopTarget } from './fixtures/task-desktop.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopTaskController } from '../src/app/task-runner.js';
import { WorkflowStore } from '../src/workflows/store.js';
import { SqliteTrace } from '../src/trace/sqlite-trace.js';
import { prepareWorkflowExecution, explicitReplaySucceeded, explicitWorkflowWindow,
  explicitWorkflowUsesStructuredTargets } from '../src/workflows/execution.js';
import { workflowDigest } from '../src/workflows/recovery.js';
import { WorkflowReplayModel } from '../src/workflows/replay-model.js';
import { initialState } from '../src/graph/state.js';
import { singleProvider } from '../src/actions/action-resolution.js';
import type { Workflow } from '../src/workflows/schema.js';
import type { PlanningModel } from '../src/contracts/model-provider.js';
import type { WorkerClient } from '../src/contracts/worker-client.js';
import { recoverDesktopTasks } from '../src/desktop-session/recovery.js';
import { PlaywrightRuntime } from '../src/runtime/browser/playwright-runtime.js';
import { FakeRuntime } from '../src/runtime/runtime-adapter.js';
import { DatabaseSync } from 'node:sqlite';
import { createDashboardServer } from '../src/app/server.js';

const definition: Workflow = { id: 'fixed', version: 1, status: 'verified', environment: 'windows',
  taskPattern: 'write {{value}}', inputs: [{ name: 'value', example: 'A' }], preconditions: [],
  steps: [{ goal: 'write', action: { kind: 'keypress', keys: 'a' }, preferredMethods: [],
    successCondition: { kind: 'text_includes', value: '{{value}}' } }],
  successConditions: { pageTextIncludes: '{{value}}' }, knownFailures: [], sourceTaskId: 'seed',
  sourceTrace: 'seed', createdAt: '', successCount: 1, failureCount: 0 };
const request = { id: 'fixed', version: 1, definitionHash: workflowDigest(definition), values: { value: 'A' }, destination: 'windows' as const };

for (const destination of ['windows', 'browser'] as const) test(`${destination} Workflow goal 保留原始语义，不添加环境路由前缀`, () => {
  const workflow = { ...definition, environment: destination };
  const prepared = prepareWorkflowExecution(workflow, { ...request, destination, definitionHash: workflowDigest(workflow) });
  assert.equal(prepared.goal, 'write A');
  assert.doesNotMatch(prepared.goal, /^VM:/);
});

test('Windows Workflow 缺失 target、Browser Workflow 携带 target 或 destination 不匹配均在入队前拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-target-'));
  const store = new WorkflowStore(join(dir, 'workflows.sqlite'));
  store.addCandidate({ ...definition, status: 'candidate' }); store.recordReplay('fixed', 1, 'seed', true);
  const browser = store.addCandidate({ ...definition, id: 'browser', environment: 'browser', status: 'candidate' });
  let selected = 0, connected = 0, models = 0;
  const sessions = fixtureDesktopSessions(async () => { connected++; throw Error('must not connect'); });
  const assertTarget = sessions.assertTarget.bind(sessions);
  sessions.assertTarget = target => { selected++; return assertTarget(target); };
  const controller = new DesktopTaskController(dir, { desktopSessions: sessions,
    modelProvider: { createModel() { models++; throw Error('must not plan'); } } });
  const trace = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
  try {
    assert.throws(() => controller.submitWorkflow(request), /desktop-target-required/);
    const browserRequest = { ...request, id: browser.id, destination: 'browser' as const,
      definitionHash: workflowDigest(browser), trial: true };
    assert.throws(() => controller.submitWorkflow(browserRequest, undefined, fixtureDesktopTarget), /desktop-target-destination-conflict/);
    assert.throws(() => controller.submitWorkflow({ ...request, destination: 'browser' }, undefined, fixtureDesktopTarget), /不匹配/);
    const db = new DatabaseSync(join(dir, 'web-tasks.sqlite'));
    try { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()?.count, 0); }
    finally { db.close(); }
    assert.equal(selected, 0); assert.equal(connected, 0); assert.equal(models, 0);
  } finally { await controller.close(); trace.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const trial of [false, true]) for (const pause of [false, true]) test(`targetless Browser Workflow ${trial ? 'trial' : 'execute'}${pause ? ' 同一任务暂停恢复' : ''}固定原版本且不 acquire Desktop Session`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-workflow-'));
  const store = new WorkflowStore(join(dir, 'workflows.sqlite'));
  const candidate = store.addCandidate({ ...definition, environment: 'browser', status: 'candidate',
    taskPattern: '打开 {{url}}', inputs: [{ name: 'url', example: 'https://example.test/result' }],
    steps: [{ goal: '打开结果', action: { kind: 'navigate', url: '{{url}}' }, preferredMethods: [],
      successCondition: { kind: 'url_includes', value: '/result' } }], successConditions: { urlIncludes: '/result' } });
  if (!trial) store.recordReplay(candidate.id, 1, 'seed', true);
  const workflow = store.get(candidate.id, 1)!;
  const req = { id: workflow.id, version: 1, definitionHash: workflowDigest(workflow),
    values: { url: 'https://example.test/result' }, destination: 'browser' as const, ...(trial ? { trial: true } : {}) };
  const runtime = new FakeRuntime(); let closed = 0, planned = 0, desktopAcquired = 0, pauseOnce = pause, restored = 0;
  const fakeBrowser = Object.assign(runtime, { async close() { closed++; }, async restore() { restored++; } });
  t.mock.method(PlaywrightRuntime, 'launch', async () => fakeBrowser as unknown as PlaywrightRuntime);
  const sessions = fixtureDesktopSessions(async () => { throw Error('must not connect'); });
  t.mock.method(sessions, 'acquire', async () => { desktopAcquired++; throw Error('must not acquire'); });
  const controller = new DesktopTaskController(dir, { desktopSessions: trial ? undefined : sessions,
    modelProvider: { createModel: () => ({ kind: 'rule', name: 'fixture',
      async planTask() { planned++; throw Error('Browser Workflow environment is already fixed'); },
      async decide() { throw Error('explicit workflow must not explore or rematch'); },
    } as unknown as PlanningModel) },
    traceStore: path => { const log = new SqliteTrace(path); const save = log.save.bind(log);
      log.save = (node, state) => { save(node, state);
        if (pauseOnce && node === 'verify') { pauseOnce = false; log.requestPause(state.taskId); }
      }; return log;
    } });
  const trace = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
  const routes = new DatabaseSync(join(dir, 'web-task-routes.sqlite'));
  const server = trial ? createDashboardServer(dir, controller) : undefined;
  async function wait(id: string) {
    const end = Date.now() + 10000;
    while (!['done', 'failed', 'paused', 'waiting_user'].includes(trace.load(id)?.status ?? '') && Date.now() < end)
      await new Promise(resolve => setTimeout(resolve, 10));
  }
  try {
    let id: string;
    if (server) {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address(); if (!address || typeof address === 'string') throw Error('No port');
      const base = `http://127.0.0.1:${address.port}`;
      const response = await fetch(`${base}/api/workflows/${workflow.id}/1/trial`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(req),
      });
      const body = await response.json(); assert.equal(response.status, 202, JSON.stringify(body)); id = body.taskId;
    } else id = controller.submitWorkflow(req);
    assert.equal(trace.load(id)?.goal, '打开 https://example.test/result');
    assert.equal(routes.prepare('SELECT environment FROM generic_routes WHERE task_id = ?').get(id)?.environment, 'browser');
    store.addCandidate({ ...candidate, steps: [{ ...candidate.steps[0], action: { kind: 'navigate', url: 'https://example.test/wrong-version' } }] });
    store.recordReplay(candidate.id, 2, 'new-version', true);
    await wait(id);
    if (pause) {
      assert.equal(trace.load(id)?.status, 'paused');
      controller.continue(id);
      // Wait for the paused state to be consumed before waiting for a terminal state.
      const end = Date.now() + 10000;
      while (trace.load(id)?.status === 'paused' && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
      await wait(id);
      assert.equal(restored, 1);
    }
    const state = trace.load(id)!;
    assert.equal(state.status, 'done', JSON.stringify(state));
    assert.deepEqual(runtime.executed, [{ kind: 'navigate', url: req.values.url }]);
    assert.deepEqual(state.workflowRef, { id: workflow.id, version: 1, values: req.values,
      definitionHash: req.definitionHash, explicit: true, ...(trial ? { trial: true } : {}) });
    assert.equal(state.workflowReplayState?.nextIndex, 1);
    assert.equal(state.desktopTarget, undefined); assert.equal(state.desktopExecutionBinding, undefined);
    assert.equal(desktopAcquired, 0); assert.equal(planned, 0);
    assert.equal(store.get(workflow.id, 1)?.successCount, trial ? 1 : 2);
    assert.equal(store.get(workflow.id, 1)?.status, trial ? 'candidate' : 'verified');
  } finally { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await controller.close(); assert.equal(closed, pause ? 2 : 1);
    trace.close(); routes.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Windows Workflow 的结构化环境不能被 planner 改为 Browser', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-plan-environment-'));
  mkdirSync(join(dir, 'config')); writeFileSync(join(dir, 'config/agent-desktop-apps.json'), '[]');
  const store = new WorkflowStore(join(dir, 'workflows.sqlite'));
  store.addCandidate({ ...definition, status: 'candidate' }); store.recordReplay('fixed', 1, 'seed', true);
  let launched = 0, dispatched = 0;
  const controller = new DesktopTaskController(dir, {
    desktopSessions: fixtureDesktopSessions(async () => ({
      async listWindows() { return []; }, async close() {},
      async ensureApp() { launched++; throw Error('must not launch'); },
      async execute() { dispatched++; throw Error('must not dispatch'); },
    } as unknown as WorkerClient)),
    modelProvider: { createModel: () => ({ async planTask() {
      return { task: { environment: 'browser', plan: [], completionCriteria: {} } };
    } } as unknown as PlanningModel) },
  });
  const trace = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
  try {
    const id = controller.submitWorkflow(request, undefined, fixtureDesktopTarget);
    const end = Date.now() + 10000;
    while (trace.load(id)?.status !== 'failed' && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(trace.load(id)?.error ?? '', /workflow-plan-environment-mismatch/);
    assert.equal(launched, 0); assert.equal(dispatched, 0);
  } finally { await controller.close(); trace.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('指定流程契约拒绝过期定义、未验证版本、阶段流程及无效参数', () => {
  assert.equal(prepareWorkflowExecution(definition, request).goal, 'write A');
  for (const flow of [undefined, { ...definition, version: 2 }, { ...definition, status: 'candidate' as const },
    { ...definition, status: 'retired' as const }, { ...definition, scope: 'stage' as const }]) {
    assert.throws(() => prepareWorkflowExecution(flow, request));
  }
  assert.throws(() => prepareWorkflowExecution(definition, { ...request, definitionHash: 'stale' }));
  assert.throws(() => prepareWorkflowExecution(definition, { ...request, values: {} }));
  assert.throws(() => prepareWorkflowExecution(definition, { ...request, values: { value: 'A', extra: 'B' } }));
});

test('指定文件流程的原始目标文件名不能被后置条件遗漏或替换',()=>{
  const fileWorkflow:Workflow={...definition,taskPattern:'将文本保存到桌面 {{filename}}',
    inputs:[{name:'filename',example:'report.txt'}],
    steps:[{goal:'Save',action:{kind:'click',target:{kind:'role',role:'Button',name:'Save'},
      postcondition:{kind:'desktop_file',path:'other.txt',contentEquals:'hello'}},
      preferredMethods:[],successCondition:{kind:'state_changed'}}],
    successConditions:{windowTitleIncludes:'{{filename}}'}};
  const fileRequest={id:fileWorkflow.id,version:1,definitionHash:workflowDigest(fileWorkflow),
    values:{filename:'report.txt'},destination:'windows' as const};
  assert.throws(()=>prepareWorkflowExecution(fileWorkflow,fileRequest),/original_file_name_not_covered/);
  const complete={...fileWorkflow,steps:[{...fileWorkflow.steps[0],action:{
    ...fileWorkflow.steps[0].action,postcondition:{kind:'desktop_file' as const,path:'{{filename}}',
      contentEquals:'hello'}}}]};
  assert.equal(prepareWorkflowExecution(complete,{...fileRequest,definitionHash:workflowDigest(complete)})
    .ref.requiredFiles?.[0]?.path,'report.txt');
});

test('指定流程前置条件不符时持续拒绝动作，不调用自由探索', async () => {
  let calls = 0;
  const replay = new WorkflowReplayModel({ ...definition, preconditions: [{ kind: 'window_title', value: 'Expected' }] },
    { async decide() { calls++; return { kind: 'keypress', keys: 'unsafe' }; } }, undefined, undefined, undefined, true);
  for (let i = 0; i < 2; i++) await assert.rejects(() => replay.decide({ ...initialState('t', 'test'), observation: { windowTitle: 'Other' } }), /未转入自由探索/);
  assert.equal(calls, 0);
});

test('唯一结构化窗口的指定流程直接回放，不调用规划或截图模型', async () => {
  const dir=mkdtempSync(join(tmpdir(),'fixed-no-model-'));
  mkdirSync(join(dir,'config'));writeFileSync(join(dir,'config/agent-desktop-apps.json'),'[]');
  const store=new WorkflowStore(join(dir,'workflows.sqlite'));
  const workflow:Workflow={...definition,id:'fixed-structured',
    preconditions:[{kind:'window_title',value:'Fixture - Notepad'}]};
  store.addCandidate({...workflow,status:'candidate'});
  store.recordReplay(workflow.id,1,'seed',true);
  const saved=store.get(workflow.id,1)!;
  let page='start',dispatched=0,planned=0,ocr=0,attached:number|undefined;
  const model={async planTask(){planned++;throw Error('planner must not run');},
    async decide(){throw Error('explore must not run');},
    async transcribeScreenshot(){ocr++;throw Error('OCR must not run');},
    async locateVisualTarget(){throw Error('vision grounding must not run');},takeVisualUsage(){}} as PlanningModel;
  const worker={async listWindows(){return [{handle:77,title:'Fixture - Notepad',windowClass:'Notepad',
      visible:true,minimized:false,foreground:true,processId:1,processPath:null,targetElevated:false,
      rect:{left:0,top:0,width:100,height:100}}];},
    async attach(options){attached=options.windowHandle;},async recoverFocus(){},async restore(){},
    async ensureApp(){throw Error('unexpected launch');},
    async observe(){return {pageText:page,accessibility:page,windowTitle:'Fixture - Notepad',windowHandle:77,
      screenshot:'fixture.png'};},
    async probe(){return {windowClass:'Notepad',processId:1,processPath:null,
      permissionsCompatible:true,elevated:false,targetElevated:false,visible:true,minimized:false,
      rect:{left:0,top:0,width:100,height:100},foreground:true,uiaControls:true,
      title:'Fixture - Notepad'};},
    async ground(action){return {action,attempts:[]};},
    async resolveAction(){return singleProvider('fixture','test');},
    async execute(){dispatched++;page='A';return {ok:true,message:'changed',effect:'dispatched'};},
    async close(){}} as WorkerClient;
  const controller=new DesktopTaskController(dir,{modelProvider:{createModel:()=>model},
    desktopSessions: fixtureDesktopSessions(async()=>worker)});
  controller.setDesktopControl({assertTaskAllowed(){},workerEndpoint:()=> 'fixture',
    async beginTask(){},async finishTask(){return false;}});
  const trace=new SqliteTrace(join(dir,'web-tasks.sqlite'));
  try {
    const id=controller.submitWorkflow({id:workflow.id,version:1,definitionHash:workflowDigest(saved),
      values:{value:'A'},destination:'windows'}, undefined, fixtureDesktopTarget);
    const deadline=Date.now()+10000;
    while(!['done','failed'].includes(trace.load(id)?.status??'')&&Date.now()<deadline)
      await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(trace.load(id)?.status,'done');
    assert.equal(attached,77);assert.equal(dispatched,1);
    assert.equal(planned,0);assert.equal(ocr,0);
  } finally {await controller.close();trace.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('指定流程窗口身份必须唯一，视觉目标仍保留截图模型路径',()=>{
  const window={handle:1,title:'Fixture - Notepad',windowClass:'Notepad',visible:true,
    minimized:false,foreground:true,processId:1,processPath:null,targetElevated:false,
    rect:{left:0,top:0,width:100,height:100}};
  const workflow={...definition,preconditions:[{kind:'window_title' as const,value:window.title}]};
  assert.equal(explicitWorkflowWindow(workflow,[window])?.handle,1);
  assert.throws(()=>explicitWorkflowWindow(workflow,[window,{...window,handle:2}]),/必须唯一/);
  assert.throws(()=>explicitWorkflowWindow(workflow,[{...window,minimized:true}]),/必须唯一/);
  assert.equal(explicitWorkflowUsesStructuredTargets(workflow),true);
  assert.equal(explicitWorkflowUsesStructuredTargets({...workflow,steps:[{...workflow.steps[0],
    action:{kind:'click',target:{kind:'vision',description:'Save button'}}}]}),false);
});

test('Workflow 已存 URL 成功条件在动作派发前绑定为影子后置条件',async()=>{
  const workflow:Workflow={...definition,environment:'browser',steps:[{goal:'打开结果',
    action:{kind:'click',target:{kind:'role',role:'link',name:'结果'}},preferredMethods:[],
    successCondition:{kind:'url_includes',value:'/result'}}]};
  const replay=new WorkflowReplayModel(workflow,{async decide(){throw Error('unexpected explore');}});
  const action=await replay.decide({...initialState('t','打开结果'),observation:{url:'https://example.test/start'}});
  assert.equal(action.kind,'click');
  if(action.kind==='click')assert.deepEqual(action.postcondition,{kind:'url_includes',value:'/result'});
  assert.equal(workflow.steps[0].action.kind,'click');
  if(workflow.steps[0].action.kind==='click')assert.equal(workflow.steps[0].action.postcondition,undefined);
});

for (const trial of [false, true]) for (const restart of [false, true]) test(`${trial ? '候选试运行' : '指定版本执行'}固定参数与验收条件，新增版本不影响${restart ? '同一绑定恢复' : '首次执行'}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fixed-workflow-'));
  mkdirSync(join(dir, 'config')); writeFileSync(join(dir, 'config/agent-desktop-apps.json'), '[]');
  const store = new WorkflowStore(join(dir, 'workflows.sqlite'));
  store.addCandidate({ ...definition, status: 'candidate' }); if (!trial) store.recordReplay('fixed', 1, 'seed', true);
  let page = 'start', planned = 0, begun = 0;
  const actions: string[] = [];
  const model = {
    async planTask(goal: string) { planned++; return { task: { environment: 'windows', windowHandle: 1,
      plan: ['wrong-plan'], completionCriteria: { pageTextIncludes: 'wrong-result' },
      verificationContract:{goal,successConditions:{pageTextIncludes:'wrong-result'},
        evidenceSources:{pageTextIncludes:'uia'},verifierStrategy:'rules_then_jev'} } }; },
    async decide() { throw new Error('free exploration must not run'); },
    async transcribeScreenshot() { return { text: page }; },
    async locateVisualTarget() { throw new Error('unexpected'); }, takeVisualUsage() {},
  } as PlanningModel;
  const worker = { async listWindows() { return []; }, async attach() {}, async recoverFocus() {}, async restore() {},
    async ensureApp() { throw new Error('unexpected launch'); },
    async observe() { return { pageText: page, accessibility: page, windowTitle: 'fixture', windowHandle: 1 }; },
    async probe() { return { windowClass: 'Fixture', processId: 1, processPath: null, permissionsCompatible: true,
      elevated: false, targetElevated: false, visible: true, minimized: false, rect: { left: 0, top: 0, width: 100, height: 100 },
      foreground: true, uiaControls: true, title: 'fixture' }; },
    async ground(action) { return { action, attempts: [] }; },
    async resolveAction() { return singleProvider('fixture', 'test'); },
    async execute(action) { assert.equal(action.kind, 'keypress'); if (action.kind === 'keypress') actions.push(action.keys);
      page = 'A'; return { ok: true, message: 'changed', effect: 'dispatched' }; }, async close() {},
  } as WorkerClient;
  let pauseOnce = restart;
  const options = { modelProvider: { createModel: () => model }, desktopSessions: fixtureDesktopSessions(async () => worker),
    traceStore: (path: string) => { const log = new SqliteTrace(path); const save = log.save.bind(log);
      log.save = (node, state) => { save(node, state);
        if (pauseOnce && node === 'verify') { pauseOnce = false; log.requestPause(state.taskId); }
      }; return log;
    } };
  const control = { assertTaskAllowed() {}, workerEndpoint: () => 'fixture',
    async beginTask() { begun++; }, async finishTask() { return false; } };
  options.desktopSessions = fixtureDesktopSessions(async () => worker, control);
  const controller = new DesktopTaskController(dir, options);
  controller.setDesktopControl(control);
  const trace = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
  try {
    const id = controller.submitWorkflow({ ...request, ...(trial ? { trial: true } : {}) }, undefined, fixtureDesktopTarget);
    store.addCandidate({ ...definition, status: 'candidate', steps: [{ ...definition.steps[0], action: { kind: 'keypress', keys: 'wrong-version' } }] });
    store.recordReplay('fixed', 2, 'seed-2', true);
    const end = Date.now() + 10000;
    while (!['done', 'failed', 'waiting_user', 'paused'].includes(trace.load(id)?.status ?? '') && Date.now() < end) await new Promise(r => setTimeout(r, 20));
    if (restart) {
      assert.equal(trace.load(id)?.status, 'paused');
      if (trial) assert.equal(store.get('fixed', 1)?.status, 'candidate', '暂停不能晋级');
      recoverDesktopTasks(dir);
      // The same execution Session is retained across checkpoint recovery.
      controller.continue(id);
      const deadline = Date.now() + 10000;
      while (trace.load(id)?.status !== 'done' && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    }
    const state = trace.load(id)!;
    assert.equal(state.status, 'done', JSON.stringify(state));
    assert.deepEqual(actions, ['a']); assert.equal(planned, 1); assert.equal(begun, restart ? 2 : 1);
    assert.deepEqual(state.workflowRef, { id: 'fixed', version: 1, values: { value: 'A' }, definitionHash: request.definitionHash, explicit: true, ...(trial ? { trial: true } : {}) });
    assert.deepEqual(state.completionCriteria, { pageTextIncludes: 'A' });
    assert.equal(state.verificationContract, undefined, '窗口选择规划不能冒充固定 Workflow 的验收契约');
    assert.equal(store.get('fixed', 1)?.successCount, trial ? 1 : 2);
    assert.equal(store.get('fixed', 1)?.status, trial ? 'candidate' : 'verified');
    store.recordReplay('fixed', 1, id, true, undefined, request.definitionHash, trial ? 'record_only' : 'automatic');
    assert.equal(store.get('fixed', 1)?.successCount, trial ? 1 : 2, '重复收尾不能重复累计');
    if (trial) {
      assert.throws(() => store.publish('fixed', 1, 'stale', 1, 0), /已变化/);
      assert.throws(() => store.publish('fixed', 1, request.definitionHash, 0, 0), /已变化/);
      assert.equal(store.publish('fixed', 1, request.definitionHash, 1, 0).status, 'verified');
      assert.throws(() => store.publish('fixed', 1, request.definitionHash, 1, 0), /只有候选版本/);
    }
  } finally { await controller.close(); trace.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('候选试运行不放开阶段流程，人工完成或未回放完不能晋级', () => {
  const candidate = { ...definition, status: 'candidate' as const };
  assert.equal(prepareWorkflowExecution(candidate, { ...request, trial: true }).ref.trial, true);
  assert.throws(() => prepareWorkflowExecution({ ...candidate, scope: 'stage' }, { ...request, trial: true }));
  const flow = prepareWorkflowExecution(candidate, { ...request, trial: true }).workflow;
  const state = { ...initialState('t', 'test'), status: 'done' as const, goalVerification: { ok: true, message: '人工确认' } };
  assert.equal(explicitReplaySucceeded(state, flow), false);
  assert.equal(explicitReplaySucceeded({ ...state, observation: { pageText: 'A' }, workflowReplayState: { nextIndex: 0, exploring: false } }, flow), false);
  assert.equal(explicitReplaySucceeded({ ...state, observation: { pageText: 'wrong' }, workflowReplayState: { nextIndex: 1, exploring: false } }, flow), false);
});

test('失败保持候选，过期定义不晋级，重复失败不重复计数', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trial-result-'));
  const store = new WorkflowStore(join(dir, 'workflows.sqlite'));
  try {
    store.addCandidate({ ...definition, status: 'candidate' });
    store.recordReplay('fixed', 1, 'failed-trial', false, '语义条件未满足', request.definitionHash);
    store.recordReplay('fixed', 1, 'failed-trial', false, '语义条件未满足', request.definitionHash);
    assert.equal(store.get('fixed', 1)?.status, 'candidate');
    assert.equal(store.get('fixed', 1)?.failureCount, 1);
    assert.throws(() => store.recordReplay('fixed', 1, 'stale-trial', true, undefined, 'outdated'), /定义已改变/);
    assert.equal(store.get('fixed', 1)?.status, 'candidate');
    assert.equal(store.get('fixed', 1)?.successCount, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
