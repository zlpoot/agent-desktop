import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { HyperVDesktopProvider } from "../src/desktop-provider/hyperv-provider.js";
import { DesktopSessionManager } from "../src/desktop-session/session-manager.js";
import { DesktopControl } from "../src/desktop-session/control.js";
import { GuestDesktopRuntime } from "../src/runtime/desktop/guest-runtime.js";
import { singleProvider } from "../src/actions/action-resolution.js";
import { createRootAssembly } from "../src/composition/root.js";
import { mountSessionScope } from "../src/composition/session-scope.js";
import { TaskDesktopSessions } from '../src/app/task-desktop-sessions.js';
import { desktopTarget } from '../src/contracts/task-desktop.js';

const png = Buffer.from("89504e470d0a1a0a", "hex");
const action = { kind: "keypress", keys: "escape" } as const;
const resolution = singleProvider("windows.pyautogui.act", "synthetic legacy resolution");
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
type Rpc = { method: string; recoveryEpoch: string; controlEpoch: number; vmId: string;
  args: { actionId?: string; allowedProviders?: string[]; windowHandle?: number; windowTitle?: string } };

/** Protocol substitute only: no VM, native window, input library, or model. */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hyperv-provider-"));
  const remote = { id: "vm", epoch: "boot", mode: "paused", revision: 0, lease: null as string | null,
    ready: true, compatible: true, states: 0, resets: 0, effects: 0, inputs: 0, controls: 0,
    failPaused: false, failAgentAck: false, calls: [] as Rpc[], rejected: [] as string[],
    stateHook: undefined as (() => Promise<void> | void) | undefined,
    rpcHook: undefined as ((rpc: Rpc) => Promise<void> | void) | undefined };
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const fail = (error: string) => { remote.rejected.push(error); res.writeHead(409).end(JSON.stringify({ error })); };
    if (req.headers.authorization !== "Bearer synthetic") return void res.writeHead(401).end("{}");
    if (req.url === "/state") {
      remote.states++; await remote.stateHook?.();
      return void res.end(JSON.stringify({ vm_id: remote.id, recovery_epoch: remote.epoch,
        action_rpc: true, control_rpc: true, recovery_rpc: remote.compatible,
        control_epoch_rpc: true, action_id_rpc: true, ready_for_observation: remote.ready,
        ready_for_input: remote.ready, input_mode: remote.mode }));
    }
    if (req.url === "/frame") return void res.end(png);
    let raw = ""; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    if (body.vmId !== remote.id) return fail("wrong VM");
    if (req.url === "/control") {
      remote.controls++;
      if (remote.failPaused && body.mode !== "agent") return fail("synthetic revocation failure");
      if (body.revision < remote.revision) return fail("stale control revision");
      if (body.resetTask) remote.epoch = `reset-${++remote.resets}`;
      remote.mode = body.mode; remote.revision = body.revision;
      remote.lease = body.mode === "human" ? `lease-${body.revision}` : null;
      if (remote.failAgentAck && body.mode === "agent") return fail("synthetic lost Agent ACK");
      return void res.end(JSON.stringify({ result: { mode: remote.mode, lease: remote.lease, recovery_rpc: true } }));
    }
    if (req.url === "/human-input") {
      if (remote.mode !== "human" || body.lease !== remote.lease || !remote.ready) return fail("stale lease");
      remote.inputs++; return void res.end(JSON.stringify({ result: {} }));
    }
    const rpc = body as Rpc; remote.calls.push(rpc); await remote.rpcHook?.(rpc);
    // Mirrors the existing Worker lock's independent gates, even after Host checks pass.
    if (rpc.recoveryEpoch !== remote.epoch) return fail("Worker session changed; reobserve");
    if (!remote.ready) return fail("desktop not ready");
    if (["init", "ensure_app", "restore", "execute"].includes(rpc.method) &&
      (rpc.controlEpoch !== remote.revision || remote.mode !== "agent")) return fail("stale control epoch");
    let result: unknown = {};
    if (rpc.method === "list_windows") result = [{ handle: 7, title: "Synthetic editor" }];
    if (rpc.method === "ensure_app" || rpc.method === "init") result = { handle: 7, title: "Synthetic editor" };
    if (rpc.method === "observe") result = { windowHandle: 7, windowTitle: "Synthetic editor", pageText: "fixture" };
    if (rpc.method === "restore") result = { handle: rpc.args.windowHandle, title: rpc.args.windowTitle };
    if (rpc.method === "resolve_action") result = resolution;
    if (rpc.method === "ground") result = { attempts: [] };
    if (rpc.method === "probe") result = { foreground: true, permissionsCompatible: true };
    if (rpc.method === "execute") {
      if (!rpc.args.actionId || rpc.args.allowedProviders?.length !== 1) return fail("missing executor/action identity");
      remote.effects++; result = { ok: true, effect: "dispatched", message: "synthetic" };
    }
    res.end(JSON.stringify({ result }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const legacy = new DesktopSessionManager(dir, "synthetic"); legacy.register("vm", endpoint, "legacy");
  const control = new DesktopControl(dir, legacy, "legacy", "synthetic",
    { submit: () => "", pause() {}, continue() {}, resume() {} }, true,
    { pollMs: 1, timeoutMs: 500, retryMaxMs: 2 });
  const provider = new HyperVDesktopProvider(legacy, "synthetic");
  const unregister = provider.registerControl("legacy", control);
  return { dir, endpoint, remote, legacy, control, provider, unregister,
    async close() {
      remote.stateHook = undefined; remote.rpcHook = undefined;
      try { await provider.close(); } catch { /* Deliberately blocked fixtures are asserted by their test. */ }
      await control.close(); await legacy.close();
      await new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); });
      rmSync(dir, { recursive: true, force: true });
    } };
}

