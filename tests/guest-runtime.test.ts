import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GuestDesktopRuntime } from "../src/runtime/desktop/guest-runtime.js";
import { singleProvider } from "../src/actions/action-resolution.js";
import { GuestAppSetupError, TargetWindowLostError, WorkerConnectionError } from '../src/contracts/worker-error.js';

test('应用启动失败与传输失败区分，兼容旧 Worker 的已知启动错误', async () => {
  let legacy = false, offline = false;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/state') return void res.end(JSON.stringify({ vm_id: 'vm', action_rpc: true }));
    res.writeHead(offline || legacy ? 503 : 422);
    res.end(JSON.stringify(offline ? { error: 'subprocess unavailable' } : legacy
      ? { error: 'Guest app did not become a visible foreground window' }
      : { code: 'APP_SETUP_FAILED', error: 'unique window missing' }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const runtime = await GuestDesktopRuntime.connect(`http://127.0.0.1:${(server.address() as {port:number}).port}`, 'test', 'vm', '.artifacts');
    await assert.rejects(GuestDesktopRuntime.connect(
      `http://127.0.0.1:${(server.address() as {port:number}).port}`, 'test', 'vm', '.artifacts', 7),
      /协议不兼容/);
    await assert.rejects(runtime.ensureApp('editor'), GuestAppSetupError);
    legacy = true; await assert.rejects(runtime.ensureApp('editor'), GuestAppSetupError);
    offline = true; await assert.rejects(runtime.ensureApp('editor'), WorkerConnectionError);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});

test('关闭的目标窗口是身份失效，不误报 Worker 断线', async () => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/state') {
      response.end(JSON.stringify({ vm_id: 'vm', action_rpc: true })); return;
    }
    response.writeHead(503);
    response.end(JSON.stringify({ error: 'RuntimeError: 绑定的窗口已关闭' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const runtime = await GuestDesktopRuntime.connect(
      `http://127.0.0.1:${(server.address() as { port: number }).port}`, 'test', 'vm', '.artifacts');
    await assert.rejects(runtime.observe(), TargetWindowLostError);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");

test("Guest action RPC binds one window and returns local observation evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-desktop-action-"));
  const calls: string[] = [];
  let frameUnavailable = false;
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer secret") { response.writeHead(401).end(); return; }
    response.setHeader("content-type", "application/json");
    if (request.url === "/state") {
      response.end(JSON.stringify({ vm_id: "vm-id", action_rpc: true,
        control_epoch_rpc: true, action_id_rpc: true })); return;
    }
    if (request.url === "/frame") {
      if (frameUnavailable) { response.writeHead(503).end(); return; }
      response.setHeader("content-type", "image/png"); response.end(png); return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body) as { method: string; vmId: string; controlEpoch?: number;
      args: Record<string, unknown> };
    assert.equal(rpc.vmId, "vm-id");
    assert.equal(rpc.controlEpoch, 123);
    if (rpc.method === 'execute') assert.equal(rpc.args.actionId, 'task:step:provider');
    calls.push(rpc.method);
    const result = rpc.method === "observe"
      ? { windowTitle: "Notepad", windowHandle: 7, screenshot: "C:\\guest\\image.png" }
      : rpc.method === "execute"
        ? { ok: true, message: "done", effect: "dispatched", observation: {
          windowTitle: "Notepad", windowHandle: 7, screenshot: "C:\\guest\\after.png" } }
        : rpc.method === "probe"
          ? { foreground: true, permissionsCompatible: true }
          : { handle: 7, title: "Notepad" };
    response.end(JSON.stringify({ result,
      ...(["observe", "execute"].includes(rpc.method) ? { screenshotBase64: png.toString("base64") } : {}) }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  try {
    const runtime = await GuestDesktopRuntime.connect(`http://127.0.0.1:${address.port}`, "secret",
      "vm-id", dir, 123);
    await runtime.attach({ windowHandle: 7 });
    const before = await runtime.observe();
    assert.deepEqual(readFileSync(before.screenshot!), png);
    assert.deepEqual(readFileSync(before.desktopScreenshot!), png);
    assert.notEqual(before.screenshot, before.desktopScreenshot);
    assert.ok(before.desktopCapturedAt);
    await runtime.recoverFocus();
    assert.throws(() => runtime.execute({ kind: "keypress", keys: "escape" }), /执行器授权/);
    const result = await runtime.execute({ kind: "keypress", keys: "escape" },
      singleProvider("windows.pyautogui.act", "test"), 'task:step:provider');
    assert.equal(result.ok, true);
    assert.deepEqual(readFileSync(result.observation!.screenshot!), png);
    frameUnavailable = true;
    const fallback = await runtime.observe();
    assert.ok(fallback.screenshot);
    assert.equal(fallback.desktopScreenshot, undefined);
    assert.match(fallback.desktopCaptureError!, /503/);
    await runtime.close();
    assert.deepEqual(calls, ["init", "observe", "probe", "execute", "observe", "release"]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Guest runtime rejects an observe-only or wrong VM worker", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ vm_id: "other-vm" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  try {
    await assert.rejects(GuestDesktopRuntime.connect(`http://127.0.0.1:${address.port}`,
      "secret", "vm-id", tmpdir()), /身份校验失败/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
