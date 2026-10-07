import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PhysicalDesktopProvider, type PhysicalBackend } from '../src/desktop-provider/physical-provider.js';
import { PhysicalTaskExecutor } from '../src/desktop-provider/physical-task-executor.js';
import { ResourceInputControl } from '../src/desktop-provider/resource-input-control.js';
import { TaskDesktopSessions, type DesktopTaskExecutor } from '../src/app/task-desktop-sessions.js';
import { desktopTarget } from '../src/contracts/task-desktop.js';
import { singleProvider } from '../src/actions/action-resolution.js';
import { createRootAssembly } from '../src/composition/root.js';
import type { PhysicalInputPolicy } from '../src/runtime/desktop/desktop-runtime.js';
import { loadDesktopEnvironmentConfig } from '../src/composition/desktop-environment-config.js';

const resolution = singleProvider('windows.pyautogui.act', 'synthetic policy');
const policy = { windowManagement: true, executors: [resolution.selected] };
function fixture(inputPolicy: PhysicalInputPolicy = policy) {
  let now = 0, factoryCalls = 0, effects = 0, revokes = 0, failRevoke = false, failRenew = false, instance = 'fixture-instance';
  const input = new ResourceInputControl(() => now);
  const backend: PhysicalBackend = {
    name: 'synthetic',
    async physicalHandshake() { return { instanceId: instance, inputResourceId: 'shared-desktop', ready: true }; },
    async grantPhysical() {}, async renewPhysical() { if (failRenew) throw new Error('lost-renewal-ack'); }, async revokePhysical() { revokes++; if (failRevoke) throw new Error('lost-revoke-ack'); },
    async bindPhysical() {}, async windowsPhysical() { return []; },
    async observe() { return { windowHandle: 7, windowTitle: 'fixture', pageText: 'synthetic' }; },
    async probe() { throw new Error('not used'); }, async recoverFocus() {},
    async ground() { return { attempts: [] }; }, async resolveAction() { return resolution; },
    async execute() { effects++; return { ok: true, message: 'synthetic' }; }, async restore() {}, async close() {},
  };
  const factory = async () => { factoryCalls++; return backend; };
  const provider = new PhysicalDesktopProvider(input, factory, inputPolicy, true);
  const executor = new PhysicalTaskExecutor(provider, input, inputPolicy);
  // Synthetic-only harness: these tests exercise the managed runtime after a hypothetical
  // independent capability gate. Production generic routing uses executor.assertAvailable().
  const capabilityAdmittedExecutor: DesktopTaskExecutor = {
    taskControl: session => executor.taskControl(session),
    connectRuntime: (session, dir) => executor.connectRuntime(session, dir),
    appCatalog: () => executor.appCatalog(),
    completeTask: (session, taskId) => executor.completeTask(session, taskId),
  };
  const sessions = new TaskDesktopSessions([provider], new Map([[provider.id, capabilityAdmittedExecutor]]));
  const target = desktopTarget(provider.id, 'current-interactive-desktop');
  return { provider, executor, sessions, target, factory, backend,
    counts: () => ({ factoryCalls, effects, revokes }), expire: () => { now = 3001; },
    replace: () => { instance = 'replacement'; }, failRevoke: () => { failRevoke = true; }, failRenew: () => { failRenew = true; } };
}

test('generic Physical discovery is lazy and policy alone never upgrades not-proven capability', async () => {
  assert.deepEqual(loadDesktopEnvironmentConfig(), {});
  const cases: Array<{ inputPolicy: PhysicalInputPolicy; reason: string }> = [
    { inputPolicy: { windowManagement: false, executors: [] }, reason: 'physical-task-policy-required' },
    { inputPolicy: policy, reason: 'physical-task-capability-not-proven' },
  ];
  for (const { inputPolicy, reason } of cases) {
    const f = fixture(inputPolicy);
    const genericSessions = new TaskDesktopSessions([f.provider], new Map([[f.provider.id, f.executor]]));
    try {
      assert.deepEqual(await genericSessions.discover(), [{ ...f.target, kind: 'physical', executable: false,
        blockedReason: reason }]);
      assert.throws(() => genericSessions.assertTarget(f.target), new RegExp(reason));
      await assert.rejects(genericSessions.acquire('task', { taskBindingVersion: 1, desktopTarget: f.target }, () => assert.fail()),
        new RegExp(reason));
      assert.deepEqual(f.counts(), { factoryCalls: 0, effects: 0, revokes: 0 });
    } finally { await genericSessions.close(); await f.sessions.close(); await f.provider.close(); }
  }
});

