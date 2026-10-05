import { FakeModel } from "./agent/model-adapter.js";
import { createAgentLoop } from "./graph/graph.js";
import { initialState } from "./graph/state.js";
import { FakeRuntime } from "./runtime/runtime-adapter.js";
import { SqliteTrace } from "./trace/sqlite-trace.js";

const trace = new SqliteTrace("demo.sqlite");
try {
  const model = new FakeModel([
    { kind: "navigate", url: "https://example.com" },
    { kind: "done", summary: "模拟导航已完成" },
  ]);
  const result = await createAgentLoop({ model, runtime: new FakeRuntime(), trace })
    .invoke(initialState(crypto.randomUUID(), "打开 example.com", ["导航到示例网页", "确认页面已打开"],
      { urlIncludes: "https://example.com" }));
  console.log(JSON.stringify({ taskId: result.taskId, status: result.status, step: result.step, summary: result.summary }, null, 2));
} finally {
  trace.close();
}
