import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { LocalWorkspaceDesktopProvider, type LocalWorkspaceAppConfig } from '../src/desktop-provider/local-workspace-provider.js';
import { LocalWorkspaceTaskExecutor } from '../src/desktop-provider/local-workspace-task-executor.js';
import { ResourceInputControl } from '../src/desktop-provider/resource-input-control.js';
import { DesktopExecutionAdmission } from '../src/desktop-provider/execution-admission.js';
import { desktopTarget, assertTaskDesktopUnchanged, validateTaskDesktop } from '../src/contracts/task-desktop.js';
import { createRootAssembly } from '../src/composition/root.js';
import { SqliteTrace } from '../src/trace/sqlite-trace.js';
import { readTaskBudget } from '../src/runtime/model-budget.js';
import { recoverDesktopTasks } from '../src/desktop-session/recovery.js';
import { ScenarioWorkspace } from './fixtures/local-workspace-scenario.js';

const fixtureId = 'd0-fixture-text-click-v1', musicId = 'd0-netease-fixed-track-v1';
const agent = { kind: 'agent', clientId: 'synthetic-task' } as const;
const music: LocalWorkspaceAppConfig = { app: 'netease', path: 'C:\\synthetic\\cloudmusic.exe', song: '我怀念的', artist: '孙燕姿' };
function remove(directory: string) {
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  rmSync(directory, { recursive: true, force: true });
}
function fixture(config: LocalWorkspaceAppConfig = { app: 'fixture' }, input = new ResourceInputControl()) {
  const directory = mkdtempSync(join(tmpdir(), 'p6-b-scenario-'));
  const backend = new ScenarioWorkspace();
  const provider = new LocalWorkspaceDesktopProvider(input, config, join(directory, 'artifacts'), process.cwd(), () => backend, true);
  const executor = new LocalWorkspaceTaskExecutor(provider);
  const selected = desktopTarget(provider.id, `local-workspace:${config.app}`);
  return { directory, backend, input, provider, executor, selected, id: config.app === 'fixture' ? fixtureId : musicId,
    async dispose() { try { await provider.close(); } catch {} remove(directory); } };
}
async function admitted(f: ReturnType<typeof fixture>) {
  const session = await f.provider.open(f.selected.environmentId);
  const backend = f.provider.scenarioBackend(session, f.directory);
  const gate = new DesktopExecutionAdmission(f.provider, session, f.input, backend);
  const target = await gate.bind(f.id);
  return { session, backend, gate, target };
}
test('production finite preflight does not read/acquire/renew authority; unknown action leaves input idle', async () => {
  const f = fixture();
  try {
    const s = await admitted(f), initial = f.input.view(s.session);
    const assertAuthority = f.input.assertAuthority, acquire = f.input.acquire, renew = f.input.renewAuthority;
    f.input.assertAuthority = () => assert.fail('preflight read authority');
    f.input.acquire = async () => assert.fail('preflight acquired input');
    f.input.renewAuthority = () => assert.fail('preflight renewed input');
    await assert.rejects(s.gate.preflight(s.target, 'drag'), /scenario-not-proven/);
    await s.gate.preflight(s.target, f.id);
    assert.deepEqual(f.input.view(s.session), initial);
    assert.equal(initial.state, 'idle'); assert.equal(f.backend.acts, 0);
    assert.ok(!f.backend.calls.includes('activate')); assert.ok(!f.backend.calls.includes('frame'));
    f.input.assertAuthority = assertAuthority; f.input.acquire = acquire; f.input.renewAuthority = renew;
    await s.backend.close();
  } finally { await f.dispose(); }
});
test('task control refuses begin before preparation and capability rejection occurs before acquire', async () => {
  const f = fixture();
  try {
    const session = await f.provider.open(f.selected.environmentId), control = f.executor.taskControl(session);
    await assert.rejects(control.beginTask('task'), /not-prepared/);
    const prepared = await f.executor.prepareScenario(session, f.directory, f.id);
    const capabilities = await f.provider.capabilities();
    f.provider.capabilities = async () => ({ ...capabilities,
      'input.targetedWindow': capabilities['input.targetedWindow']!.map(item => ({ ...item, state: 'not-proven' as const })) });
    await assert.rejects(prepared.preflight(), /not-proven/);
    await assert.rejects(control.beginTask('task'), /not-proven/);
    assert.equal(f.input.view(session).state, 'idle'); assert.ok(!f.backend.calls.includes('activate'));
    await prepared.close();
    f.provider.capabilities = async () => capabilities;
    await assert.rejects(control.beginTask('task'), /not-prepared/);
    assert.equal(f.input.view(session).state, 'idle');
  } finally { await f.dispose(); }
});
test('successful preflight cannot renew an expired grant or authorize execution', async () => {
  let now = 0;
  const f = fixture({ app: 'fixture' }, new ResourceInputControl(() => now, 100));
  try {
    const s = await admitted(f); await s.gate.preflight(s.target, f.id);
    const authority = await f.input.acquire(s.session, agent), captured = await s.backend.observe(authority);
    now = 101;
    const assertAuthority = f.input.assertAuthority, renew = f.input.renewAuthority;
    f.input.assertAuthority = () => assert.fail('preflight read an expired grant');
    f.input.renewAuthority = () => assert.fail('preflight renewed an expired grant');
    await s.gate.preflight(s.target, f.id);
    assert.equal(f.input.view(s.session).state, 'expired');
    f.input.assertAuthority = assertAuthority; f.input.renewAuthority = renew;
    await assert.rejects(s.gate.execute({ target: s.target, action: f.id, authority, observation: captured.binding }));
    assert.equal(f.backend.acts, 0); await s.backend.close();
  } finally { await f.dispose(); }
});
test('new observation invalidates the previous public binding and native token', async () => {
  const f = fixture();
  try {
    const s = await admitted(f), authority = await f.input.acquire(s.session, agent);
    const old = await s.backend.observe(authority), current = await s.backend.observe(authority);
    await assert.rejects(s.backend.execute({ target: s.target, action: f.id, authority, observation: old.binding }), /fresh-observation/);
    assert.equal(f.backend.acts, 0);
    await s.gate.execute({ target: s.target, action: f.id, authority, observation: current.binding });
    assert.equal(f.backend.acts, 1); await s.backend.close();
  } finally { await f.dispose(); }
});
test('revoke fences a pending observation and waits for runtime drain', async () => {
  const f = fixture();
  let release!: () => void;
  try {
    const s = await admitted(f), authority = await f.input.acquire(s.session, agent);
    f.backend.frameGate = new Promise<void>(resolveFrame => { release = resolveFrame; });
    const observing = s.backend.observe(authority);
    while (!f.backend.calls.includes('frame')) await new Promise<void>(resolveWait => setTimeout(resolveWait, 1));
    const rejected = assert.rejects(observing);
    let drained = false;
    const revoking = f.input.revokeSession(s.session).then(() => { drained = true; });
    await new Promise<void>(resolveWait => setTimeout(resolveWait, 5));
    assert.equal(drained, false); assert.throws(() => f.input.assertAuthority(s.session, authority));
    release(); await rejected; await revoking;
    assert.equal(f.backend.acts, 0); await s.backend.close();
  } finally { release?.(); await f.dispose(); }
});
test('a pending admission cannot replace its observation through a concurrent capture; close drains the port', async () => {
  const f = fixture(); let release!: () => void;
  try {
    const s = await admitted(f), authority = await f.input.acquire(s.session, agent);
    const captured = await s.backend.observe(authority);
    const capabilities = await f.provider.capabilities();
    const pending = new Promise<void>(resolveAdmission => { release = resolveAdmission; });
    let entered = false;
    f.provider.capabilities = async () => { entered = true; await pending; return capabilities; };
    const executing = s.backend.execute({ target: s.target, action: f.id, authority, observation: captured.binding });
    const rejected = assert.rejects(executing, /scenario-closed/);
    while (!entered) await new Promise<void>(resolveWait => setTimeout(resolveWait, 1));
    await assert.rejects(s.backend.observe(authority), /scenario-busy/);
    let closed = false; const closing = s.backend.close().then(() => { closed = true; });
    await new Promise<void>(resolveWait => setTimeout(resolveWait, 5)); assert.equal(closed, false);
    release(); await rejected; await closing; assert.equal(f.backend.acts, 0);
  } finally { release?.(); await f.dispose(); }
});
for (const config of [{ app: 'fixture' } as LocalWorkspaceAppConfig, music]) {
  test(`${config.app} port binds exact facts, runs once through P6 admission and independently verifies`, async () => {
    const f = fixture(config);
    try {
      const s = await admitted(f);
      assert.equal(s.target.sessionId, s.session.sessionId); assert.equal(s.target.instanceId, f.backend.instance);
      assert.equal(s.target.applicationVersion, config.app === 'fixture' ? 'd0-synthetic-fixture-v1' : '3.1.40.205461');
      await s.gate.preflight(s.target, f.id);
      const authority = await f.input.acquire(s.session, agent), captured = await s.backend.observe(authority);
      const request = { target: s.target, action: f.id, authority, observation: captured.binding };
      await s.gate.execute(request);
      assert.equal((await s.backend.verify(authority)).verdict, 'pass');
      await assert.rejects(s.gate.execute(request), /fresh-observation/);
      assert.equal(f.backend.acts, 1);
      assert.ok(f.backend.calls.indexOf('activate') < f.backend.calls.indexOf('frame'));
      assert.ok(f.backend.calls.indexOf('frame') < f.backend.calls.indexOf('act'));
      await s.backend.close();
    } finally { await f.dispose(); }
  });
}
test('successful act response cannot establish result; final screenshot is bracketed by complete state', async () => {
  const f = fixture(); f.backend.autoComplete = false;
  try {
    const s = await admitted(f); await s.gate.preflight(s.target, f.id);
    const authority = await f.input.acquire(s.session, agent), captured = await s.backend.observe(authority);
    await s.gate.execute({ target: s.target, action: f.id, authority, observation: captured.binding });
    assert.equal((await s.backend.verify(authority)).verdict, 'pending');
    f.backend.frameHook = () => { f.backend.complete(); f.backend.frameHook = undefined; };
    assert.equal((await s.backend.verify(authority)).verdict, 'pending'); // Before-capture state was incomplete.
    assert.equal((await s.backend.verify(authority)).verdict, 'pass');
    f.backend.current.clicks = 2;
    assert.equal((await s.backend.verify(authority)).verdict, 'pending');
    await s.backend.close();
  } finally { await f.dispose(); }
});
for (const drift of ['instance', 'target', 'run', 'desktop', 'windows-session', 'app'] as const) {
  test(`preflight and execution fail closed on ${drift} drift without replacement`, async () => {
    const f = fixture();
    try {
      const s = await admitted(f); await s.gate.preflight(s.target, f.id);
      const authority = await f.input.acquire(s.session, agent), captured = await s.backend.observe(authority);
      if (drift === 'instance') f.backend.instance = 'replacement';
      if (drift === 'target') f.backend.target = 'replacement';
      if (drift === 'run') f.backend.current.run_id = 'replacement';
      if (drift === 'desktop') f.backend.current.desktop = 'AgentD0_replacement';
      if (drift === 'windows-session') f.backend.windowsSessionId++;
      if (drift === 'app') f.backend.current.app = 'arbitrary-app';
      await assert.rejects(s.gate.execute({ target: s.target, action: f.id, authority, observation: captured.binding }));
      await assert.rejects(s.gate.preflight(s.target, f.id));
      assert.equal(f.backend.acts, 0); assert.equal(f.backend.calls.filter(c => c === 'start').length, 1);
      await s.backend.close();
    } finally { await f.dispose(); }
  });
}
test('NetEase input readiness and exact version remain mandatory', async () => {
  const f = fixture(music);
  try {
    const s = await admitted(f);
    f.backend.current.input_ready = false;
    await assert.rejects(s.gate.preflight(s.target, f.id), /not-ready/);
    assert.equal(f.input.view(s.session).state, 'idle');
    f.backend.current.input_ready = true; f.backend.current.app_version = 'replacement-version';
    await assert.rejects(s.gate.preflight(s.target, f.id));
    assert.ok(!f.backend.calls.includes('activate')); await s.backend.close();
  } finally { await f.dispose(); }
});
test('execute rechecks capabilities after preflight and backend independently fences a revoked native grant', async () => {
  for (const mode of ['capability', 'native-grant']) {
    const f = fixture();
    try {
      const s = await admitted(f); await s.gate.preflight(s.target, f.id);
      const authority = await f.input.acquire(s.session, agent), captured = await s.backend.observe(authority);
      const request = { target: s.target, action: f.id, authority, observation: captured.binding };
      if (mode === 'capability') {
        const capabilities = await f.provider.capabilities();
        f.provider.capabilities = async () => ({ ...capabilities,
          'input.targetedWindow': capabilities['input.targetedWindow']!.map(item => ({ ...item, state: 'forbidden' as const })) });
        await assert.rejects(s.gate.execute(request), /forbidden/);
      } else {
        f.backend.grant = undefined;
        await assert.rejects(s.backend.execute(request), /native-grant-fence/); // Bypass Host gate deliberately.
      }
      assert.equal(f.backend.acts, 0); await s.backend.close();
    } finally { await f.dispose(); }
  }
});
test('backend refuses fabricated observations and target metadata without effects', async () => {
  const f = fixture();
  try {
    const s = await admitted(f); const authority = await f.input.acquire(s.session, agent);
    const captured = await s.backend.observe(authority);
    await assert.rejects(s.backend.execute({ target: { ...s.target, application: 'arbitrary' }, action: f.id, authority,
      observation: captured.binding }), /stale-target/);
    await assert.rejects(s.backend.execute({ target: s.target, action: f.id, authority,
      observation: { ...captured.binding, observationId: 'fabricated' } }), /fresh-observation/);
    assert.equal(f.backend.acts, 0); await s.backend.close();
  } finally { await f.dispose(); }
});

