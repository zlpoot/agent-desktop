import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createDashboardServer } from "../src/app/server.js";
import { DesktopTaskController } from "../src/app/task-runner.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";

const site = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const q = url.searchParams.get("q") ?? "";
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  if (url.pathname === "/item") response.end(`<h1>商品详情：${q}</h1>`);
  else if (url.pathname === "/results") response.end(`<h1>搜索结果：${q}</h1><a href="/item?q=${encodeURIComponent(q)}">查看${q}详情</a>`);
  else response.end(`<h1>本地商品搜索</h1><form action="/results"><label>搜索商品<input name="q"></label><button>搜索</button></form>`);
});
await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
const siteAddress = site.address();
if (!siteAddress || typeof siteAddress === "string") throw new Error("测试网站未启动");
const root = resolve(".artifacts", "web-generic-smoke", randomUUID());
await mkdir(root, { recursive: true });
const dashboard = createDashboardServer(root, new DesktopTaskController(root));
await new Promise<void>((done) => dashboard.listen(0, "127.0.0.1", done));
const dashboardAddress = dashboard.address();
if (!dashboardAddress || typeof dashboardAddress === "string") throw new Error("仪表盘未启动");
const base = `http://127.0.0.1:${dashboardAddress.port}`;
try {
  const goal = `打开 http://127.0.0.1:${siteAddress.port}，搜索 苹果 并打开结果，确认显示 商品详情：苹果`;
  const response = await fetch(`${base}/api/tasks`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ goal }) });
  if (response.status !== 202) throw new Error(`提交失败：${await response.text()}`);
  const { taskId } = await response.json() as { taskId: string };
  let status = "running";
  let error: string | undefined;
  const started = Date.now();
  while (Date.now() - started < 120000) {
    await new Promise((done) => setTimeout(done, 1000));
    const run = await fetch(`${base}/api/runs/web-tasks.sqlite/${taskId}`);
    const data = await run.json() as { status: string; error?: string };
    status = data.status; error = data.error;
    if (["done", "failed", "waiting_user"].includes(status)) break;
  }
  const trace = new SqliteTrace(resolve(root, "web-tasks.sqlite"));
  const events = trace.events(taskId).map((event) => event.node);
  const modelCalls = trace.metrics(taskId).filter((metric) => metric.actor === "model").length;
  trace.close();
  console.log(JSON.stringify({ taskId, status, error, modelCalls, events: events.filter((event) =>
    ["plan", "workflow_search", "workflow_fallback", "finish"].includes(event)) }));
  console.log(`轨迹目录：${root}`);
  if (status !== "done") process.exitCode = 1;
} finally {
  await new Promise<void>((done) => dashboard.close(() => done()));
  await new Promise<void>((done) => site.close(() => done()));
}
