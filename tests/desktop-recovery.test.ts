import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";
import { initialState } from "../src/graph/state.js";
import { recoverDesktopTasks, restartedDesktopState } from "../src/desktop-session/recovery.js";
import { createAgentLoop } from "../src/graph/graph.js";
import { FakeModel } from "../src/agent/model-adapter.js";
import { DesktopControl } from "../src/desktop-session/control.js";
import { DesktopSessionManager } from "../src/desktop-session/session-manager.js";
import { TargetWindowLostError, WorkerConnectionError } from "../src/contracts/worker-error.js";

test("Host restart restores parked task and freezes worker; old human lease is not restored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "host-restart-"));
  let resets = 0;
  const server = createServer(async (req, res) => {
    if (req.url === "/state") { res.end(JSON.stringify({ vm_id: "vm", action_rpc: true, control_rpc: true,
      recovery_rpc: true, control_epoch_rpc: true, action_id_rpc: true, recovery_epoch: "epoch",
      ready_for_observation: true, ready_for_input: true, blocked_reason: null })); return; }
    if (req.url === "/frame") { res.end(Buffer.from("89504e470d0a1a0a", "hex")); return; }
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (body.resetTask) { resets++; assert.equal(body.mode, "paused"); }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ result: { mode: body.mode, recovery_rpc: true, lease: body.mode === "human" ? "lease" : null } }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const addr = server.address(); if (!addr || typeof addr === "string") throw Error("port");
  const tasks = { submit: () => "", pause: () => {}, resume: () => {}, continue: () => {} };
  const sessions = new DesktopSessionManager(dir, "token");
  sessions.register("vm", `http://127.0.0.1:${addr.port}`, "s");
  let control = new DesktopControl(dir, sessions, "s", "token", tasks);
  try {
    const trace = new SqliteTrace(join(dir, "web-tasks.sqlite"));
    trace.save("queued", { ...initialState("task", "old task"), desktopVmId: "vm" }); trace.close();
    await control.beginTask("task"); await control.finishTask("task", "paused"); await control.command("old", "take");
    await control.close(); recoverDesktopTasks(dir);
    control = new DesktopControl(dir, sessions, "s", "token", tasks, true);
    assert.equal(control.view().taskId, "task"); assert.equal(control.view().mode, "PAUSED");
    assert.equal(control.view().humanClient, null); assert.equal(control.view().workerReady, false);
    await assert.rejects(control.input("old", { kind: "text", text: "never" }));
    await control.reconnect(); await control.reconnect(); assert.equal(resets, 1);
    assert.equal(control.view().workerReady, true);
    assert.equal(control.view().task?.status, "paused");
  } finally {
    await control.close(); await sessions.close(); await new Promise<void>(r => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("restart uses fresh observation on new checkpoint thread, preserving stage/workflow data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recovery-graph-"));
  let trace = new SqliteTrace(join(dir, "web-tasks.sqlite"));
  const checkpoint = SqliteSaver.fromConnString(join(dir, "checkpoint.sqlite"));
  try {
    trace.save("dispatch_pending", { ...initialState("task", "VM: complete", undefined, { pageTextIncludes: "complete" }),
      desktopVmId: "vm", inFlightAction: { kind: "keypress", keys: "enter" },
      completedStages: [{ id: "s1", goal: "stage", successCondition: "done", startStep: 0, endStep: 2, evidence: "e", source: "uia" }],
      workflowRef: { id: "w", version: 3, values: {} }, step: 3 });
    trace.close(); recoverDesktopTasks(dir); trace = new SqliteTrace(join(dir, "web-tasks.sqlite"));
    const saved = trace.load("task")!; assert.equal(saved.recoveryRequired, true);
    const recovered = restartedDesktopState(saved);
    assert.equal(recovered.completedStages?.length, 1); assert.equal(recovered.workflowRef?.version, 3);
    assert.equal(recovered.lastAction, undefined); assert.notEqual(recovered.checkpointThreadId, "task");
    assert.deepEqual(recovered.checkpointLineage?.map(link => [link.from, link.to]),
      [["task", recovered.checkpointThreadId]]);
    let executions = 0;
    const graph = createAgentLoop({ trace, checkpointer: checkpoint, model: new FakeModel([]),
      runtime: { observe: async () => ({ pageText: "complete" }), execute: async () => { executions++; throw Error("stale action"); } } });
    const result = await graph.invoke(recovered, { configurable: { thread_id: recovered.checkpointThreadId } });
    assert.equal(result.status, "done"); assert.equal(executions, 0);
  } finally { checkpoint.db.close(); trace.close(); await rm(dir, { recursive: true, force: true }); }
});

test("uncertain dispatch after crash asks human instead of repeating; stopped tasks stay stopped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recovery-uncertain-"));
  const trace = new SqliteTrace(join(dir, "web-tasks.sqlite"));
  const checkpoint = SqliteSaver.fromConnString(join(dir, "checkpoint.sqlite"));
  try {
    trace.save("stop", { ...initialState("stopped", "VM: old"), status: "stopped" });
    recoverDesktopTasks(dir); assert.equal(trace.load("stopped")?.status, "stopped");
    const recovered = restartedDesktopState({ ...initialState("task", "VM: complete", undefined, { pageTextIncludes: "complete" }),
      inFlightAction: { kind: "keypress", keys: "enter" }, retryCount: 2 });
    assert.equal(recovered.retryCount, 2);
    const graph = createAgentLoop({ trace, checkpointer: checkpoint, model: new FakeModel([]),
      runtime: { observe: async () => ({ pageText: "unknown" }), execute: async () => { throw Error("stale action"); } } });
    await graph.invoke(recovered, { configurable: { thread_id: recovered.checkpointThreadId } });
    assert.equal(trace.load("task")?.status, "waiting_user");
    assert.equal(trace.load("task")?.recoveryUncertain, true);
    assert.equal(restartedDesktopState(trace.load("task")!).recoveryUncertain, true);
  } finally { checkpoint.db.close(); trace.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const failure of ['observe', 'execute']) test(`Worker ${failure} 连接中断立即暂停，动作结果不确定时保留标记`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worker-failure-'));
  const trace = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
  const checkpoint = SqliteSaver.fromConnString(join(dir, 'checkpoint.sqlite'));
  let executed = 0;
  try {
    const graph = createAgentLoop({ trace, recoveryJournal: true, checkpointer: checkpoint,
      model: new FakeModel([{ kind: 'keypress', keys: 'space' }]),
      runtime: {
        observe: async () => { if (failure === 'observe') throw new WorkerConnectionError('offline'); return { pageText: 'before' }; },
        execute: async () => { executed++; throw new WorkerConnectionError('response lost'); },
      } });
    await graph.invoke(initialState('t', 'VM: test'), { configurable: { thread_id: 't' } });
    assert.equal(trace.load('t')?.status, 'paused'); assert.equal(trace.load('t')?.recoveryRequired, true);
    assert.equal(executed, failure === 'observe' ? 0 : 1);
    if (failure === 'execute') assert.equal(trace.load('t')?.recoveryUncertain, true);
  } finally { checkpoint.db.close(); trace.close(); await rm(dir, { recursive: true, force: true }); }
});

