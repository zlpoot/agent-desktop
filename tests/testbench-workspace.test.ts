import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TestBenchWorkspace, NativeTestBenchBackend, testBenchActionAllowed, validateTestBenchWorkspace,
  type TestBenchBackend, type BenchCapture } from '../src/desktop-provider/testbench-workspace.js';
import { ResourceInputControl } from '../src/desktop-provider/resource-input-control.js';
import { SqliteEnvironmentAppStore } from '../src/environment-apps/sqlite-registry.js';
import { composeEnvironmentApps } from '../src/composition/environment-apps.js';
import { TaskDesktopSessions } from '../src/app/task-desktop-sessions.js';
import { DesktopTaskController } from '../src/app/task-runner.js';
import { SqliteTrace } from '../src/trace/sqlite-trace.js';
import { WorkflowStore } from '../src/workflows/store.js';
import { loadDesktopEnvironmentConfig } from '../src/composition/desktop-environment-config.js';
import { createRootAssembly } from '../src/composition/root.js';
import { createDashboardServer } from '../src/app/server.js';
import type { ComputerAction } from '../src/actions/schema.js';
import type { ComputerState } from '../src/graph/state.js';
import type { PlanningModel } from '../src/contracts/model-provider.js';
import type { TaskAppRequest } from '../src/app/task-app-onboarding.js';

