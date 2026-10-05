import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DesktopControl } from "../src/desktop-session/control.js";
import { DesktopSessionManager } from "../src/desktop-session/session-manager.js";
import { createDashboardServer } from "../src/app/server.js";
import { initialState } from "../src/graph/state.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";

test("D3 input ownership: pause boundary, two tabs, resume, stop and disconnected owner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "desktop-control-"));
  let workerMode = "paused", lease = "", humanEvents = 0;
  const worker = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer secret");
    if (req.url === "/frame") { res.writeHead(503).end(); return; }
    let raw = ""; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/control") {
      workerMode = body.mode; lease = workerMode === "human" ? `lease-${body.revision}` : "";
      res.end(JSON.stringify({ result: { mode: workerMode, lease } }));
    } else {
      assert.equal(workerMode, "human"); assert.equal(body.lease, lease); humanEvents++;
      res.end(JSON.stringify({ result: { ok: true } }));
    }
  });
  await new Promise<void>(resolve => worker.listen(0, "127.0.0.1", resolve));
  const address = worker.address(); if (!address || typeof address === "string") throw new Error("port");
  const sessions = new DesktopSessionManager(dir, "secret");
  sessions.register("vm", `http://127.0.0.1:${address.port}`, "session");
  const pauses: string[] = [], resumes: string[] = [];
  const control = new DesktopControl(dir, sessions, "session", "secret", {
    submit: () => "", resume: () => {}, pause: id => { pauses.push(id); }, continue: id => { resumes.push(id); },
  });
  try {
    await control.command("a", "take");
    await assert.rejects(control.beginTask("task"), /接管/);
    await assert.rejects(control.input("b", { kind: "click" }), /输入权/);
    await control.input("a", { kind: "click" }); assert.equal(humanEvents, 1);
    await control.disconnect("b"); assert.equal(control.view().mode, "HUMAN_CONTROL");
    await control.disconnect("a"); assert.equal(workerMode, "paused");
    await assert.rejects(control.input("a", {}), /输入权/);
    await control.beginTask("task");
    const firstEpoch = control.agentEpoch();
    assert.equal(typeof firstEpoch, 'number');
    await control.command("a", "pause"); assert.deepEqual(pauses, ["task"]);
    assert.equal(control.view().mode, "PAUSING");
    await assert.rejects(control.command("a", "take"), /等待暂停/);
    await control.finishTask("task", "paused");
    assert.equal(control.agentEpoch(), undefined);
    await control.command("a", "take");
    await assert.rejects(control.command("b", "resume"), /接管页面/);
    await control.command("a", "resume"); assert.deepEqual(resumes, ["task"]);
    assert.equal(workerMode, "paused");
    await control.beginTask("task"); assert.equal(workerMode, "agent");
    assert.ok(control.agentEpoch()! > firstEpoch!);
    await control.command("a", "emergency"); assert.equal(workerMode, "stopped");
    assert.equal(await control.finishTask("task", "paused"), true);
    assert.equal(control.view().taskId, null, "停止后的任务只保留在历史记录中");
    await assert.rejects(control.beginTask("task"), /已停止/);
    await control.command("a", "reset"); assert.equal(control.view().taskId, null);
    assert.ok(control.view().events.some(event => event.kind === "reset"));
    await control.beginTask("next");
    await control.command("a", "stop");
    assert.equal(await control.finishTask("next", "paused"), true);
    assert.equal(control.view().mode, "STOPPED");
    assert.equal(control.view().taskId, null, "普通停止也不再占用当前任务");
  } finally {
    await control.close(); await sessions.close();
    await new Promise<void>(resolve => worker.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("Host 重启后旧 STOPPED 任务只保留历史，不继续占用当前任务", async () => {
  const dir = await mkdtemp(join(tmpdir(), "desktop-stopped-restart-"));
  const sessions = new DesktopSessionManager(dir, "secret");
  sessions.register("vm", "http://127.0.0.1:8765", "session");
  const trace = new SqliteTrace(join(dir, "web-tasks.sqlite"));
  trace.save("stop", { ...initialState("old-task", "旧任务"), status: "stopped" });
  trace.close();
  const db = new DatabaseSync(join(dir, "desktop-control.sqlite"));
  db.exec("CREATE TABLE control_state (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO control_state VALUES (?, ?)").run("session",
    JSON.stringify({ mode: "STOPPED", taskId: "old-task", humanClient: null }));
  db.close();
  const control = new DesktopControl(dir, sessions, "session", "secret", {
    submit: () => "", resume() {}, pause() {}, continue() {},
  });
  try {
    assert.equal(control.view().mode, "STOPPED");
    assert.equal(control.view().taskId, null);
    const history = new SqliteTrace(join(dir, "web-tasks.sqlite"));
    try { assert.equal(history.load("old-task")?.status, "stopped"); }
    finally { history.close(); }
    await assert.rejects(control.beginTask("new-task"), /已停止/);
  } finally {
    await control.close(); await sessions.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("D3 browser sends normalized pointer and Unicode text only after taking control", async () => {
  const dir = await mkdtemp(join(tmpdir(), "desktop-control-ui-"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
  const events: Array<Record<string, unknown>> = [];
  const worker = createServer(async (req, res) => {
    if (req.url === "/frame") { res.writeHead(200, { "Content-Type": "image/png" }).end(png); return; }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/state") { res.end(JSON.stringify({ vm_id: "vm" })); return; }
    let raw = ""; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    if (req.url === "/human-input") events.push(body.event);
    res.end(JSON.stringify({ result: req.url === "/control"
      ? { mode: body.mode, lease: body.mode === "human" ? "lease" : null } : { ok: true } }));
  });
  await new Promise<void>(resolve => worker.listen(0, "127.0.0.1", resolve));
  const wa = worker.address(); if (!wa || typeof wa === "string") throw new Error("port");
  const sessions = new DesktopSessionManager(dir, "secret", 100);
  sessions.register("vm", `http://127.0.0.1:${wa.port}`, "s");
  const control = new DesktopControl(dir, sessions, "s", "secret", {
    submit: () => "", resume: () => {}, pause: () => {}, continue: () => {},
  });
  sessions.controlMessage = (_id, client, raw) => {
    const body = raw as { command: string; event: unknown };
    return body.command === "input" ? control.input(client, body.event) : control.command(client, body.command);
  };
  sessions.controlDisconnected = client => control.disconnect(client);
  const dashboard = createDashboardServer(dir, undefined, sessions, undefined, control);
  sessions.attach(dashboard);
  await new Promise<void>(resolve => dashboard.listen(0, "127.0.0.1", resolve));
  const da = dashboard.address(); if (!da || typeof da === "string") throw new Error("port");
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(process.cwd(), ".playwright-browsers");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${da.port}`);
    await page.getByRole('button', { name: '桌面', exact: true }).click();
    await page.locator("#desktop-frame").waitFor({ state: "visible" });
    await page.locator('[data-desktop-command="take"]').click();
    await page.locator("#desktop-human-text").waitFor({ state: "visible" });
    await page.locator("#desktop-human-text").fill("人工接管测试");
    await page.locator("#desktop-send-text").click();
    await page.waitForFunction(() => document.querySelector('#desktop-control-events')?.textContent?.includes('human_input'));
    assert.deepEqual(events[0], { kind: "text", text: "人工接管测试" });
    await page.locator("#desktop-frame").evaluate((image: HTMLImageElement) => { image.style.width = "400px"; image.style.height = "200px"; });
    await page.locator("#desktop-frame").click({ position: { x: 200, y: 100 } });
    for (let i = 0; i < 50 && events.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(events[1]?.kind, "click");
    const point = events[1]?.point as { x: number; y: number };
    assert.ok(Math.abs(point.x - 0.5) < 0.01 && Math.abs(point.y - 0.5) < 0.01);
    await page.close();
    for (let i = 0; i < 50 && control.view().mode !== "PAUSED"; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(control.view().mode, "PAUSED");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise<void>(resolve => dashboard.close(() => resolve()));
    await control.close(); await sessions.close();
    await new Promise<void>(resolve => worker.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