test("Hyper-V maps legacy VM identity, pins immutable Sessions and keeps capability claims conservative", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.provider.discover(), [{ providerId: "hyper-v", environmentId: "vm:vm", kind: "virtual-machine" }]);
    const a = await f.provider.open("vm:vm"), b = await f.provider.open("vm:vm");
    assert.ok(Object.isFrozen(a)); assert.notEqual(a.sessionId, "legacy"); assert.notEqual(a.sessionId, b.sessionId);
    assert.equal(a.instanceId, b.instanceId); assert.equal(a.inputResourceId, b.inputResourceId);
    assert.equal((await a.status()).readiness["observation.pixels"]?.state, "ready");
    assert.equal((await a.status()).readiness["input.rawIsolated"]?.state, "unknown");
    const caps = await a.capabilities();
    assert.equal(caps["input.rawIsolated"]?.[0].state, "not-proven");
    assert.equal(caps["isolation.separateOs"]?.[0].state, "not-proven");
    assert.equal(caps["input.globalInput"]?.[0].state, "forbidden");
    await b.close(); assert.equal((await a.status()).state, "open");
  } finally { await f.close(); }
});

test("missing authority, unknown environment and incompatible/unready Workers fail closed", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.provider.open("physical"), /unmanaged-environment/);
    const session = await f.provider.open("vm:vm");
    await assert.rejects(f.provider.connectRuntime(session, f.dir), /input-not-owned/);
    f.remote.ready = false; assert.equal((await session.status()).readiness["observation.pixels"]?.state, "not-ready");
    await assert.rejects(f.provider.open("vm:vm"), /worker-not-ready/);
    f.remote.ready = true; f.remote.compatible = false;
    await assert.rejects(f.provider.open("vm:vm"), /incompatible-worker/);
    f.remote.compatible = true; f.remote.id = "other";
    await assert.rejects(f.provider.open("vm:vm"), /incompatible-worker/);
    assert.equal(f.remote.effects, 0); assert.equal(f.remote.inputs, 0);
  } finally { await f.close(); }
});

