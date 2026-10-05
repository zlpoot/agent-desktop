import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createDashboardServer } from "../src/app/server.js";
import { DesktopTaskController } from "../src/app/task-runner.js";
import { resolve } from "node:path";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";

const root = resolve(".artifacts", "web-vision-smoke", randomUUID());
await mkdir(root, { recursive: true });
const exe = resolve(".artifacts", "vision-fixture.exe");
const compiled = spawnSync("C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
  ["/nologo", "/target:winexe", `/out:${exe}`, "/reference:System.Windows.Forms.dll",
    "/reference:System.Drawing.dll", resolve("scripts/vision-fixture.cs")], { encoding: "utf8" });
if (compiled.status !== 0) throw new Error(`测试应用编译失败：${compiled.stdout}${compiled.stderr}`);
const suffix = randomUUID();
const fixture = spawn(exe, [suffix], { windowsHide: false, stdio: "ignore" });
const dashboard = createDashboardServer(root, new DesktopTaskController(root));
await new Promise<void>((done) => dashboard.listen(0, "127.0.0.1", done));
const address = dashboard.address();
if (!address || typeof address === "string") throw new Error("Web 任务服务未启动");
const base = `http://127.0.0.1:${address.port}`;
try {
  const goal = `在已打开的 Computer Use 视觉验证窗口 ${suffix} 中点击设置，看到设置页面文字`;
  const response = await fetch(`${base}/api/tasks`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ goal }) });
  if (response.status !== 202) throw new Error(`任务提交失败：${await response.text()}`);
  const { taskId } = await response.json() as { taskId: string };
  let state: { status?: string; error?: string; goalVerification?: { ok: boolean } } = {};
  const started = Date.now();
  while (Date.now() - started < 120000) {
    await new Promise((done) => setTimeout(done, 1000));
    state = await (await fetch(`${base}/api/runs/web-tasks.sqlite/${taskId}`)).json() as typeof state;
    if (["done", "failed", "waiting_user"].includes(state.status ?? "")) break;
  }
  const trace = new SqliteTrace(resolve(root, "web-tasks.sqlite"));
  const metrics = trace.metrics(taskId);
  console.log(JSON.stringify({ taskId, status: state.status, error: state.error,
    verified: state.goalVerification?.ok,
    events: trace.events(taskId).filter((event) => ["plan", "workflow_search", "finish"].includes(event.node))
      .map((event) => event.node),
    modelCalls: metrics.filter((metric) => metric.actor === "model").length,
    tokens: metrics.reduce((sum, metric) => sum + (metric.totalTokens ?? 0), 0) }));
  trace.close();
  console.log(`轨迹目录：${root}`);
  if (state.status !== "done") process.exitCode = 1;
} finally {
  await new Promise<void>((done) => dashboard.close(() => done()));
  fixture.kill();
}
