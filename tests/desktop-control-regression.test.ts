import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import WebSocket from "ws";
import { DesktopControl } from "../src/desktop-session/control.js";
import { DesktopSessionManager } from "../src/desktop-session/session-manager.js";
import { GuestDesktopRuntime } from "../src/runtime/desktop/guest-runtime.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

test("emergency invalidates queued pause and resume in screenshot wait; reset is required", async () => {
  const dir = await mkdtemp(join(tmpdir(), "control-race-"));
  const entered = deferred(), release = deferred(), frameEntered = deferred(), frameRelease = deferred();
  let workerMode = "paused";
  const worker = createServer(async (req, res) => {
    if (req.url === "/frame") {
      frameEntered.resolve(); await frameRelease.promise; res.writeHead(503).end(); return;
    }
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url === "/human-input") { entered.resolve(); await release.promise; }
    else workerMode = body.mode;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ result: { mode: workerMode, lease: workerMode === "human" ? "lease" : null } }));
  });
  await new Promise<void>(r => worker.listen(0, "127.0.0.1", r));
  const address = worker.address(); if (!address || typeof address === "string") throw Error("port");
  const sessions = new DesktopSessionManager(dir, "secret");
  sessions.register("vm", `http://127.0.0.1:${address.port}`, "s");
  let resumed = 0;
  const control = new DesktopControl(dir, sessions, "s", "secret", {
    submit: () => "", pause: () => {}, resume: () => {}, continue: () => { resumed++; },
  });
  try {
    await control.command("a", "take");
    const input = control.input("a", { kind: "click" }); await entered.promise;
    const queued = assert.rejects(control.command("a", "pause"), /紧急停止/);
    await control.command("a", "emergency");
    release.resolve(); await input; await queued;
    assert.equal(workerMode, "stopped"); assert.equal(control.view().mode, "STOPPED");
    await assert.rejects(control.command("a", "pause"), /重置/);
    await assert.rejects(control.command("a", "take"), /重置/);
    await control.command("a", "reset");
    await control.beginTask("task"); await control.finishTask("task", "paused");
    await control.command("a", "take");
    const resume = assert.rejects(control.command("a", "resume"), /紧急停止/);
    await frameEntered.promise; await control.command("a", "emergency");
    frameRelease.resolve(); await resume;
    assert.equal(resumed, 0); assert.equal(control.view().mode, "STOPPED");
    assert.equal(workerMode, "stopped");
  } finally {
    release.resolve(); frameRelease.resolve(); await control.close(); await sessions.close();
    await new Promise<void>(r => worker.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("current Session endpoint is used after VM address changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "endpoint-change-"));
  let stateReads = 0;
  const worker = createServer((req, res) => {
    if (req.url === "/state") stateReads++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ vm_id: "vm", action_rpc: true, result: { released: true } }));
  });
  await new Promise<void>(r => worker.listen(0, "127.0.0.1", r));
  const addr = worker.address(); if (!addr || typeof addr === "string") throw Error("port");
  const sessions = new DesktopSessionManager(dir, "secret"); sessions.register("vm", "http://127.0.0.1:1", "s");
  const control = new DesktopControl(dir, sessions, "s", "secret", {
    submit: () => "", pause: () => {}, resume: () => {}, continue: () => {},
  });
  try {
    assert.equal(control.workerEndpoint(), "http://127.0.0.1:1");
    sessions.updateWorkerEndpoint("s", `http://127.0.0.1:${addr.port}`);
    const runtime = await GuestDesktopRuntime.connect(control.workerEndpoint(), "secret", "vm", dir);
    assert.equal(stateReads, 1); await runtime.close();
  } finally {
    await control.close(); await sessions.close(); await new Promise<void>(r => worker.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed and oversized WebSocket messages do not crash dashboard", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-validation-"));
  const sessions = new DesktopSessionManager(dir, "secret"); sessions.register("vm", "http://127.0.0.1:1", "s");
  let calls = 0;
  sessions.controlMessage = async () => { calls++; return { mode: "PAUSED" }; };
  const server = createServer(); sessions.attach(server);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const addr = server.address(); if (!addr || typeof addr === "string") throw Error("port");
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/api/desktop/sessions/s/stream`, { origin: `http://127.0.0.1:${addr.port}` });
  try {
    await new Promise<void>(r => ws.on("open", r));
    const reply = new Promise<void>(resolve => ws.on("message", data => {
      const message = JSON.parse(data.toString()); if (message.requestId === "valid") resolve();
    }));
    for (const value of [null, [], 42, {}, { command: "pause", requestId: {} }]) ws.send(JSON.stringify(value));
    ws.send(JSON.stringify({ command: "pause", requestId: "valid" })); await reply;
    assert.equal(calls, 1);
    const closed = new Promise<void>(r => ws.on("close", () => r())); ws.send("x".repeat(9000)); await closed;
    assert.equal(server.listening, true);
  } finally {
    ws.terminate(); await sessions.close(); await new Promise<void>(r => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