const config = { path: 'C:\\Synthetic\\WindowsAgentTestBench.exe', sha256: 'a'.repeat(64) };
const goal = '使用 WindowsAgentTestBench 查询张三客户，看到客户编号 C1003';
const finalText = '查到 1 位客户：张三（C1003）';
const click = (name: string): ComputerAction => ({ kind: 'click', target: { kind: 'role', role: 'button', name } });
async function fixture(options: { lie?: boolean; substitute?: boolean; delayedQuery?: boolean; cleanupFail?: boolean; initFail?: boolean; initBarrier?: Promise<void> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'r0-bench-synthetic-'));
  const path = join(dir, 'environment-apps.sqlite'), store = new SqliteEnvironmentAppStore(path);
  const calls: string[] = [], effects: ComputerAction[] = [];
  let beforeExecute: (() => Promise<void>) | undefined;
  let context: any, profile: any, original: any, authority: any, epoch = 0, view = 'home', query = '', result = '';
  let snapshot: BenchCapture | undefined, replaced = false, closed = false, sequence = 0, launches = 0;
  const current = () => { if (replaced || closed) throw new Error('synthetic-original-instance-replaced'); };
  let queryPending = 0;
  const capture = (): BenchCapture => {
    current();
    if (queryPending && --queryPending === 0) result = query === '张三' ? finalText : '没有匹配的客户';
    const items: BenchCapture['items'] = [{ role: 'button', name: '客户管理', identity: 'nav', complete: true }];
    if (view === 'customers') items.push({ role: 'edit', name: '客户姓名', value: query, identity: 'query', complete: true },
      { role: 'button', name: '查询客户', identity: 'query-button', complete: true },
      { role: 'text', name: result, identity: 'result', complete: true });
    snapshot = { hwnd: 42, pid: 7, incarnation: context.instanceId + ':original-window', windowClass: 'HwndWrapper[Synthetic]',
      observation: 'obs-' + ++sequence, sequence, elevated: false, targetElevated: false, permissionsCompatible: true, title: 'Windows Agent TestBench', rect: { left: 0, top: 0, width: 900, height: 600 },
      text: view + '\n' + result, items, startedAt: sequence, finishedAt: sequence };
    return structuredClone(snapshot);
  };
  const trusted = () => {
    const db = new DatabaseSync(path);
    try {
      db.exec('BEGIN IMMEDIATE');
      const row = db.prepare('SELECT data_json FROM environment_apps WHERE app_binding_id=?').get(profile.appBindingId) as { data_json: string };
      const app = JSON.parse(row.data_json);
      if (app.validity !== 'current' || app.trust !== 'verified' || app.profileDigest !== profile.profileDigest ||
          db.prepare('SELECT 1 FROM private_app_denials WHERE app_binding_id=?').get(app.appBindingId)) throw new Error('synthetic-native-trust-rejected');
    } finally { db.close(); }
  };
  const backend: TestBenchBackend = { async call<T>(method: string, args: any = {}): Promise<T> {
    calls.push(method);
    let value: unknown;
    if (method === 'init') { await options.initBarrier; if (options.initFail) throw new Error('synthetic-init-rejected'); closed = false; epoch = 0; original = undefined; view = 'home'; query = result = ''; snapshot = undefined; authority = undefined; launches++; context = { scope: args.scope, sessionId: args.sessionId, instanceId: 'synthetic-instance-' + launches,
      windowsSessionId: 1, desktop: 'AgentD0_Bench_synthetic' }; value = context; }
    else if (method === 'close') { closed = true; authority = undefined; }
    else {
      current();
      if (method === 'current') value = context;
      else if (method === 'start') { original = { ...context, targetToken: 'original-token-' + launches,
        identity: args.profile.identity }; value = original.targetToken; }
      else if (method === 'instances') value = original ? [{ ...original, executable: config.path, args: ['--task-channel'],
        processOwnedByInstallation: true, windowOwnedByProcess: true, sameUser: true, permissionsCompatible: true }] : [];
      else if (method === 'bind') {
        assert.deepEqual(args.target, original);
        profile = args.profile;
        if (options.substitute) { replaced = true; current(); }
      } else if (method === 'activate') { assert.ok(!authority && args.authority.epoch > epoch); authority = args.authority; epoch = authority.epoch; }
      else if (method === 'revoke') { assert.deepEqual(args.authority, authority); authority = undefined; epoch++; }
      else if (method === 'ping') assert.deepEqual(args.authority, authority);
      else if (method === 'observe') value = capture();
      else if (method === 'execute') {
        await beforeExecute?.(); // Simulate async transport; trust check belongs AFTER this await.
        current(); trusted(); assert.deepEqual(args.authority, authority);
        assert.equal(args.observation, snapshot!.observation); snapshot = undefined;
        assert.ok(testBenchActionAllowed(args.action)); effects.push(args.action);
        if (!options.lie) {
          if (args.action.kind === 'type') query = args.action.text;
          else if (args.action.target.name === '客户管理') view = 'customers';
          else if (args.action.target.name === '查询客户') {
            if (options.delayedQuery) { result = '正在查询…'; queryPending = 3; }
            else result = query === '张三' ? finalText : '没有匹配的客户';
          }
        }
        value = { ok: true, effect: 'dispatched', provider: 'testbench.owned-peer', message: 'synthetic producer ACK' };
      } else throw new Error('unexpected fake native method ' + method);
    }
    return value as T;
  }, close: async () => { calls.push('close'); closed = true; authority = undefined; if (options.cleanupFail) throw new Error('synthetic-cleanup-nack'); } };
  const bench = new TestBenchWorkspace(config, new ResourceInputControl(() => performance.now(), 60000), path, dir, () => backend, async () => config.sha256, true);
  const apps = composeEnvironmentApps(store, [{ scope: bench.scope, discovery: bench.discovery, launchBackend: bench.launchBackend }]);
  bench.bindService(apps.forEnvironment(bench.scope));
  const sessions = new TaskDesktopSessions([bench], new Map([[bench.id, bench]]));
  const model: PlanningModel = {
    name: 'ReactiveFakeModel (synthetic)', kind: 'model',
    async decide(state: Readonly<ComputerState>) {
      const observation = state.observation!;
      // Decisions depend on actual fresh evidence, never an action array/index.
      if (observation.pageText?.includes('正在查询')) return { kind: 'wait', ms: 20 };
      if (observation.pageText?.includes(finalText)) return { kind: 'done', summary: 'synthetic query independently visible' };
      const edit = observation.structured?.items.find(item => item.name === '客户姓名');
      if (!edit) return click('客户管理');
      if (edit.value !== '张三') return { kind: 'type', target: { kind: 'role', role: 'edit', name: '客户姓名' }, text: '张三' };
      return click('查询客户');
    },
    planTask: async () => ({ task: { environment: 'windows', plan: ['query customer'], completionCriteria: { pageTextIncludes: finalText }, verificationContract: { goal, successConditions: { pageTextIncludes: finalText }, evidenceSources: { pageTextIncludes: 'uia' }, verifierStrategy: 'rules_then_jev' } } }),
    planStage: async () => ({ goal, successCondition: finalText, isFinal: true,
      verification: { requirements: [{ id: 'stage-result', field: 'pageText', source: 'uia' }] } }),
    verifyStage: async (_stage, observation) => ({ ok: observation.pageText?.includes(finalText) === true,
      confidence: 1, evidence: observation.pageText ?? '', source: 'uia' }),
    transcribeScreenshot: async () => { throw new Error('no visual model authorized'); },
    locateVisualTarget: async () => { throw new Error('no visual model authorized'); },
    takeVisualUsage: () => undefined,
  };
  const controller = new DesktopTaskController(dir, { desktopSessions: sessions, environmentApps: apps, modelProvider: { createModel: () => model } });
  const trace = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
  const wait = async (id: string, predicate: (state: ComputerState) => boolean) => {
    for (let i = 0; i < 500; i++) { const state = trace.load(id); if (state && predicate(state)) return state; await new Promise(done => setTimeout(done, 10)); }
    throw new Error('synthetic timeout ' + JSON.stringify(trace.load(id)));
  };
  const confirm = async (id: string) => {
    const waiting = await wait(id, state => state.appOnboarding?.state === 'candidates');
    const app = waiting.appOnboarding!, candidate = app.candidates[0];
    const request: TaskAppRequest = { desktopTarget: { providerId: bench.id, environmentId: bench.scope.environmentId }, interactionId: app.interactionId, action: 'confirm',
      candidateId: candidate.candidateId, candidateRevision: candidate.candidateRevision };
    return controller.onboardApp(id, request);
  };
  return { dir, bench, apps, store, controller, trace, effects, calls, confirm, wait,
    beforeExecute: (hook: () => Promise<void>) => { beforeExecute = hook; },
    close: async () => { const errors: unknown[] = [];
      for (const cleanup of [() => controller.close(), () => sessions.close(), () => apps.close()]) try { await cleanup(); } catch (error) { errors.push(error); }
      trace.close(); store.close(); rmSync(dir, { recursive: true, force: true });
      if (errors.length) throw new AggregateError(errors, 'synthetic cleanup rejected'); } };
}
test('explicit TestBench config does not widen existing Local Workspace or arbitrary executable routes', () => {
  assert.deepEqual(validateTestBenchWorkspace(config), config);
  for (const value of [{ ...config, path: 'C:\\evil.exe' }, { ...config, sha256: '' }, { ...config, args: ['shell'] }])
    assert.throws(() => validateTestBenchWorkspace(value), /invalid-testbench/);
  const dir = mkdtempSync(join(tmpdir(), 'r0-config-'));
  try {
    const path = join(dir, 'config.json'); writeFileSync(path, JSON.stringify({ testBenchWorkspace: config }));
    assert.deepEqual(loadDesktopEnvironmentConfig(path).testBenchWorkspace, config);
    writeFileSync(path, JSON.stringify({ testBenchWorkspace: config, localWorkspace: { app: 'fixture' } }));
    assert.throws(() => loadDesktopEnvironmentConfig(path), /conflicting/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.ok(testBenchActionAllowed(click('查询订单')));
  assert.ok(testBenchActionAllowed({ kind: 'type', target: { kind: 'role', role: 'edit', name: '订单客户姓名' }, text: '张三' }));
  for (const action of [{ kind: 'keypress', keys: 'ENTER' }, { kind: 'click', target: { kind: 'coordinate', x: 1, y: 2 } },
    click('保存客户资料'), click('提交订单审核'), click('选择附件')]) assert.equal(testBenchActionAllowed(action as ComputerAction), false);
});
test('normal Dashboard API → P7 confirmation → original Session → reactive Agent Loop → independent verification → stored Trace/candidate', async () => {
  const f = await fixture(), server = createDashboardServer(f.dir, f.controller);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address() as { port: number }, base = 'http://127.0.0.1:' + address.port;
    const response = await fetch(base + '/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal, desktopTarget: { providerId: f.bench.id, environmentId: f.bench.scope.environmentId },
        budget: { deepseek: { maxCalls: 7, maxTokens: 5000 } } }) });
    assert.equal(response.status, 202);
    const value = await response.json() as { taskId: string };
    const waiting = await f.wait(value.taskId, state => state.appOnboarding?.state === 'candidates');
    assert.equal(waiting.status, 'waiting_user'); assert.equal(f.effects.length, 0); assert.equal(f.calls.includes('activate'), false);
    await f.confirm(value.taskId);
    const final = await f.wait(value.taskId, state => ['done', 'failed', 'waiting_user'].includes(state.status) && !!state.observation);
    assert.equal(final.status, 'done', JSON.stringify(final)); assert.equal(final.goalVerification?.ok, true);
    assert.equal(f.effects.length, 3);
    assert.ok(f.trace.events(value.taskId).some(event => event.node === 'decide'));
    assert.ok(f.trace.events(value.taskId).some(event => event.node === 'workflow_stage_candidate'));
    const workflows = new WorkflowStore(join(f.dir, 'workflows.sqlite'));
    try { const candidates = workflows.list('windows'); assert.ok(candidates.length); assert.ok(candidates.every(candidate => candidate.status === 'candidate')); }
    finally { workflows.close(); }
    const reread = new SqliteTrace(join(f.dir, 'web-tasks.sqlite'));
    try { assert.equal(reread.load(value.taskId)!.status, 'done'); assert.equal(reread.load(value.taskId)!.desktopExecutionBinding!.instanceId, 'synthetic-instance-1'); }
    finally { reread.close(); }
    assert.equal(f.calls.filter(call => call === 'start').length, 1);
    assert.ok(f.calls.includes('revoke'));
  } finally { await new Promise<void>(done => server.close(() => done())); await f.close(); }
});
test('original target substitution rejects before Agent input/model dispatch and no generic fallback', async () => {
  const f = await fixture({ substitute: true });
  try { const id = f.controller.submit(goal, { desktopTarget: { providerId: f.bench.id, environmentId: f.bench.scope.environmentId } }); await f.confirm(id);
    const final = await f.wait(id, state => state.status === 'failed'); assert.match(final.error!, /original-instance-replaced/);
    assert.equal(f.effects.length, 0); assert.equal(f.calls.includes('activate'), false); }
  finally { await f.close(); }
});
test('revoke during asynchronous transport rejects at producer fence; no effect or candidate', async () => {
  const f = await fixture();
  try {
    let revoked = false;
    f.beforeExecute(async () => {
      if (revoked) return; revoked = true;
      const registry = f.apps.forEnvironment(f.bench.scope).registry, app = registry.list()[0];
      registry.revoke(app.appBindingId, app.revision, 'synthetic revoke before producer commit');
    });
    const id = f.controller.submit(goal, { desktopTarget: { providerId: f.bench.id, environmentId: f.bench.scope.environmentId } }); await f.confirm(id);
    await f.wait(id, state => ['failed', 'paused', 'waiting_user'].includes(state.status) && !!state.observation);
    assert.equal(revoked, true); assert.equal(f.effects.length, 0);
    assert.equal(f.trace.events(id).some(event => event.node === 'workflow_stage_candidate'), false);
  } finally { await f.close(); }
});
test('producer ACK without changed independent observation cannot finish or learn a Workflow', async () => {
  const f = await fixture({ lie: true });
  try { const id = f.controller.submit(goal, { desktopTarget: { providerId: f.bench.id, environmentId: f.bench.scope.environmentId } }); await f.confirm(id);
    const final = await f.wait(id, state => ['failed', 'waiting_user', 'paused'].includes(state.status) && !!state.observation);
    assert.notEqual(final.goalVerification?.ok, true); assert.ok(f.effects.length);
    assert.equal(f.trace.events(id).some(event => event.node === 'workflow_stage_candidate'), false);
  } finally { await f.close(); }
});