test('Task binding uses the existing Hyper-V handshake, survives release and refuses backend replacement', async () => {
  const f = await fixture();
  const sessions = new TaskDesktopSessions([f.provider], new Map([[f.provider.id, f.provider]]));
  const target = desktopTarget(f.provider.id, 'vm:vm');
  let binding: import('../src/contracts/task-desktop.js').TaskDesktopExecutionBinding | undefined;
  try {
    const entry = await sessions.acquire('task', { taskBindingVersion: 1, desktopTarget: target }, value => { binding = value; });
    assert.equal(binding?.sessionId, entry.session.sessionId);
    assert.notEqual(binding?.sessionId, 'legacy');
    assert.equal(sessions.usesControl('task', f.control), true);
    await entry.control.beginTask('task');
    const runtime = await entry.executor.connectRuntime(entry.session, f.dir);
    await runtime.attach({ windowHandle: 7 }); await runtime.observe();
    await runtime.close(); await entry.control.finishTask('task', 'paused');
    assert.equal((await sessions.acquire('task', { taskBindingVersion: 1, desktopTarget: target,
      desktopExecutionBinding: binding }, () => assert.fail())).session, entry.session);
    f.remote.epoch = 'new-backend';
    await assert.rejects(sessions.acquire('task', { taskBindingVersion: 1, desktopTarget: target,
      desktopExecutionBinding: binding }, () => assert.fail()), /stale-desktop-binding/);
    assert.equal(f.remote.effects, 0);
  } finally { await sessions.close(); await f.close(); }
});

test('manual completion uses the original binding without granting input and fences competing Sessions', async () => {
  const f = await fixture();
  try {
    const session = await f.provider.open('vm:vm');
    const control = f.provider.taskControl(session);
    await control.beginTask('task'); await control.finishTask('task', 'waiting_user');
    const observer = await f.provider.open('vm:vm');
    const entered = deferred(), release = deferred();
    let first = true;
    f.remote.stateHook = async () => { if (first) { first = false; entered.resolve(); await release.promise; } };
    const completing = f.provider.completeTask(session, 'task');
    await entered.promise;
    await assert.rejects(f.provider.taskControl(observer).beginTask('other'), /input-resource-busy/);
    release.resolve();
    await completing;
    assert.equal(f.control.view().taskId, null); assert.equal(f.remote.mode, 'paused');
    assert.equal(f.remote.effects, 0); assert.equal(f.remote.inputs, 0);
    assert.ok(f.remote.calls.every(call => call.method !== 'execute'));
  } finally { await f.close(); }
});

test("two new Sessions share the existing task authority; observer close never revokes the owner", async () => {
  const f = await fixture();
  try {
    const a = await f.provider.open("vm:vm"), b = await f.provider.open("vm:vm");
    const ca = f.provider.taskControl(a), cb = f.provider.taskControl(b);
    await ca.beginTask("first");
    assert.equal(cb.agentEpoch?.(), undefined);
    await assert.rejects(cb.beginTask("second"), /input-resource-busy/);
    await b.close(); assert.equal(f.remote.mode, "agent");
    await ca.finishTask("first", "done");
    const c = await f.provider.open("vm:vm"); await f.provider.taskControl(c).beginTask("second");
    await f.provider.taskControl(c).finishTask("second", "done");
  } finally { await f.close(); }
});

test("duplicate legacy controllers for one VM cannot mint independent new authorities", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.open("vm:vm");
    f.legacy.register("vm", f.endpoint, "alias");
    const unregister = f.provider.registerControl("alias", f.control);
    assert.equal((await f.provider.discover()).length, 1);
    await assert.rejects(f.provider.open("vm:vm"), /ambiguous-input-resource/);
    assert.equal((await session.status()).state, "stale");
    await unregister();
    assert.throws(() => f.provider.taskControl(session), /stale-session/);
  } finally { await f.close(); }
});

