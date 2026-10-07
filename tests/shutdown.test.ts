import { fixtureDesktopSessions, fixtureDesktopTarget } from './fixtures/task-desktop.js';
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { createRootAssembly } from "../src/composition/root.js";
import { mountSessionScope } from "../src/composition/session-scope.js";
import { createShutdown } from "../src/composition/shutdown.js";
import { ExtensionRegistry } from "../src/contracts/extension.js";
import type { PlanningModel, ModelProvider } from "../src/contracts/model-provider.js";
import type { WorkerClient } from "../src/contracts/worker-client.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";
import { WorkflowStore } from "../src/workflows/store.js";
import { initialState } from "../src/graph/state.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "desktop-shutdown-"));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "agent-desktop-apps.json"), "[]");
  return dir;
}
function planning(fn: () => Promise<never>): ModelProvider {
  return { createModel: () => ({ name: "shutdown-test", kind: "rule", planTask: fn } as unknown as PlanningModel) };
}
function workerClient(close = async () => {}): WorkerClient {
  return { listWindows: async () => [], close } as unknown as WorkerClient;
}
async function worker(beforeControl: (mode: string) => Promise<void> = async () => {}) {
  const modes: string[] = [];
  let rejectControl = false;
  let mode = "paused";
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/state") { res.end(JSON.stringify({ vm_id: "vm" })); return; }
    if (req.url === "/frame") { res.end("{}"); return; }
    let raw = ""; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    modes.push(body.mode);
    await beforeControl(body.mode);
    if (rejectControl) { res.writeHead(503); res.end(JSON.stringify({ error: "offline" })); return; }
    mode = body.mode;
    res.end(JSON.stringify({ result: { mode, lease: mode === "human" ? "lease" : null, recovery_rpc: true } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    modes, mode: () => mode, reject: () => { rejectControl = true; },
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

for (const direct of [false, true]) test(`延迟撤权时${direct ? "直接 Cordis Root" : "装配层"}关闭必须等待 Session 落盘`, { timeout: 10000 }, async () => {
  const dir = directory(), entered = deferred(), release = deferred();
  const remote = await worker(async mode => {
    if (mode === "paused") { entered.resolve(); await release.promise; }
  });
  const assembly = await createRootAssembly({ rootDir: dir });
  const scope = mountSessionScope({ root: assembly.root, rootDir: dir, sessionId: "s", vmId: "vm",
    endpoint: remote.url, token: "", controlBus: assembly.controlBus, requireReconnect: false });
  await scope.fiber;
  try {
    await assembly.controlBus.dispatch("s", "browser", { command: "take" });
    const closing = direct ? assembly.root.fiber.dispose() : assembly.dispose();
    await entered.promise;
    // Actual SQLite-backed provider must still be usable while Guest acknowledgement is pending.
    assert.equal(assembly.desktop!.get("s")?.sessionId, "s");
    await assert.rejects(assembly.controlBus.dispatch("s", "browser", { command: "take" }));
    release.resolve(); await closing;
    await scope.dispose(); // No second cleanup against the now-closed provider.
    assert.equal(remote.mode(), "paused");
    assert.deepEqual(remote.modes, ["human", "paused"]);
    const db = new DatabaseSync(join(dir, "desktop-control.sqlite"));
    try {
      const row = db.prepare("SELECT value FROM control_state WHERE id='s'").get() as { value: string };
      assert.deepEqual(JSON.parse(row.value), { mode: "PAUSED", taskId: null, humanClient: null });
      const events = db.prepare("SELECT kind FROM control_events WHERE kind LIKE 'closed_%'").all();
      assert.deepEqual(events.map(row => row.kind), ["closed_confirmed"]);
    } finally { db.close(); }
  } finally {
    release.resolve(); await assembly.dispose(); await remote.close(); rmSync(dir, { recursive: true, force: true });
  }
});

for (const individual of [false, true]) test(`运行中任务${individual ? "随 Session" : "随 Root"}卸载时保留控制对象至收尾`, { timeout: 15000 }, async () => {
  const dir = directory(); const remote = await worker();
  const started = deferred(), release = deferred();
  const events: string[] = [];
  let openTraces = 0, openWorkflows = 0;
  let boundControl: import("../src/contracts/desktop-provider.js").InputControl;
  const assembly = await createRootAssembly({ rootDir: dir,
    model: planning(async () => { started.resolve(); await release.promise; throw new Error("PLAN_HALT"); }),
    desktopSessions: fixtureDesktopSessions(async () => workerClient(async () => { events.push("worker_closed"); }), {
      workerEndpoint: () => boundControl.workerEndpoint(), assertTaskAllowed: id => boundControl.assertTaskAllowed(id),
      beginTask: id => boundControl.beginTask(id), finishTask: (id, status) => boundControl.finishTask(id, status),
    }, () => boundControl),
    traceStore: (path) => {
      const trace = new SqliteTrace(path); openTraces++;
      const close = trace.close.bind(trace);
      trace.close = () => { openTraces--; close(); };
      return trace;
    },
    workflowStore: (path) => {
      const store = new WorkflowStore(path); openWorkflows++;
      const close = store.close.bind(store);
      store.close = () => { openWorkflows--; close(); };
      return store;
    },
  });
  const scope = mountSessionScope({ root: assembly.root, rootDir: dir, sessionId: "s", vmId: "vm",
    endpoint: remote.url, token: "", controlBus: assembly.controlBus, requireReconnect: false });
  await scope.fiber;
  const control = scope.control!; boundControl = control;
  const finish = control.finishTask.bind(control);
  control.finishTask = async (...args) => { events.push("finish_task"); return finish(...args); };
  try {
    assembly.controller.submit("test", { desktopTarget: fixtureDesktopTarget }); await started.promise;
    const closing = individual ? scope.dispose() : assembly.dispose();
    release.resolve(); await closing;
    assert.deepEqual(events, ["worker_closed", "finish_task"]);
    assert.equal(remote.mode(), "paused");
    assert.equal(openTraces, 0); assert.equal(openWorkflows, 0);
    if (individual) assert.equal(assembly.controller.getDesktopControl(), undefined);
  } finally {
    release.resolve(); await assembly.dispose(); await remote.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("关闭统一队列时同时取消专用扩展和通用任务，并保留各自记录", async () => {
  const dir = directory(), started = deferred(), release = deferred();
  const registry = new ExtensionRegistry(); let executed = 0;
  registry.register({ id: "test", capabilities: [{ id: "test.run", matches: (g) => g === "extension",
    prepare: (goal) => ({ kind: "specialized", goal, plan: [], environment: "browser", facts: {}, operations: [] }),
    submit(request, enqueue) {
      const trace = new SqliteTrace(join(dir, "web-tasks.sqlite"));
      try { trace.save("queued", { ...initialState("specialized", request.goal), executorId: "test.run" }); }
      finally { trace.close(); }
      enqueue(async () => { executed++; }); return "specialized";
    },
  }] });
  const assembly = await createRootAssembly({ rootDir: dir, extensionRegistry: registry,
    model: planning(async () => { started.resolve(); await release.promise; throw new Error("PLAN_HALT"); }),
    workerClientFactory: async () => workerClient(),
  });
  try {
    assembly.controller.submit("VM: first"); await started.promise;
    const specialized = assembly.controller.submit("extension");
    const generic = assembly.controller.submit("VM: second");
    const closing = assembly.dispose(); release.resolve(); await closing;
    assert.equal(executed, 0);
    const trace = new SqliteTrace(join(dir, "web-tasks.sqlite"));
    try {
      for (const id of [specialized, generic]) {
        assert.equal(trace.load(id)?.status, "failed");
        assert.match(trace.load(id)?.error ?? "", /任务已取消/);
      }
    } finally { trace.close(); }
  } finally { release.resolve(); await assembly.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test("WebSocket 在线时主动关闭 Dashboard，不等待浏览器先断开", { timeout: 10000 }, async () => {
  const dir = directory(), remote = await worker();
  const assembly = await createRootAssembly({ rootDir: dir });
  const scope = mountSessionScope({ root: assembly.root, rootDir: dir, sessionId: "s", vmId: "vm",
    endpoint: remote.url, token: "", controlBus: assembly.controlBus, requireReconnect: false });
  await scope.fiber;
  const server = createServer(); assembly.desktop!.attach(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const ws = new WebSocket(`${origin.replace("http", "ws")}/api/desktop/sessions/s/stream`, { origin });
  ws.on("error", () => {});
  const shutdown = createShutdown(server, assembly);
  try {
    await new Promise<void>((r, reject) => { ws.once("open", r); ws.once("error", reject); });
    await assembly.controlBus.dispatch("s", "browser", { command: "take" });
    const disconnected = new Promise<void>((r) => ws.once("close", () => r()));
    const first = shutdown(); assert.equal(shutdown(), first);
    await first; await disconnected;
    assert.equal(server.listening, false); assert.equal(remote.mode(), "paused");
    assert.throws(() => assembly.controller.submit("VM: x"), /已关闭/);
    // Prove the listener is released, rather than merely reporting listening=false.
    const replacement = createServer();
    await new Promise<void>((r, reject) => { replacement.once("error", reject); replacement.listen(Number(new URL(origin).port), "127.0.0.1", r); });
    await new Promise<void>((r) => replacement.close(() => r()));
  } finally { ws.terminate(); await shutdown(); await remote.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const stopped of [false, true]) test(`撤权失败保留${stopped ? "STOPPED" : "ERROR"}并记录未确认`, async () => {
  const dir = directory(), remote = await worker();
  const assembly = await createRootAssembly({ rootDir: dir });
  const scope = mountSessionScope({ root: assembly.root, rootDir: dir, sessionId: "s", vmId: "vm",
    endpoint: remote.url, token: "", controlBus: assembly.controlBus, requireReconnect: false });
  await scope.fiber;
  try {
    await assembly.controlBus.dispatch("s", "client", { command: stopped ? "emergency" : "take" });
    remote.reject(); await scope.dispose();
    assert.equal(remote.modes.at(-1), stopped ? "stopped" : "paused");
    const db = new DatabaseSync(join(dir, "desktop-control.sqlite"));
    try {
      const row = db.prepare("SELECT value FROM control_state WHERE id='s'").get() as { value: string };
      const state = JSON.parse(row.value);
      assert.equal(state.mode, stopped ? "STOPPED" : "ERROR");
      assert.equal(state.humanClient, null); assert.match(state.error, /未确认/);
    } finally { db.close(); }
  } finally { await assembly.dispose(); await remote.close(); rmSync(dir, { recursive: true, force: true }); }
});