async function composition(config: LocalWorkspaceAppConfig = { app: 'fixture' }) {
  const directory = mkdtempSync(join(tmpdir(), 'p6-b-task-')), backend = new ScenarioWorkspace();
  let modelCalls = 0;
  const assembly = await createRootAssembly({ rootDir: directory, localWorkspace: config, localWorkspaceBackendFactory: () => backend,
    model: { createModel: () => { modelCalls++; throw new Error('finite scenario must not call a model'); } } });
  const target = desktopTarget('windows-local-workspace', `local-workspace:${config.app}`);
  const trace = new SqliteTrace(join(directory, 'web-tasks.sqlite'));
  return { directory, backend, assembly, target, trace, modelCalls: () => modelCalls,
    async dispose() { trace.close(); try { await assembly.dispose(); } catch {} remove(directory); } };
}
async function waitTask(f: Awaited<ReturnType<typeof composition>>, id: string, predicate: (state: ReturnType<SqliteTrace['load']>) => boolean) {
  for (let i = 0; i < 200; i++) {
    const state = f.trace.load(id);
    if (predicate(state)) return state!;
    await new Promise<void>(resolveWait => setTimeout(resolveWait, 20));
  }
  assert.fail('synthetic Task did not reach expected boundary');
}
for (const config of [{ app: 'fixture' } as LocalWorkspaceAppConfig, music]) {
  test(`${config.app} is reachable through production unified Task queue, with durable binding and zero model calls`, async () => {
    const f = await composition(config);
    try {
      const id = f.assembly.controller.submitScenario({ desktopTarget: f.target, scenarioId: config.app === 'fixture' ? fixtureId : musicId });
      const state = await waitTask(f, id, state => state?.status === 'done' || state?.status === 'failed');
      assert.equal(state.status, 'done', state.error ?? 'Task did not complete'); assert.equal(state.desktopExecutionBinding?.instanceId, f.backend.instance);
      assert.equal(state.desktopScenarioVerification?.verdict, 'pass'); assert.equal(f.backend.acts, 1); assert.equal(f.modelCalls(), 0);
      const events = f.trace.events(id).map(event => event.node);
      assert.ok(events.indexOf('desktop_bound') < events.indexOf('desktop_scenario_dispatch'));
      assert.ok(events.indexOf('desktop_scenario_verified') < events.indexOf('desktop_scenario_done'));
      assert.ok(f.backend.calls.includes('stop')); assert.ok(f.backend.calls.includes('close'));
      assert.equal(readTaskBudget(f.directory, id)?.usage.deepseek.calls, 0);
      assert.equal(readTaskBudget(f.directory, id)?.usage.jev.calls, 0);
      const serialized = JSON.stringify(f.trace.events(id));
      assert.ok(!serialized.includes('synthetic-viewer-token')); assert.ok(!serialized.includes('synthetic-observation-'));
      assert.ok(!serialized.includes('grantId')); assert.ok(!serialized.includes('cloudmusic.exe'));
    } finally { await f.dispose(); }
  });
}
test('scenario selection rejects unknown environment, arbitrary action, and generic Task before backend/model construction', async () => {
  const f = await composition();
  try {
    assert.throws(() => f.assembly.controller.submitScenario({ desktopTarget: f.target, scenarioId: 'drag' }), /scenario-not-proven/);
    assert.throws(() => f.assembly.controller.submitScenario({ desktopTarget: { ...f.target, environmentId: 'local-workspace:arbitrary' }, scenarioId: fixtureId }), /unknown-local-workspace/);
    assert.throws(() => f.assembly.controller.submit('arbitrary edit', { desktopTarget: f.target }), /executor-unavailable/);
    assert.throws(() => f.assembly.controller.submitScenario({ desktopTarget: { ...f.target, providerId: 'windows-physical' }, scenarioId: fixtureId }));
    assert.deepEqual(f.backend.calls, []); assert.equal(f.modelCalls(), 0);
  } finally { await f.dispose(); }
});
test('pause after dispatch releases input, preserves uncertainty and forbids continue/replay', async () => {
  const f = await composition(); f.backend.autoComplete = false;
  try {
    const id = f.assembly.controller.submitScenario({ desktopTarget: f.target, scenarioId: fixtureId });
    await waitTask(f, id, () => f.backend.acts === 1);
    f.assembly.controller.pause(id);
    const state = await waitTask(f, id, state => state?.status === 'paused');
    assert.equal(state.recoveryUncertain, true); assert.notEqual(state.desktopScenarioVerification?.verdict, 'pass');
    assert.throws(() => f.assembly.controller.continue(id), /replay-forbidden/);
    await f.assembly.dispose(); assert.equal(f.backend.acts, 1); assert.ok(f.backend.calls.includes('stop'));
  } finally { await f.dispose(); }
});
test('controller close during a late owned Session open cancels before input acquisition or dispatch', async () => {
  const f = await composition();
  let release!: () => void;
  f.backend.startGate = new Promise<void>(resolveStart => { release = resolveStart; });
  try {
    const id = f.assembly.controller.submitScenario({ desktopTarget: f.target, scenarioId: fixtureId });
    await waitTask(f, id, () => f.backend.calls.includes('start'));
    const closing = f.assembly.dispose(); release(); await closing;
    const state = f.trace.load(id)!;
    assert.notEqual(state.status, 'done'); assert.equal(state.desktopScenarioDispatched, undefined);
    assert.ok(!f.backend.calls.includes('activate')); assert.equal(f.backend.acts, 0);
    assert.ok(f.backend.calls.includes('stop')); assert.ok(f.backend.calls.includes('close'));
  } finally { release(); await f.dispose(); }
});
test('uncertain dispatch and failed cleanup cannot materialize a completed Task', async t => {
  // This contract tests dispatch/cleanup faults, not filesystem wall-clock latency.
  // The separate clock-advance regression below keeps the production freshness gate covered.
  t.mock.method(performance, 'now', () => 0);
  for (const failure of ['dispatch', 'cleanup']) {
    const f = await composition(); f.backend.failAct = failure === 'dispatch'; f.backend.failStop = failure === 'cleanup';
    try {
      const id = f.assembly.controller.submitScenario({ desktopTarget: f.target, scenarioId: fixtureId });
      const state = await waitTask(f, id, state => state?.status === 'paused' || state?.status === 'failed');
      assert.notEqual(state.status, 'done'); assert.equal(state.recoveryUncertain, true);
      assert.ok(!f.trace.events(id).some(event => event.node === 'desktop_scenario_done'));
      assert.equal(f.backend.acts, 1);
    } finally { await f.dispose(); }
  }
});