test("bound runtime preserves Guest actionId/provider/epoch wire and requires bind then observation", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.open("vm:vm"), input = f.provider.taskControl(session);
    await input.beginTask("task"); const runtime = await f.provider.connectRuntime(session, f.dir);
    await assert.rejects(runtime.execute(action, resolution, "step"), /rebind-and-observe-required/);
    await assert.rejects(runtime.observe(), /rebind-required/);
    await runtime.attach({ windowHandle: 7 });
    await assert.rejects(runtime.execute(action, resolution, "step"), /rebind-and-observe-required/);
    await runtime.observe(); await runtime.execute(action, resolution, "task:step:provider");
    const wire = f.remote.calls.find(call => call.method === "execute")!;
    assert.equal(wire.recoveryEpoch, f.remote.epoch); assert.equal(wire.controlEpoch, input.agentEpoch?.());
    assert.deepEqual(wire.args.allowedProviders, [resolution.selected]); assert.equal(wire.args.actionId, "task:step:provider");
    await assert.rejects(runtime.execute(action, resolution, "again"), /rebind-and-observe-required/);
    assert.equal(f.remote.effects, 1); await input.finishTask("task", "done");
    await assert.rejects(runtime.observe(), /runtime-closed/);
  } finally { await f.close(); }
});

test("Viewer clients use the same legacy lease arbiter and obsolete Agent runtime cannot resume", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.open("vm:vm"), input = f.provider.taskControl(session);
    await input.beginTask("task"); const runtime = await f.provider.connectRuntime(session, f.dir);
    await runtime.attach({ windowHandle: 7 }); await runtime.observe();
    await input.finishTask("task", "paused");
    await f.control.command("viewer-a", "take");
    await assert.rejects(f.control.command("viewer-b", "take"));
    await assert.rejects(f.control.input("viewer-b", { kind: "text", text: "never" }));
    await f.control.input("viewer-a", { kind: "text", text: "synthetic" });
    await assert.rejects(input.beginTask("task"));
    await f.control.command("viewer-a", "resume");
    await assert.rejects(f.control.input("viewer-a", { kind: "text", text: "old lease" }));
    await input.beginTask("task");
    await assert.rejects(runtime.execute(action, resolution, "old"), /runtime-closed/);
    await input.finishTask("task", "done"); assert.equal(f.remote.inputs, 1);
  } finally { await f.close(); }
});

test("replacement handshake creates new identity and cannot transplant old observations", async () => {
  const f = await fixture();
  try {
    const old = await f.provider.open("vm:vm"), input = f.provider.taskControl(old);
    await input.beginTask("task"); const runtime = await f.provider.connectRuntime(old, f.dir);
    await runtime.attach({ windowHandle: 7 }); const observation = await runtime.observe();
    await input.finishTask("task", "done");
    f.remote.epoch = "new-worker"; const current = await f.provider.open("vm:vm");
    assert.equal((await old.status()).state, "stale");
    assert.notEqual(current.instanceId, old.instanceId); assert.notEqual(current.sessionId, old.sessionId);
    assert.equal(current.inputResourceId, old.inputResourceId);
    const next = f.provider.taskControl(current); await next.beginTask("new-task");
    const newRuntime = await f.provider.connectRuntime(current, f.dir);
    await assert.rejects(newRuntime.restore(observation), /stale-observation/);
    await assert.rejects(newRuntime.execute(action, resolution, "never"), /rebind-and-observe-required/);
    await newRuntime.attach({ windowHandle: 7 }); await newRuntime.observe();
    await newRuntime.execute(action, resolution, "new-step"); await next.finishTask("new-task", "done");
  } finally { await f.close(); }
});

test("endpoint replacement stales old Session; wrong VM endpoint receives no action RPC", async () => {
  const f = await fixture(), other = await fixture();
  try {
    const session = await f.provider.open("vm:vm"); other.remote.id = "different-vm";
    f.legacy.updateWorkerEndpoint("legacy", other.endpoint);
    assert.equal((await session.status()).state, "stale");
    await assert.rejects(f.provider.open("vm:vm"), /incompatible-worker/);
    assert.equal(other.remote.calls.length, 0);
  } finally { await f.close(); await other.close(); }
});