test('动作关闭原窗口时保留结果并暂停核对，不把它当成 Worker 断线或重复输入', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'closed-target-'));
  const trace = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
  const checkpoint = SqliteSaver.fromConnString(join(dir, 'checkpoint.sqlite'));
  let observations = 0, executions = 0;
  try {
    const graph = createAgentLoop({ trace, recoveryJournal: true, checkpointer: checkpoint,
      model: new FakeModel([{ kind: 'keypress', keys: 'enter' }]),
      runtime: {
        observe: async () => {
          if (++observations > 1) throw new TargetWindowLostError('绑定的窗口已关闭');
          return { pageText: 'before' };
        },
        execute: async () => { executions++; return { ok: true, message: 'sent', effect: 'dispatched' }; },
      } });
    await graph.invoke(initialState('t', 'VM: save'), { configurable: { thread_id: 't' } });
    const saved = trace.load('t')!;
    assert.equal(saved.status, 'paused');
    assert.equal(saved.recoveryRequired, true);
    assert.equal(saved.recoveryUncertain, true);
    assert.match(saved.summary!, /原目标窗口已关闭/);
    assert.equal(saved.lastResult?.ok, true);
    assert.equal(executions, 1);
  } finally { checkpoint.db.close(); trace.close(); await rm(dir, { recursive: true, force: true }); }
});
