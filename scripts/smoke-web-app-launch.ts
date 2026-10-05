import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDashboardServer } from "../src/app/server.js";
import { DesktopTaskController } from "../src/app/task-runner.js";
import { WindowManager } from "../src/runtime/desktop/window-manager.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";

const suffix = randomUUID();
const root = resolve(".artifacts", "web-app-launch-smoke", suffix);
await mkdir(root, { recursive: true });
const exe = resolve(root, "fixture.exe");
const compiled = spawnSync("C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
  ["/nologo", "/target:winexe", `/out:${exe}`, "/reference:System.Windows.Forms.dll",
    "/reference:System.Drawing.dll", resolve("scripts/desktop-fixture.cs")], { encoding: "utf8" });
if (compiled.status !== 0) throw new Error(`测试应用编译失败：${compiled.stdout}${compiled.stderr}`);
const title = `Computer Use M5 验证窗口 ${suffix}`;
await writeFile(resolve(root, "apps.local.json"), JSON.stringify([{ id: "fixture", name: "测试窗口",
  executable: exe, args: [suffix], windowTitle: title }]));

const model = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    messages?: Array<{ content?: unknown }>;
  };
  const instruction = String(body.messages?.[0]?.content ?? "");
  const content = instruction.includes("任务规划器")
    ? JSON.stringify({ environment: "windows", appId: "fixture", plan: ["启动测试窗口"],
      completionCriteria: { windowTitleIncludes: title } })
    : instruction.includes("屏幕文字识别器")
      ? JSON.stringify({ text: "" })
      : JSON.stringify({ kind: "done", summary: "测试窗口已启动" });
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ choices: [{ message: { content } }],
    usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }));
});
await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
const modelAddress = model.address();
if (!modelAddress || typeof modelAddress === "string") throw new Error("模拟模型服务未启动");
const oldBase = process.env.COMPUTER_USE_BASE_URL;
const oldKey = process.env.COMPUTER_USE_API_KEY;
process.env.COMPUTER_USE_BASE_URL = `http://127.0.0.1:${modelAddress.port}/v1`;
process.env.COMPUTER_USE_API_KEY = "local-test-key";
const dashboard = createDashboardServer(root, new DesktopTaskController(root));
await new Promise<void>((done) => dashboard.listen(0, "127.0.0.1", done));
const address = dashboard.address();
if (!address || typeof address === "string") throw new Error("Web 服务未启动");
const base = `http://127.0.0.1:${address.port}`;
try {
  const submitted = await fetch(`${base}/api/tasks`, { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal: "启动已登记的测试窗口" }) });
  if (submitted.status !== 202) throw new Error(`提交失败：${await submitted.text()}`);
  const { taskId } = await submitted.json() as { taskId: string };
  let state: { status?: string; error?: string } = {};
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 300));
    state = await (await fetch(`${base}/api/runs/web-tasks.sqlite/${taskId}`)).json() as typeof state;
    if (state.status === "done" || state.status === "failed" || state.status === "waiting_user") break;
  }
  const trace = new SqliteTrace(resolve(root, "web-tasks.sqlite"));
  try {
    const operators = trace.metrics(taskId).map((metric) => metric.operator);
    console.log(JSON.stringify({ taskId, status: state.status, error: state.error,
      launched: operators.includes("windows.app.ensure"), root }));
    if (state.status !== "done" || !operators.includes("windows.app.ensure")) process.exitCode = 1;
  } finally { trace.close(); }
} finally {
  await new Promise<void>((done) => dashboard.close(() => done()));
  await new Promise<void>((done) => model.close(() => done()));
  if (oldBase === undefined) delete process.env.COMPUTER_USE_BASE_URL;
  else process.env.COMPUTER_USE_BASE_URL = oldBase;
  if (oldKey === undefined) delete process.env.COMPUTER_USE_API_KEY;
  else process.env.COMPUTER_USE_API_KEY = oldKey;
  const windows = await new WindowManager(resolve(root, "screenshots")).list({ windowTitle: title }).catch(() => []);
  for (const window of windows) if (window.processPath?.toLowerCase() === exe.toLowerCase()) process.kill(window.processId);
}
