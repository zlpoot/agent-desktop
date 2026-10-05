import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { configuredModel } from "../src/agent/local-config.js";
import { runTaskAgent } from "../src/agent/task-agent.js";
import { PlaywrightRuntime } from "../src/runtime/browser/playwright-runtime.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";
import { WorkflowStore } from "../src/workflows/store.js";

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const q = url.searchParams.get("q") ?? "";
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  if (url.pathname === "/item") {
    response.end(`<h1>商品详情：${q}</h1>`);
  } else if (url.pathname === "/results") {
    response.end(`<h1>搜索结果：${q}</h1><a href="/item?q=${encodeURIComponent(q)}">查看${q}详情</a>`);
  } else {
    response.end(`<h1>本地商品搜索</h1><form action="/results"><label>搜索商品<input name="q"></label><button>搜索</button></form>`);
  }
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (!address || typeof address === "string") throw new Error("本地测试页未启动");
const base = `http://127.0.0.1:${address.port}`;
const dir = resolve(".artifacts", "workflow-smoke", randomUUID());
await mkdir(dir, { recursive: true });
const tracePath = resolve(dir, "trace.sqlite");
const trace = new SqliteTrace(tracePath);
const workflows = new WorkflowStore(resolve(dir, "workflows.sqlite"));
try {
  for (const term of ["苹果", "香蕉"]) {
    const runtime = await PlaywrightRuntime.launch({ headless: true,
      artifactDir: resolve(dir, term) });
    try {
      const { model } = configuredModel({ environment: "browser",
        allowedHosts: ["127.0.0.1"] });
      const taskId = randomUUID();
      const result = await runTaskAgent({ taskId,
        goal: `打开 ${base}，搜索 ${term} 并打开结果，确认显示 商品详情：${term}`,
        environment: "browser", completionCriteria: { pageTextIncludes: `商品详情：${term}` },
        plan: ["打开本地搜索页", `搜索 ${term}`, "打开搜索结果", "核验详情文字"] },
      { runtime, exploreModel: model, trace, tracePath, workflowStore: workflows, maxSteps: 12 });
      console.log(JSON.stringify({ term, taskId, status: result.state.status,
        mode: result.mode, workflowUsed: result.workflowUsed, workflowCreated: result.workflowCreated,
        steps: result.state.step, error: result.state.error,
        modelCalls: trace.metrics(taskId).filter((metric) => metric.actor === "model").length }));
      if (result.state.status !== "done") process.exitCode = 1;
    } finally { await runtime.close(); }
  }
  console.log(`轨迹目录：${dir}`);
} finally {
  workflows.close(); trace.close();
  await new Promise<void>((done) => server.close(() => done()));
}