test('selected Physical executor uses the managed grant, selected policy and retained binding', async () => {
  const f = fixture();
  try {
    let binding;
    const entry = await f.sessions.acquire('task', { taskBindingVersion: 1, desktopTarget: f.target }, value => { binding = value; });
    assert.deepEqual(f.counts(), { factoryCalls: 1, effects: 0, revokes: 0 });
    await entry.control.beginTask('task');
    const runtime = await entry.executor.connectRuntime(entry.session, 'synthetic');
    assert.deepEqual(await entry.executor.appCatalog?.(), []);
    await assert.rejects(runtime.ensureApp('guest-app'), /app-launch-unavailable/);
    await runtime.attach({ windowHandle: 7 }); await runtime.observe();
    await runtime.execute({ kind: 'keypress', keys: 'space' }, resolution);
    await entry.control.finishTask('task', 'paused');
    await assert.rejects(runtime.observe(), /physical-runtime-closed/);
    const resumed = await f.sessions.acquire('task', { taskBindingVersion: 1, desktopTarget: f.target, desktopExecutionBinding: binding }, () => assert.fail());
    assert.equal(resumed.session, entry.session);
    await resumed.control.beginTask('task');
    const resumedRuntime = await resumed.executor.connectRuntime(resumed.session, 'synthetic');
    await assert.rejects(resumedRuntime.execute({ kind: 'keypress', keys: 'space' }, resolution), /rebind-and-observe/);
    await resumed.control.finishTask('task', 'done');
    await f.sessions.completeTask('task', binding!);
    assert.equal(f.counts().effects, 1);
    assert.equal(f.counts().factoryCalls, 1);
  } finally { await f.sessions.close(); await f.provider.close(); }
});

test('lease expiration denies old input and lifecycle release still revokes the backend', async () => {
  const f = fixture();
  try {
    const entry = await f.sessions.acquire('task', { taskBindingVersion: 1, desktopTarget: f.target }, () => {});
    await entry.control.beginTask('task');
    const runtime = await entry.executor.connectRuntime(entry.session, 'synthetic');
    await runtime.attach({ windowHandle: 7 }); await runtime.observe(); f.expire();
    assert.throws(() => entry.control.assertTaskAllowed('task'), /invalid-input-authority/);
    await assert.rejects(runtime.execute({ kind: 'keypress', keys: 'space' }, resolution), /invalid-input-authority/);
    await entry.control.finishTask('task', 'paused');
    assert.equal(f.counts().effects, 0); assert.equal(f.counts().revokes, 1);
  } finally { await f.sessions.close(); await f.provider.close(); }
});

test('old renewal protocol is refused before planning; a failed renewal invalidates the original binding', async () => {
  for (const old of [true, false]) {
    const f = fixture();
    try {
      const entry = await f.sessions.acquire('task', { taskBindingVersion: 1, desktopTarget: f.target }, () => {});
      await entry.control.beginTask('task');
      if (old) delete f.backend.renewPhysical;
      else f.failRenew();
      await assert.rejects(entry.executor.connectRuntime(entry.session, 'synthetic'), old ? /renewal-unavailable/ : /lost-renewal-ack/);
      if (!old) await assert.rejects(f.sessions.acquire('task', { taskBindingVersion: 1, desktopTarget: f.target,
        desktopExecutionBinding: entry.binding }, () => assert.fail()), /stale-desktop-binding/);
      assert.equal(f.counts().effects, 0);
      assert.equal(f.counts().revokes, 1);
    } finally { await f.sessions.close(); await f.provider.close(); }
  }
});

