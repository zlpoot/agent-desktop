import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import type { DesktopProvider, DesktopSession } from '../src/contracts/desktop-environment.js';
import type { WorkerClient } from '../src/contracts/worker-client.js';
import type { ModelProvider, PlanningModel } from '../src/contracts/model-provider.js';
import { desktopTarget, desktopExecutionBinding, taskDesktopFields } from '../src/contracts/task-desktop.js';
import { TaskDesktopSessions } from '../src/app/task-desktop-sessions.js';
import { DesktopTaskController } from '../src/app/task-runner.js';
import { SqliteTrace } from '../src/trace/sqlite-trace.js';
import { initialState } from '../src/graph/state.js';
import { createAgentLoop } from '../src/graph/graph.js';
import { FakeModel } from '../src/agent/model-adapter.js';
import { continuePausedTask } from '../src/graph/resume.js';
import { recoverDesktopTasks } from '../src/desktop-session/recovery.js';
import { createRootAssembly } from '../src/composition/root.js';
import { fixtureDesktopSessions, fixtureDesktopTarget } from './fixtures/task-desktop.js';

const target = desktopTarget('arbitrary-provider', 'environment-a');
const binding = desktopExecutionBinding({ ...target, sessionId: 'session-a', instanceId: 'backend-instance-a' });
const fields = { taskBindingVersion: 1 as const, desktopTarget: target, desktopExecutionBinding: binding };
function synthetic() {
  let state: 'open' | 'closed' | 'stale' = 'open';
  const calls: string[] = [];
  const session: DesktopSession = { ...binding, inputResourceId: 'resource',
    async capabilities() { return {}; }, async status() { return { state, readiness: {} }; },
    async close() { calls.push('close'); state = 'closed'; },
  };
  const provider: DesktopProvider = { id: target.providerId, kind: 'physical',
    async capabilities() { return {}; }, async discover() { calls.push('discover'); return [{ ...target, kind: 'physical' }]; },
    async open(id) { calls.push(`open:${id}`); return session; },
  };
  const executor = { taskControl: () => ({ workerEndpoint: () => 'unused', assertTaskAllowed() {},
    async beginTask() { calls.push('begin'); }, async finishTask() { calls.push('finish'); return false; } }),
    async connectRuntime() { calls.push('runtime'); return {} as unknown as WorkerClient; },
  };
  return { calls, session, provider, executor, stale: () => { state = 'stale'; },
    sessions: new TaskDesktopSessions([provider], new Map([[provider.id, executor]])) };
}
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'task-desktop-binding-'));
  mkdirSync(join(dir, 'config')); writeFileSync(join(dir, 'config/agent-desktop-apps.json'), '[]');
  return dir;
}
const haltedModel: ModelProvider = { createModel: () => ({ name: 'synthetic', kind: 'rule',
  async planTask() { throw new Error('PLAN_HALT'); },
} as unknown as PlanningModel) };