for (const trigger of ["status", "runtime"] as const) {
  test(`same-endpoint VM identity drift through ${trigger} permanently stales Sessions and drains old runtime`, async () => {
    const f = await fixture(), drainStarted = deferred();
    try {
      const session = await f.provider.open("vm:vm"), observer = await f.provider.open("vm:vm");
      const input = f.provider.taskControl(session); await input.beginTask("task");
      const runtime = await f.provider.connectRuntime(session, f.dir);
      await runtime.attach({ windowHandle: 7 }); const observation = await runtime.observe();
      assert.equal((await session.status()).state, "open");
      const epoch = f.remote.epoch, endpoint = f.legacy.get("legacy")!.workerEndpoint;
      const closeRuntime = runtime.close;
      runtime.close = () => { drainStarted.resolve(); return closeRuntime(); };

      f.remote.id = "another-vm"; // Same endpoint and recovery_epoch: only backend VM identity drifts.
      if (trigger === "status") assert.equal((await session.status()).state, "stale");
      else await assert.rejects(runtime.observe(), /incompatible-worker/);
      assert.equal((await session.status()).state, "stale");
      assert.equal((await observer.status()).state, "stale");
      await drainStarted.promise;

      f.remote.id = "vm";
      assert.equal(f.remote.epoch, epoch); assert.equal(f.legacy.get("legacy")!.workerEndpoint, endpoint);
      assert.equal((await session.status()).state, "stale");
      assert.equal((await observer.status()).state, "stale");
      assert.throws(() => f.provider.taskControl(session), /stale-session/);
      assert.throws(() => f.provider.connectRuntime(session, f.dir), /stale-session/);
      await assert.rejects(runtime.observe(), /runtime-closed|stale-session/);
      await assert.rejects(runtime.restore(observation), /runtime-closed|stale-session/);
      await assert.rejects(runtime.execute(action, resolution, "never-resurrect"), /runtime-closed|stale-session/);
      assert.equal(f.remote.calls.filter(call => call.method === "observe").length, 1);
      assert.equal(f.remote.calls.some(call => call.method === "restore" || call.method === "execute"), false);
      assert.equal(f.remote.effects, 0);
    } finally { await f.close(); }
  });
}

test("backend independently refuses recovery identity changed after Host's last admission", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.open("vm:vm"), input = f.provider.taskControl(session);
    await input.beginTask("task"); const runtime = await f.provider.connectRuntime(session, f.dir);
    await runtime.attach({ windowHandle: 7 }); await runtime.observe();
    f.remote.rpcHook = rpc => { if (rpc.method === "execute") f.remote.epoch = "between-host-and-dispatch"; };
    await assert.rejects(runtime.execute(action, resolution, "raced"), /Worker session changed/);
    assert.equal(f.remote.effects, 0); assert.equal((await session.status()).state, "stale");
    assert.ok(f.remote.rejected.includes("Worker session changed; reobserve"));
  } finally { await f.close(); }
});

test("runtime connection pins immutable recovery identity across a handshake race", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.open("vm:vm"), input = f.provider.taskControl(session);
    await input.beginTask("task");
    const nativeHandshake = f.remote.states + 3;
    f.remote.stateHook = () => { if (f.remote.states === nativeHandshake) f.remote.epoch = "raced-handshake"; };
    await assert.rejects(f.provider.connectRuntime(session, f.dir), /instance changed/);
    assert.equal((await session.status()).state, "stale"); assert.equal(f.remote.calls.length, 0);
  } finally { await f.close(); }
});

test("drain waits in-flight RPC before releasing authority or allowing the next Session", async () => {
  const f = await fixture(), started = deferred(), release = deferred();
  try {
    const a = await f.provider.open("vm:vm"), b = await f.provider.open("vm:vm");
    const input = f.provider.taskControl(a); await input.beginTask("first");
    const runtime = await f.provider.connectRuntime(a, f.dir);
    await runtime.attach({ windowHandle: 7 }); await runtime.observe();
    f.remote.rpcHook = async rpc => { if (rpc.method === "execute") { started.resolve(); await release.promise; } };
    const actionPending = runtime.execute(action, resolution, "held"); await started.promise;
    let finished = false; const finish = input.finishTask("first", "done").then(() => { finished = true; });
    await assert.rejects(f.provider.taskControl(b).beginTask("second"), /input-resource-busy/);
    assert.equal(finished, false); assert.equal(f.remote.mode, "agent");
    release.resolve(); await actionPending; await finish;
    await f.provider.taskControl(b).beginTask("second"); await f.provider.taskControl(b).finishTask("second", "done");
  } finally { release.resolve(); await f.close(); }
});