test('competing bindings cannot steal input; failed revoke blocks the resource and never grants completion', async () => {
  const f = fixture();
  try {
    const a = await f.sessions.acquire('a', { taskBindingVersion: 1, desktopTarget: f.target }, () => {});
    const b = await f.sessions.acquire('b', { taskBindingVersion: 1, desktopTarget: f.target }, () => {});
    await a.control.beginTask('a');
    await assert.rejects(b.control.beginTask('b'), /input-resource-busy/);
    await a.executor.connectRuntime(a.session, 'synthetic'); f.failRevoke();
    await assert.rejects(a.control.finishTask('a', 'done'), /drain failed/);
    await assert.rejects(b.control.beginTask('b'), /resource-drain-unconfirmed/);
    await assert.rejects(f.sessions.completeTask('a', a.binding), /foreign-task/);
    assert.equal(f.counts().effects, 0);
    await assert.rejects(f.sessions.close(), /cleanup failed/);
  } finally { await f.provider.close().catch(() => {}); }
});

test('backend replacement invalidates the original Task and does not reopen a Session', async () => {
  const f = fixture();
  try {
    const entry = await f.sessions.acquire('task', { taskBindingVersion: 1, desktopTarget: f.target }, () => {});
    await entry.control.beginTask('task');
    const runtime = await entry.executor.connectRuntime(entry.session, 'synthetic'); f.replace();
    await assert.rejects(runtime.listWindows());
    await assert.rejects(f.sessions.acquire('task', { taskBindingVersion: 1, desktopTarget: f.target,
      desktopExecutionBinding: entry.binding }, () => assert.fail()), /stale-desktop-binding/);
    assert.equal(f.counts().factoryCalls, 1); assert.equal(f.counts().effects, 0);
  } finally { await f.sessions.close(); await f.provider.close(); }
});

test('production composition keeps configured Physical generic Tasks non-executable before planning', async () => {
  const f = fixture(); const directory = mkdtempSync(join(tmpdir(), 'p5-b-physical-'));
  let modelStarts = 0;
  const assembly = await createRootAssembly({ rootDir: directory, physicalBackendFactory: f.factory, physicalInputPolicy: policy,
    model: { createModel: () => { modelStarts++; throw new Error('model-must-not-start'); } } });
  try {
    const options = await assembly.controller.desktopOptions();
    const physical = options.find(item => item.kind === 'physical');
    assert.deepEqual(physical, { ...f.target, kind: 'physical', executable: false,
      blockedReason: 'physical-task-capability-not-proven' });
    assert.throws(() => assembly.controller.submit('VM: remains ordinary goal text', { desktopTarget: f.target }),
      /physical-task-capability-not-proven/);
    assert.equal(modelStarts, 0);
    assert.deepEqual(f.counts(), { factoryCalls: 0, effects: 0, revokes: 0 });
  } finally { await assembly.dispose(); await f.provider.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('configured Local Workspace discovery retains its finite boundary without starting an application', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'p5-b-finite-'));
  let starts = 0;
  const assembly = await createRootAssembly({ rootDir: directory, localWorkspace: { app: 'fixture' },
    model: { createModel: () => { throw new Error('no model'); } },
    localWorkspaceBackendFactory: () => { starts++; throw new Error('must not construct a backend'); } });
  try {
    const options = await assembly.controller.desktopOptions();
    const workspace = options.find(item => item.kind === 'local-workspace');
    assert.equal(workspace?.executable, false);
    assert.equal(workspace?.blockedReason, 'desktop-task-executor-unavailable');
    assert.throws(() => assembly.controller.submit('arbitrary actions', { desktopTarget: workspace! }), /desktop-task-executor-unavailable/);
    assert.equal(starts, 0);
  } finally { await assembly.dispose(); rmSync(directory, { recursive: true, force: true }); }
});
