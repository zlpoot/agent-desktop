import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import WebSocket from "ws";
import { createDashboardServer } from "../src/app/server.js";
import { DesktopSessionManager } from "../src/desktop-session/session-manager.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");

test("Desktop Session 与任务分离，Worker 心跳和画面通过网页 WebSocket 到达", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-desktop-session-"));
  let guestAvailable = true;
  const guest = createServer((request, response) => {
    if (!guestAvailable) { response.writeHead(503).end(); return; }
    if (request.headers.authorization !== "Bearer test-secret") { response.writeHead(401).end(); return; }
    if (request.url === "/state") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vm_id: "vm-test" }));
    } else if (request.url === "/frame") {
      response.writeHead(200, { "content-type": "image/png" }); response.end(png);
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => guest.listen(0, "127.0.0.1", resolve));
  const guestAddress = guest.address();
  if (!guestAddress || typeof guestAddress === "string") throw new Error("guest server unavailable");
  const manager = new DesktopSessionManager(dir, "test-secret", 100);
  manager.register("vm-test", `http://127.0.0.1:${guestAddress.port}`, "session-test");
  manager.setCurrentTask("session-test", "task-a");
  const dashboard = createDashboardServer(dir, undefined, manager);
  manager.attach(dashboard);
  await new Promise<void>((resolve) => dashboard.listen(0, "127.0.0.1", resolve));
  const address = dashboard.address();
  if (!address || typeof address === "string") throw new Error("dashboard unavailable");
  const base = `http://127.0.0.1:${address.port}`;
  let browser: import("playwright").Browser | undefined;
  try {
    const frame = await new Promise<Buffer>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/desktop/sessions/session-test/stream`,
        { origin: base });
      const timeout = setTimeout(() => { ws.terminate(); reject(new Error("no desktop frame")); }, 3000);
      ws.on("message", (data, binary) => {
        if (!binary) return;
        clearTimeout(timeout); ws.close(); resolve(Buffer.from(data as Buffer));
      });
      ws.on("error", reject);
    });
    assert.deepEqual(frame, png);
    const list = await fetch(`${base}/api/desktop/sessions`);
    assert.equal(list.status, 200);
    const session = (await list.json()).sessions[0];
    assert.equal(session.status, "online");
    assert.equal(session.currentTaskId, "task-a");
    assert.ok(session.lastSeenAt);
    manager.setCurrentTask("session-test", null);
    assert.equal(manager.get("session-test")?.currentTaskId, null);
    assert.equal(manager.get("session-test")?.status, "online");
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(process.cwd(), ".playwright-browsers");
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(base);
    await page.getByRole('button', { name: '桌面', exact: true }).click();
    await page.locator("#desktop-frame").waitFor({ state: "visible", timeout: 5000 });
    await page.waitForFunction(() => (document.getElementById("desktop-frame") as HTMLImageElement).naturalWidth > 0);
    assert.equal(await page.locator("#desktop-frame").evaluate((image: HTMLImageElement) =>
      image.naturalWidth), 1);
    assert.match(await page.locator("#desktop-status").textContent() ?? "", /已连接/);
    guestAvailable = false;
    // A timer poll may already be in flight; poll() intentionally does not join it.
    const offlineDeadline = Date.now() + 5000;
    while (manager.get("session-test")?.status !== "offline" && Date.now() < offlineDeadline) {
      await manager.poll(); await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(manager.get("session-test")?.status, "offline");
    guestAvailable = true;
    const onlineDeadline = Date.now() + 5000;
    while (manager.get("session-test")?.status !== "online" && Date.now() < onlineDeadline) {
      await manager.poll(); await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(manager.get("session-test")?.status, "online");
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => dashboard.close(() => resolve()));
    await manager.close();
    const restored = new DesktopSessionManager(dir, "test-secret");
    assert.equal(restored.get("session-test")?.vmId, "vm-test");
    await restored.close();
    await new Promise<void>((resolve) => guest.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