test("unconfirmed revocation permanently blocks acquire, repeat finish and Session close", async () => {
  const f = await fixture();
  try {
    const a = await f.provider.open("vm:vm"), b = await f.provider.open("vm:vm");
    const input = f.provider.taskControl(a); await input.beginTask("task"); f.remote.failPaused = true;
    await assert.rejects(input.finishTask("task", "done"), /input-revocation-unconfirmed/);
    f.remote.failPaused = false;
    await assert.rejects(input.finishTask("task", "done"), /input-revocation-unconfirmed/);
    await assert.rejects(a.close(), /input-revocation-unconfirmed/);
    await assert.rejects(f.provider.taskControl(b).beginTask("next"), /input-resource-busy/);
    await assert.rejects(f.provider.close(), /cleanup unconfirmed/);
  } finally { await f.close(); }
});

test("scope unregister invalidates handles and root exposes selectable contract without core branching", async () => {
  const f = await fixture(); const saved = process.env.AGENT_DESKTOP_TOKEN;
  process.env.AGENT_DESKTOP_TOKEN = "synthetic";
  const assembly = await createRootAssembly({ rootDir: f.dir, desktop: f.legacy,
    model: { createModel() { throw new Error("No model should be used"); } } });
  try {
    const scope = mountSessionScope({ root: assembly.root, rootDir: f.dir, sessionId: "mounted", vmId: "vm",
      endpoint: f.endpoint, token: "synthetic", controlBus: assembly.controlBus, intervalMs: 100_000 });
    await scope.fiber;
    const common = assembly.environmentProviders[0]; assert.equal(common.kind, "virtual-machine");
    const session = await common.open("vm:vm");
    await assembly.root.hyperVCompatibility.taskControl(session).beginTask("task");
    const runtime = await assembly.root.hyperVCompatibility.connectRuntime(session, f.dir);
    await runtime.attach({ windowHandle: 7 }); await runtime.observe();
    await scope.dispose(); assert.equal((await session.status()).state, "stale");
    await assert.rejects(runtime.execute(action, resolution, "after-dispose"), /runtime-closed|stale-session/);
    assert.equal(f.remote.mode, "paused");
    await assert.rejects(common.open("vm:vm"), /unmanaged-environment/);
  } finally {
    await assembly.dispose();
    if (saved === undefined) delete process.env.AGENT_DESKTOP_TOKEN; else process.env.AGENT_DESKTOP_TOKEN = saved;
    await f.close();
  }
});

test("optional recovery pin leaves old runtime factory calls compatible but rejects new mismatches", async () => {
  const f = await fixture();
  try {
    await assert.rejects(GuestDesktopRuntime.connect(f.endpoint, "synthetic", "vm", f.dir, undefined, "wrong"), /instance changed/);
    const legacyRuntime = await GuestDesktopRuntime.connect(f.endpoint, "synthetic", "vm", f.dir);
    await legacyRuntime.close();
    assert.equal(f.remote.calls.at(-1)?.method, "release");
  } finally { await f.close(); }
});

test("Session close drains a pending runtime connection and rejects its late result", async () => {
  const f = await fixture(), started = deferred(), release = deferred();
  try {
    const session = await f.provider.open("vm:vm"), input = f.provider.taskControl(session);
    await input.beginTask("task"); const handshake = f.remote.states + 3;
    f.remote.stateHook = async () => {
      if (f.remote.states === handshake) { started.resolve(); await release.promise; }
    };
    const connecting = f.provider.connectRuntime(session, f.dir);
    const rejected = assert.rejects(connecting, /stale-session/);
    await started.promise; const closing = session.close();
    release.resolve(); await rejected; await closing;
    assert.equal((await session.status()).state, "closed");
    assert.equal(f.remote.mode, "paused"); assert.equal(f.remote.effects, 0);
    assert.equal(f.remote.calls.some(call => call.method === "init"), false);
  } finally { release.resolve(); await f.close(); }
});