test('a second Task reuses the learned stage Workflow through the existing Replay model', async () => {
  const f = await fixture();
  try {
    const target = { providerId: f.bench.id, environmentId: f.bench.scope.environmentId };
    const first = f.controller.submit(goal, { desktopTarget: target }); await f.confirm(first);
    await f.wait(first, state => state.status === 'done');
    const second = f.controller.submit(goal, { desktopTarget: target });
    const final = await f.wait(second, state => state.status === 'done' || state.status === 'failed');
    assert.equal(final.status, 'done', JSON.stringify(final));
    assert.ok(f.trace.events(second).some(event => event.node === 'app_profile_reused'));
    assert.ok(f.trace.events(second).some(event => event.node === 'workflow_stage_replay' && event.state.summary?.includes('回放验证成功')));
    assert.equal(final.goalVerification?.ok, true);
    assert.equal(f.effects.length, 6);
  } finally { await f.close(); }
});

test('asynchronous query can wait with no input provider and then verify fresh evidence', async () => {
  const f = await fixture({ delayedQuery: true });
  try {
    const id = f.controller.submit(goal, { desktopTarget: { providerId: f.bench.id, environmentId: f.bench.scope.environmentId } });
    await f.confirm(id);
    const final = await f.wait(id, state => state.status === 'done' || state.status === 'failed');
    assert.equal(final.status, 'done', JSON.stringify(final)); assert.equal(f.effects.length, 3);
    assert.ok(f.trace.events(id).some(event => event.node === 'execute' && event.state.lastResult?.provider === 'testbench.wait'));
    assert.equal(f.calls.filter(call => call === 'execute').length, 3);
  } finally { await f.close(); }
});

