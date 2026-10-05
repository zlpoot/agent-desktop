import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDashboardServer } from "../src/app/server.js";
import type { TaskController } from "../src/app/task-runner.js";
import { initialState } from "../src/graph/state.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";

test("网页暂停与继续接口只改变指定任务的控制状态", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-task-controls-"));
  const path = join(dir, "web-tasks.sqlite");
  const trace = new SqliteTrace(path);
  trace.save("queued", initialState("control-1", "进入炉石传说佣兵之书第一关"));
  const controller: TaskController = {
    submit() { throw new Error("不提交新任务"); },
    resume() { throw new Error("不需要人工审批"); },
    pause(id) { assert.equal(id, "control-1"); trace.requestPause(id); },
    continue(id) { assert.equal(id, "control-1"); trace.clearPause(id);
      trace.save("continue", initialState(id, "进入炉石传说佣兵之书第一关")); },
  };
  const server = createDashboardServer(dir, controller);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("服务未启动");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const request = (action: string, origin?: string) => fetch(`${base}/api/tasks/control-1/${action}`,
      { method: "POST", headers: { "Content-Type": "application/json",
        ...(origin ? { Origin: origin } : {}) }, body: "{}" });
    assert.equal((await request("pause", "http://evil.example")).status, 403);
    assert.equal((await request("pause")).status, 202);
    const paused = await (await fetch(`${base}/api/runs/web-tasks.sqlite/control-1`)).json();
    assert.equal(paused.status, "pause_requested");
    assert.equal((await request("continue")).status, 202);
    const resumed = await (await fetch(`${base}/api/runs/web-tasks.sqlite/control-1`)).json();
    assert.equal(resumed.status, "running");
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    trace.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