test("close concurrent with task admission cannot resurrect the closed Session", async () => {
  const f = await fixture(), started = deferred(), release = deferred();
  try {
    const session = await f.provider.open("vm:vm"), input = f.provider.taskControl(session);
    const afterGrant = f.remote.states + 4;
    f.remote.stateHook = async () => {
      if (f.remote.states === afterGrant) { started.resolve(); await release.promise; }
    };
    const rejected = assert.rejects(input.beginTask("task"), /stale-session/);
    await started.promise; const closing = session.close();
    release.resolve(); await rejected; await closing;
    assert.equal((await session.status()).state, "closed"); assert.equal(f.remote.mode, "paused");
  } finally { release.resolve(); await f.close(); }
});

test("legacy task ownership cannot be revoked by a second Session failing admission", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.open("vm:vm");
    await f.control.beginTask("legacy-task");
    await assert.rejects(f.provider.taskControl(session).beginTask("legacy-task"));
    await session.close();
    assert.equal(f.remote.mode, "agent"); assert.equal(f.control.view().taskId, "legacy-task");
    await f.control.finishTask("legacy-task", "done");
  } finally { await f.close(); }
});

test("all runtimes drain even when the first drain fails; failed ACK cannot unlock input", async () => {
  const f = await fixture();
  try {
    const a = await f.provider.open("vm:vm"), b = await f.provider.open("vm:vm");
    const input = f.provider.taskControl(a); await input.beginTask("task");
    const first = await f.provider.connectRuntime(a, f.dir), second = await f.provider.connectRuntime(a, f.dir);
    const closeFirst = first.close, closeSecond = second.close; let secondClosed = false;
    first.close = async () => { throw new Error("synthetic first drain failure"); };
    second.close = async () => { secondClosed = true; await closeSecond(); };
    await assert.rejects(input.finishTask("task", "done"), /Runtime drain unconfirmed/);
    assert.equal(secondClosed, true);
    await assert.rejects(f.provider.taskControl(b).beginTask("next"), /input-resource-busy/);
    first.close = closeFirst; await first.close();
    await assert.rejects(a.close(), /Runtime drain unconfirmed/);
    await assert.rejects(input.finishTask("task", "done"), /Runtime drain unconfirmed/);
  } finally { await f.close(); }
});

test("Guest controlEpoch gate rejects a request whose authority changes after Host check", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.open("vm:vm"), input = f.provider.taskControl(session);
    await input.beginTask("task"); const runtime = await f.provider.connectRuntime(session, f.dir);
    await runtime.attach({ windowHandle: 7 }); await runtime.observe();
    f.remote.rpcHook = rpc => { if (rpc.method === "execute") remoteRevoke(); };
    function remoteRevoke() { f.remote.mode = "paused"; f.remote.revision++; }
    await assert.rejects(runtime.execute(action, resolution, "revoked-in-transit"), /stale control epoch/);
    assert.equal(f.remote.effects, 0); assert.ok(f.remote.rejected.includes("stale control epoch"));
    await input.finishTask("task", "done");
  } finally { await f.close(); }
});

test("lost setup ACK never allows another acquire or a false successful cleanup", async () => {
  const f = await fixture();
  try {
    const a = await f.provider.open("vm:vm"), b = await f.provider.open("vm:vm");
    f.remote.failAgentAck = true;
    await assert.rejects(f.provider.taskControl(a).beginTask("task"), /lost Agent ACK/);
    f.remote.failAgentAck = false;
    assert.equal(f.remote.mode, "agent");
    await assert.rejects(a.close(), /input-setup-unconfirmed/);
    await assert.rejects(f.provider.taskControl(b).beginTask("next"), /input-resource-busy/);
  } finally { await f.close(); }
});