test('an unnamed generic task cannot claim input; its empty owned Session is released', async () => {
  const f = await fixture();
  try {
    const session = await f.bench.open(f.bench.scope.environmentId), control = f.bench.taskControl(session);
    await assert.rejects(control.beginTask('synthetic-bare-task'), /bridge-required/);
    assert.equal(f.calls.includes('activate'), false); assert.ok(f.calls.includes('close'));
    assert.throws(() => f.bench.connectRuntime(), /p7-original-target-required/);
    assert.equal((await session.status()).state, 'closed');
  } finally { await f.close(); }
});
test('cleanup NACK blocks new Sessions rather than opening a replacement resource', async () => {
  const f = await fixture({ cleanupFail: true });
  try {
    const session = await f.bench.open(f.bench.scope.environmentId);
    await assert.rejects(session.close(), /cleanup-nack/);
    await assert.rejects(f.bench.open(f.bench.scope.environmentId), /workspace-unavailable/);
  } finally { await assert.rejects(f.close(), /synthetic cleanup rejected/); }
});

test('normal Root composition wires the same bounded provider/P7/executor without opening a Desktop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r0-bench-root-'));
  const assembly = await createRootAssembly({ rootDir: dir, testBenchWorkspace: config,
    model: { createModel() { throw new Error('model calls forbidden during composition'); } } });
  try {
    const bench = assembly.environmentProviders.find(provider => provider instanceof TestBenchWorkspace) as TestBenchWorkspace;
    assert.ok(bench);
    const service = assembly.environmentApps.forEnvironment(bench.scope);
    assert.ok(service.onboarding); assert.equal(service.discovery, bench.discovery);
    const options = await assembly.controller.desktopOptions();
    if (process.platform === 'win32') assert.ok(options.some(option => option.environmentId === bench.scope.environmentId && option.executable));
    assert.throws(() => bench.connectRuntime(), /p7-original-target-required/);
  } finally { await assembly.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test('close drains the original pending open even after a concurrent open is refused', async () => {
  let release!: () => void;
  const barrier = new Promise<void>(done => { release = done; });
  const f = await fixture({ initBarrier: barrier });
  try {
    const opening = f.bench.open(f.bench.scope.environmentId);
    await assert.rejects(f.bench.open(f.bench.scope.environmentId), /resource-busy/);
    let drained = false;
    const closing = f.bench.close().then(() => { drained = true; });
    await new Promise(done => setTimeout(done, 5)); assert.equal(drained, false);
    release(); await assert.rejects(opening, /handshake-unconfirmed/); await closing;
    assert.equal(drained, true); assert.ok(f.calls.includes('close'));
  } finally { release(); await f.close(); }
});

test('native transport EOF never acknowledges owned Job/Desktop cleanup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r0-bench-transport-'));
  mkdirSync(join(dir, 'src', 'desktop-provider'), { recursive: true });
  writeFileSync(join(dir, 'src', 'desktop-provider', 'testbench_worker.py'), 'import sys\nfor line in sys.stdin:\n    sys.exit(0)\n');
  const backend = new NativeTestBenchBackend(dir);
  try {
    await assert.rejects(backend.call('synthetic-no-input'), /transport-unconfirmed/);
    await assert.rejects(backend.close(), /native-cleanup-unconfirmed/);
    await assert.rejects(backend.close(), /native-cleanup-unconfirmed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('failed initialization with cleanup NACK blocks admission and remains visible during disposal', async () => {
  const f = await fixture({ initFail: true, cleanupFail: true });
  try {
    await assert.rejects(f.bench.open(f.bench.scope.environmentId), /open-cleanup-unconfirmed/);
    await assert.rejects(f.bench.open(f.bench.scope.environmentId), /workspace-unavailable/);
  } finally { await assert.rejects(f.close(), /synthetic cleanup rejected/); }
});