test('expired synthetic observation is refused before dispatch without extending the production deadline', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const f = fixture();
  try {
    const s = await admitted(f), authority = await f.input.acquire(s.session, agent);
    const captured = await s.backend.observe(authority);
    now = 2001; // Fake frame lifetime is exactly 2000ms, while the input lease is still valid.
    await assert.rejects(s.gate.execute({ target: s.target, action: f.id, authority, observation: captured.binding }), /fresh-observation/);
    assert.equal(f.backend.acts, 0);
    const fresh = await s.backend.observe(authority);
    await s.gate.execute({ target: s.target, action: f.id, authority, observation: fresh.binding });
    assert.equal(f.backend.acts, 1);
    await s.backend.close();
  } finally { await f.dispose(); }
});
test('scenario identity is immutable in durable Task writes; generic Task cannot be retrofitted', async () => {
  const target = desktopTarget('provider', 'environment');
  const fields = { taskBindingVersion: 1 as const, desktopTarget: target, desktopScenario: fixtureId };
  validateTaskDesktop(fields);
  assert.throws(() => assertTaskDesktopUnchanged(fields, { ...fields, desktopScenario: musicId }), /immutable-task/);
  assert.throws(() => assertTaskDesktopUnchanged(fields, { ...fields, desktopScenario: undefined }), /immutable-task/);
  assert.throws(() => assertTaskDesktopUnchanged({ ...fields, desktopScenario: undefined }, fields), /immutable-task/);
  assert.throws(() => validateTaskDesktop({ desktopScenario: fixtureId }), /invalid-desktop-scenario/);
  const directory = mkdtempSync(join(tmpdir(), 'p6-b-immutable-')), trace = new SqliteTrace(join(directory, 'trace.sqlite'));
  try {
    const state = { ...fields, taskId: 'task', goal: 'fixed', step: 0, retryCount: 0, status: 'running' as const };
    trace.save('queued', state);
    assert.throws(() => trace.save('changed', { ...state, desktopScenario: musicId }), /immutable-task/);
    assert.equal(trace.load('task')?.desktopScenario, fixtureId);
  } finally { trace.close(); remove(directory); }
});
test('startup recovery retains finite dispatch uncertainty and never opens a replacement or offers replay', async () => {
  const f = await composition();
  try {
    f.trace.save('desktop_scenario_dispatch', { taskBindingVersion: 1, desktopTarget: f.target, desktopScenario: fixtureId,
      desktopExecutionBinding: { ...f.target, sessionId: 'lost-session', instanceId: 'lost-instance' },
      desktopScenarioDispatched: true, verificationPending: true, taskId: 'interrupted', goal: 'fixed', step: 1,
      retryCount: 0, status: 'running' });
    recoverDesktopTasks(f.directory);
    const state = f.trace.load('interrupted')!;
    assert.equal(state.status, 'paused'); assert.equal(state.recoveryUncertain, true);
    assert.equal(state.desktopExecutionBinding?.instanceId, 'lost-instance');
    assert.match(state.summary!, /禁止自动重放/);
    assert.throws(() => f.assembly.controller.continue('interrupted'), /replay-forbidden/);
    assert.deepEqual(f.backend.calls, []); assert.equal(f.modelCalls(), 0);
  } finally { await f.dispose(); }
});
