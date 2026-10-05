import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ComputerAction } from "./actions/schema.js";
import type { ModelAdapter } from "./agent/model-adapter.js";
import { createAgentLoop } from "./graph/graph.js";
import { initialState, type ComputerState } from "./graph/state.js";
import { PlaywrightRuntime } from "./runtime/browser/playwright-runtime.js";
import { SqliteTrace } from "./trace/sqlite-trace.js";

const keyword = "LangGraph Agent Loop";

class SearchModel implements ModelAdapter {
  async decide(state: Readonly<ComputerState>): Promise<ComputerAction> {
    switch (state.step) {
      case 0: return { kind: "navigate", url: "https://www.bilibili.com/" };
      case 1: return { kind: "type", target: { kind: "selector", selector: ".nav-search-input" },
        text: keyword };
      case 2: return { kind: "keypress", keys: "Enter" };
      case 3:
        if (!state.observation?.url?.startsWith("https://search.bilibili.com/")) {
          throw new Error("没有到达 B 站搜索结果页");
        }
        return { kind: "click", target: { kind: "selector",
          selector: 'a[href*="/video/"]:has-text("尚硅谷LangGraph教程")' } };
      default:
        if (!state.observation?.url?.includes("/video/") ||
            !state.observation.pageText?.toLowerCase().includes("langgraph")) {
          throw new Error("相关视频页面尚未加载完成");
        }
        return { kind: "done", summary: "已搜索 LangGraph Agent Loop 并打开相关视频" };
    }
  }
}

const taskId = randomUUID();
const trace = new SqliteTrace("task-a.sqlite");
const runtime = await PlaywrightRuntime.launch({ artifactDir: resolve(".artifacts", taskId) });
try {
  const result = await createAgentLoop({ model: new SearchModel(), runtime, trace, maxSteps: 8 })
    .invoke(initialState(taskId, "在 B 站搜索 LangGraph Agent Loop 并打开相关结果", [
      "打开 B 站首页", "输入搜索词", "提交搜索", "打开相关视频", "验证结果页",
    ], { urlIncludes: "/video/", pageTextIncludes: "LangGraph" }));
  console.log(JSON.stringify({ taskId, status: result.status, error: result.error,
    url: result.observation?.url, summary: result.summary,
    screenshot: result.observation?.screenshot, trace: resolve("task-a.sqlite") }, null, 2));
  if (result.status !== "done") process.exitCode = 1;
} finally { await runtime.close(); trace.close(); }
