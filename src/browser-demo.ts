import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ComputerAction } from "./actions/schema.js";
import type { ModelAdapter } from "./agent/model-adapter.js";
import { createAgentLoop } from "./graph/graph.js";
import { initialState, type ComputerState } from "./graph/state.js";
import { PlaywrightRuntime } from "./runtime/browser/playwright-runtime.js";
import { SqliteTrace } from "./trace/sqlite-trace.js";
import { browserTaskRequest } from "./contracts/task.js";
import { recordCapabilityChecks } from "./capabilities/record.js";
import { createServer } from "node:http";

const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (new URL(request.url ?? '/', 'http://localhost').pathname === '/done') response.end('<main class="completed">受控任务已完成</main>');
  else response.end('<form action="/done"><label>任务<input name="task"></label><button>完成任务</button></form>');
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

class TodoModel implements ModelAdapter {
  async decide(state: Readonly<ComputerState>): Promise<ComputerAction> {
    const task = "学习 LangGraph Agent Loop";
    switch (state.step) {
      case 0: return { kind: "navigate", url: base };
      case 1: return { kind: "type", target: { kind: "label", label: "任务" }, text: task };
      case 2: return { kind: "click", target: { kind: "role", role: "button", name: "完成任务" } };
      default:
        if (!state.observation?.dom?.includes('class="completed"')) throw new Error("任务未标记完成");
        return { kind: "done", summary: `已在本地合成网页完成任务：${task}` };
    }
  }
}

const taskId = randomUUID();
const trace = new SqliteTrace("browser-demo.sqlite");
let runtime: PlaywrightRuntime | undefined;
try {
  runtime = await PlaywrightRuntime.launch({ artifactDir: resolve(".artifacts", taskId) });
  const request = browserTaskRequest("在本地网页填写并完成受控任务", [
    "打开本地网页", "输入任务", "完成任务", "检查完成状态",
  ], { urlIncludes: "/done", domIncludes: 'class="completed"' }, true);
  recordCapabilityChecks(trace, taskId, 0, "浏览器检查", request,
    { ...request.facts, browserInstalled: true, browserAttached: true });
  const result = await createAgentLoop({ model: new TodoModel(), runtime, trace, maxSteps: 8 })
    .invoke(initialState(taskId, request.goal, request.plan, request.completionCriteria));
  console.log(JSON.stringify({ taskId, status: result.status, url: result.observation?.url,
    summary: result.summary, screenshot: result.observation?.screenshot }, null, 2));
  if (result.status !== "done") process.exitCode = 1;
} finally {
  await runtime?.close();
  trace.close();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}
