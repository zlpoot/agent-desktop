import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { FakeModel } from "./agent/model-adapter.js";
import { createAgentLoop } from "./graph/graph.js";
import { resumeSavedTask } from "./graph/resume.js";
import { initialState } from "./graph/state.js";
import { PlaywrightRuntime } from "./runtime/browser/playwright-runtime.js";
import { SqliteTrace } from "./trace/sqlite-trace.js";

const [command, taskArg, decision] = process.argv.slice(2);
if (command !== "start" && command !== "resume") {
  throw new Error("用法：npm run demo:approval -- start，或 npm run demo:approval -- resume <任务 ID> approve|reject");
}
if (command === "resume" && (!taskArg || !["approve", "reject"].includes(decision))) {
  throw new Error("恢复时需要任务 ID 和 approve 或 reject");
}
const taskId = command === "start" ? randomUUID() : taskArg;
const dir = resolve(".artifacts", "approval-demo", taskId);
await mkdir(dir, { recursive: true });

const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (request.url === "/form") {
    response.end('<form method="POST" action="/done"><button>提交</button></form>');
  } else if (request.url === "/done" && request.method === "POST") {
    response.statusCode = 303;
    response.setHeader("Location", "/done");
    response.end();
  } else if (request.url === "/done") {
    response.end("<main>提交成功</main>");
  } else { response.statusCode = 404; response.end("页面不存在"); }
});
await new Promise<void>((done) => server.listen(4180, "127.0.0.1", done));
const base = "http://127.0.0.1:4180";
let runtime: PlaywrightRuntime | undefined;
let trace: SqliteTrace | undefined;
let checkpoint: SqliteSaver | undefined;
try {
  runtime = await PlaywrightRuntime.launch({ artifactDir: resolve(dir, "screenshots"),
    userDataDir: resolve(dir, "browser-profile") });
  trace = new SqliteTrace(resolve(dir, "trace.sqlite"));
  checkpoint = SqliteSaver.fromConnString(resolve(dir, "checkpoints.sqlite"));
  const model = command === "start" ? new FakeModel([
    { kind: "navigate", url: `${base}/form` },
    { kind: "click", target: { kind: "role", role: "button", name: "提交" } },
  ]) : new FakeModel([{ kind: "done", summary: "本地表单提交完成" }]);
  const graph = createAgentLoop({ model, runtime, trace, checkpointer: checkpoint });
  const result = command === "start"
    ? await graph.invoke(initialState(taskId, "提交本地演示表单", undefined,
        { urlIncludes: "/done", pageTextIncludes: "提交成功" }),
      { configurable: { thread_id: taskId } })
    : await resumeSavedTask(graph, runtime, taskId, { approved: decision === "approve" });
  console.log(JSON.stringify({ taskId, status: result.status, error: result.error,
    summary: result.summary, screenshot: result.observation?.screenshot,
    trace: resolve(dir, "trace.sqlite") }, null, 2));
  if (result.status === "waiting_user") {
    console.log(`请检查截图和轨迹，再运行：npm run demo:approval -- resume ${taskId} approve`);
    console.log(`拒绝执行：npm run demo:approval -- resume ${taskId} reject`);
  }
} finally {
  await runtime?.close();
  trace?.close();
  checkpoint?.db.close();
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
}