test('selection is immutable and rejects empty, whitespace and malformed identities', () => {
  assert.equal(Object.isFrozen(target), true); assert.equal(Object.isFrozen(binding), true);
  for (const value of ['', ' ', ' a', 'a ']) {
    assert.throws(() => desktopTarget(value, 'env'), /invalid-desktop-target/);
    assert.throws(() => desktopTarget('provider', value), /invalid-desktop-target/);
    assert.throws(() => desktopExecutionBinding({ ...binding, sessionId: value }), /invalid-desktop-binding/);
    assert.throws(() => desktopExecutionBinding({ ...binding, instanceId: value }), /invalid-desktop-binding/);
  }
});
test('unknown provider/environment and unsupported executor reject without opening a fallback', async () => {
  const f = synthetic();
  assert.throws(() => f.sessions.assertTarget(desktopTarget('missing', target.environmentId)), /unknown-desktop-provider/);
  const unavailable = new TaskDesktopSessions([f.provider], new Map());
  assert.throws(() => unavailable.assertTarget(target), /desktop-task-executor-unavailable/);
  await assert.rejects(f.sessions.acquire('t', { taskBindingVersion: 1,
    desktopTarget: desktopTarget(target.providerId, 'missing') }, () => assert.fail()), /unknown-desktop-environment/);
  assert.deepEqual(f.calls, ['discover']);
});
test('binding is persisted before input/runtime; same binding resumes without opening another Session', async () => {
  const f = synthetic();
  let persisted: typeof binding | undefined;
  const entry = await f.sessions.acquire('t', { taskBindingVersion: 1, desktopTarget: target }, value => {
    f.calls.push('persist'); persisted = value;
  });
  assert.deepEqual(persisted, binding);
  await entry.control.beginTask('t'); await entry.executor.connectRuntime(entry.session, 'unused');
  await f.sessions.acquire('t', fields, () => assert.fail('binding cannot be persisted twice'));
  assert.deepEqual(f.calls, ['discover', 'open:environment-a', 'persist', 'begin', 'runtime']);
  await f.sessions.close();
});
test('every binding dimension, stale Session and process loss reject without reopening', async () => {
  for (const key of ['providerId', 'environmentId', 'sessionId', 'instanceId'] as const) {
    const f = synthetic(); await f.sessions.acquire('t', { taskBindingVersion: 1, desktopTarget: target }, () => {});
    const changed = { ...binding, [key]: 'different' };
    await assert.rejects(f.sessions.acquire('t', { ...fields, desktopExecutionBinding: changed }, () => assert.fail()));
    assert.equal(f.calls.filter(c => c.startsWith('open:')).length, 1); await f.sessions.close();
  }
  const f = synthetic(); await f.sessions.acquire('t', { taskBindingVersion: 1, desktopTarget: target }, () => {});
  f.stale(); await assert.rejects(f.sessions.acquire('t', fields, () => assert.fail()), /stale-desktop-binding/);
  const restarted = new TaskDesktopSessions([f.provider], new Map([[f.provider.id, f.executor]]));
  await assert.rejects(restarted.acquire('t', fields, () => assert.fail()), /desktop-binding-unavailable/);
  assert.equal(f.calls.filter(c => c.startsWith('open:')).length, 1); await f.sessions.close();
});
test('wrong backend target, invalid instance and failed persistence close the opened Session', async () => {
  for (const mode of ['target', 'instance', 'persist']) {
    const f = synthetic();
    if (mode === 'target') Object.assign(f.session, { environmentId: 'wrong-environment' });
    if (mode === 'instance') Object.assign(f.session, { instanceId: '' });
    await assert.rejects(f.sessions.acquire('t', { taskBindingVersion: 1, desktopTarget: target }, () => {
      if (mode === 'persist') throw new Error('storage failure'); assert.fail('invalid identity cannot persist');
    }));
    assert.equal(f.calls.at(-1), 'close'); assert.ok(!f.calls.includes('begin'));
  }
});
test('close waits for a late open, closes it and refuses persistence or future selection', async () => {
  const f = synthetic();
  let started!: () => void, resolveOpen!: (session: DesktopSession) => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const opening = new Promise<DesktopSession>(resolve => { resolveOpen = resolve; });
  f.provider.open = async () => { started(); return opening; };
  const acquiring = f.sessions.acquire('t', { taskBindingVersion: 1, desktopTarget: target }, () => assert.fail());
  const rejection = assert.rejects(acquiring, /task-desktop-sessions-closed/);
  await entered;
  let closed = false;
  const closing = f.sessions.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  resolveOpen(f.session);
  await rejection; await closing;
  assert.equal(f.calls.at(-1), 'close');
  assert.throws(() => f.sessions.assertTarget(target), /closed/);
});
test('durable trace rejects binding overwrite/erasure, target changes and late browser selection', () => {
  const dir = directory(), trace = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
  try {
    const saved = { ...initialState('t', 'text says a different environment'), ...fields };
    trace.save('desktop_bound', saved);
    for (const key of ['providerId', 'environmentId', 'sessionId', 'instanceId'] as const) {
      assert.throws(() => trace.save('tamper', { ...saved,
        desktopExecutionBinding: { ...binding, [key]: 'wrong' } }));
    }
    assert.throws(() => trace.save('erase', { ...saved, desktopExecutionBinding: undefined }));
    assert.throws(() => trace.save('erase', { ...saved, desktopTarget: undefined }));
    trace.save('queued', { ...initialState('browser', 'VM: arbitrary text'), taskBindingVersion: 1 });
    assert.throws(() => trace.save('late_selection', { ...initialState('browser', 'text'),
      taskBindingVersion: 1, desktopTarget: target }), /immutable-task-desktopTarget/);
    assert.deepEqual(trace.load('t')?.desktopExecutionBinding, binding);
  } finally { trace.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('controller uses explicit target with ordinary goal, persists before control, and never uses VM text', async () => {
  const dir = directory(); let begin = 0, connected = 0;
  const trace = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
  const sessions = fixtureDesktopSessions(async () => { connected++; return {
    async listWindows() { return []; }, async close() {},
  } as unknown as WorkerClient; }, { workerEndpoint: () => 'unused', assertTaskAllowed() {},
    async beginTask(id) { begin++; assert.ok(trace.load(id)?.desktopExecutionBinding); }, async finishTask() { return false; } });
  const controller = new DesktopTaskController(dir, { modelProvider: haltedModel, desktopSessions: sessions });
  try {
    assert.throws(() => controller.submit('ordinary goal', { desktopTarget: null as unknown as typeof target }), /invalid-desktop-target/);
    const explicit = controller.submit('ordinary goal', { desktopTarget: fixtureDesktopTarget });
    const unselected = controller.submit('VM: does not select a desktop');
    // Close after the queued executions settle, without cancelling them.
    while (!trace.load(unselected)?.error) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(begin, 1); assert.equal(connected, 1);
    assert.deepEqual(trace.load(explicit)?.desktopTarget, fixtureDesktopTarget);
    assert.match(trace.load(explicit)?.error ?? '', /PLAN_HALT/);
    assert.equal(trace.load(unselected)?.desktopTarget, undefined);
    assert.match(trace.load(unselected)?.error ?? '', /PLAN_HALT/);
  } finally { await controller.close(); trace.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('an unselected Windows plan fails before app launch, native discovery or runtime connection', async () => {
  const dir = directory(); let calls = 0;
  const controller = new DesktopTaskController(dir, { desktopSessions: fixtureDesktopSessions(async () => {
    calls++; throw new Error('must not connect'); }), modelProvider: { createModel: () => ({
      name: 'synthetic', kind: 'rule', async planTask(_goal: string, windows: unknown[], apps: unknown[]) {
        assert.deepEqual(windows, []); assert.deepEqual(apps, []);
        return { task: { environment: 'windows', appId: 'anything', plan: [], completionCriteria: {} } };
      },
    } as unknown as PlanningModel) } });
  const trace = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
  try {
    const id = controller.submit('VM: still not an environment selector');
    while (!trace.load(id)?.error) await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(trace.load(id)?.error ?? '', /desktop-target-required/); assert.equal(calls, 0);
  } finally { await controller.close(); trace.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('specialized desktop requests cannot bypass binding and legacy executors are never guessed from goal', async () => {
  const dir = directory();
  const { ExtensionRegistry } = await import('../src/contracts/extension.js');
  const registry = new ExtensionRegistry(); let submitted = 0, resumed = 0;
  registry.register({ id: 'old', capabilities: [{ id: 'old.desktop', matches: () => true,
    prepare: goal => ({ kind: 'specialized', environment: 'windows', goal, plan: [], facts: {}, operations: [] }),
    submit: () => { submitted++; return 'old'; }, resume: () => { resumed++; },
  }] });
  const controller = new DesktopTaskController(dir, { registry, modelProvider: haltedModel });
  const trace = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
  try {
    assert.throws(() => controller.submit('VM: legacy specialized text'), /desktop-target-required/);
    trace.save('old', { ...initialState('old', 'same matching text'), status: 'waiting_user', executorId: 'old.desktop' });
    assert.throws(() => controller.resume('old', { approved: true }), /legacy-specialized-desktop-compatibility-unavailable/);
    assert.equal(submitted, 0); assert.equal(resumed, 0);
  } finally { await controller.close(); trace.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('explicit binding retains the app catalog gate before launch even for an injected planner', async () => {
  const dir = directory(); let launched = 0;
  const controller = new DesktopTaskController(dir, {
    desktopSessions: fixtureDesktopSessions(async () => ({ listWindows: async () => [], close: async () => {},
      ensureApp: async () => { launched++; return { handle: 1, title: 'wrong' }; },
    } as unknown as WorkerClient)),
    modelProvider: { createModel: () => ({ name: 'injected-planner', kind: 'rule', async planTask() {
      return { task: { environment: 'windows', appId: 'not-in-catalog', plan: [], completionCriteria: {} } };
    } } as unknown as PlanningModel) },
  });
  const trace = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
  try {
    const id = controller.submit('ordinary goal', { desktopTarget: fixtureDesktopTarget });
    while (!trace.load(id)?.error) await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(trace.load(id)?.error ?? '', /planned-app-not-in-catalog/); assert.equal(launched, 0);
  } finally { await controller.close(); trace.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('legacy desktop continuation requires explicit validated selection and persists provenance without guessing goal', async () => {
  const dir = directory(); const trace = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
  const db = new DatabaseSync(join(dir, 'web-task-routes.sqlite'));
  db.exec('CREATE TABLE generic_routes (task_id TEXT PRIMARY KEY, environment TEXT, window_handle INTEGER, created_at TEXT NOT NULL)');
  db.prepare('INSERT INTO generic_routes VALUES (?, ?, ?, ?)').run('old', 'agent_desktop', 1, 'historical');
  db.prepare('INSERT INTO generic_routes VALUES (?, ?, ?, ?)').run('ambiguous', null, null, 'historical');
  trace.save('paused', { ...initialState('old', 'ordinary historical goal'), status: 'waiting_user', desktopVmId: 'vm-a', setupPaused: true });
  trace.save('paused', { ...initialState('ambiguous', 'VM: text proves nothing'), status: 'paused' });
  const controller = new DesktopTaskController(dir, { modelProvider: haltedModel,
    desktopSessions: fixtureDesktopSessions(async () => ({ listWindows: async () => [], close: async () => {} } as unknown as WorkerClient)),
    legacyDesktopTarget: state => state.desktopVmId === 'vm-a',
  });
  try {
    assert.throws(() => controller.resume('old', { approved: true }), /legacy-desktop-target-required/);
    assert.throws(() => controller.continue('ambiguous'), /legacy-desktop-target-required/);
    assert.throws(() => controller.adoptLegacyDesktopTask('ambiguous', fixtureDesktopTarget), /ineligible/);
    controller.adoptLegacyDesktopTask('old', fixtureDesktopTarget);
    assert.equal(trace.load('old')?.status, 'paused');
    assert.equal(trace.load('old')?.recoveryRequired, true);
    assert.deepEqual(trace.load('old')?.desktopCompatibility, { source: 'legacy-route', environment: 'agent_desktop', desktopVmId: 'vm-a' });
    controller.continue('old');
    while (!trace.load('old')?.error) await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(trace.load('old')?.error ?? '', /PLAN_HALT/);
    assert.ok(trace.load('old')?.desktopExecutionBinding);
    assert.equal(trace.events('old').filter(e => e.node === 'desktop_compatibility_selected').length, 1);
  } finally { await controller.close(); db.close(); trace.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('startup recovery preserves exact binding, rejects missing Session and never parses goal text', async () => {
  const dir = directory(); const trace = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
  try {
    trace.save('running', { ...initialState('bound', 'ordinary goal'), ...fields });
    trace.save('running', { ...initialState('text-only', 'VM: no structured provenance'), taskBindingVersion: 1 });
    recoverDesktopTasks(dir);
    assert.equal(trace.load('bound')?.status, 'paused');
    assert.deepEqual(trace.load('bound')?.desktopExecutionBinding, binding);
    assert.equal(trace.load('text-only')?.status, 'running');
    const controller = new DesktopTaskController(dir, { modelProvider: haltedModel, desktopSessions: synthetic().sessions });
    assert.throws(() => controller.continue('bound'), /desktop-binding-unavailable/);
    await controller.close();
  } finally { trace.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('checkpoint channels preserve metadata, reject changes and reject foreign resume before observe/execute', async () => {
  const dir = directory(), trace = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
  const checkpoint = SqliteSaver.fromConnString(join(dir, 'checkpoint.sqlite'));
  let observed = 0;
  const graph = createAgentLoop({ trace, checkpointer: checkpoint, model: new FakeModel([]),
    pauseRequested: () => true,
    runtime: { async observe() { observed++; return { pageText: '' }; }, async execute() { assert.fail('no action'); } } });
  try {
    await graph.invoke({ ...initialState('t', 'goal'), ...fields }, { configurable: { thread_id: 't' } });
    assert.deepEqual((await graph.getState({ configurable: { thread_id: 't' } })).values.desktopExecutionBinding, binding);
    const beforeResume = observed;
    await assert.rejects(graph.updateState({ configurable: { thread_id: 't' } }, {
      desktopExecutionBinding: { ...binding, instanceId: 'replaced' },
    }), /immutable-task-desktopExecutionBinding/);
    await assert.rejects(continuePausedTask(graph, 't', 't', undefined, {
      ...fields, desktopExecutionBinding: { ...binding, sessionId: 'foreign' },
    }), /immutable-task-desktopExecutionBinding/);
    assert.equal(observed, beforeResume);
    assert.deepEqual(taskDesktopFields(trace.load('t')!), taskDesktopFields(fields));
  } finally { checkpoint.db.close(); trace.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('production composition refuses unconfigured Physical and unsupported Local Workspace generic Tasks', async () => {
  const dir = directory(), assembly = await createRootAssembly({ rootDir: dir, model: haltedModel });
  try {
    for (const id of ['physical', 'windows-local-workspace']) assert.throws(() => assembly.controller.submit('any goal', {
      desktopTarget: desktopTarget(id, 'anything'),
    }), id === 'physical' ? /physical-task-policy-required/ : /desktop-task-executor-unavailable/);
  } finally { await assembly.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
