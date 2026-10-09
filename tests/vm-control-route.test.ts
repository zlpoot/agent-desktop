import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDashboardServer } from "../src/app/server.js";
import type { VmControl, VmStatus } from "../src/desktop-session/vm-control.js";

test("local dashboard can inspect and start its configured VM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-vm-route-"));
  let state = "Off";
  let starts = 0;
  let consoles = 0;
  const status = (): VmStatus => ({ name: "AgentDesktop", id: "00000000-0000-4000-8000-000000000001",
    state, ipv4: state === "Running" ? "192.0.2.10" : null });
  const control: VmControl = {
    status: async () => status(),
    start: async () => { starts++; state = "Running"; return status(); },
    openConsole: async () => { consoles++; },
  };
  const server = createDashboardServer(dir, undefined, undefined, control);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not start");
  const base = `http://127.0.0.1:${address.port}`;
  let browser: import("playwright").Browser | undefined;
  try {
    const before = await (await fetch(`${base}/api/desktop/vm`)).json();
    assert.equal(before.vm.state, "Off");
    const request = (origin?: string) => fetch(`${base}/api/desktop/vm/start`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: "{}",
    });
    assert.equal((await request()).status, 403);
    assert.equal((await request("http://other.example")).status, 403);
    assert.equal(starts, 0);
    const started = await request(base);
    assert.equal(started.status, 200);
    assert.equal((await started.json()).vm.state, "Running");
    assert.equal(starts, 1);
    const consoleResponse = await fetch(`${base}/api/desktop/vm/console`, {
      method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(consoleResponse.status, 200);
    assert.equal(consoles, 1);
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(process.cwd(), ".playwright-browsers");
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(base);
    await page.getByRole('button', { name: '环境与应用', exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#desktop-vm-state")?.textContent?.includes("Running"));
    await page.locator("#desktop-vm-console").click();
    await page.getByText("已打开虚拟机窗口").waitFor();
    assert.equal(consoles, 2);
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
