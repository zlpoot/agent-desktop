import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { configuredModel } from "./agent/local-config.js";
import { createAgentLoop } from "./graph/graph.js";
import { resumeSavedTask } from "./graph/resume.js";
import { initialState } from "./graph/state.js";
import { PlaywrightRuntime } from "./runtime/browser/playwright-runtime.js";
import { SqliteTrace } from "./trace/sqlite-trace.js";
import { browserTaskRequest } from "./contracts/task.js";
import { recordCapabilityChecks } from "./capabilities/record.js";

const [command = "start", taskArg, decision, ...answerParts] = process.argv.slice(2);
if (!["check", "start", "resume"].includes(command)) {
  throw new Error("用法：npm run demo:task-a:ai -- check|start|resume <任务 ID> approve|reject|answer <回答>");
}
if (command === "resume" && (!taskArg || !["approve", "reject", "answer"].includes(decision))) {
  throw new Error("恢复任务时需要任务 ID 和 approve、reject 或 answer <回答>");
}
const { model, modelName } = configuredModel({ allowedHosts: ["bilibili.com"] });
await model.checkConnection();
if (command === "check") {
  console.log(`模型服务连接成功，${modelName} 可用。`);
} else {
  const taskId = command === "start" ? randomUUID() : taskArg;
  const dir = resolve(".artifacts", "task-a-ai", taskId);
  await mkdir(dir, { recursive: true });
  const trace = new SqliteTrace("task-a-ai.sqlite");
  const checkpoint = SqliteSaver.fromConnString(resolve(dir, "checkpoints.sqlite"));
  let runtime: PlaywrightRuntime | undefined;
  try {
    runtime = await PlaywrightRuntime.launch({ artifactDir: resolve(dir, "screenshots"),
      userDataDir: resolve(dir, "browser-profile") });
    const request = browserTaskRequest("打开 B 站，搜索 LangGraph Agent Loop，打开一个相关视频结果", [
      "打开 B 站首页", "输入搜索词", "提交搜索", "选择相关视频", "验证视频页面",
    ], { urlIncludes: "bilibili.com/video/", pageTextIncludes: "LangGraph" }, false);
    recordCapabilityChecks(trace, taskId, 0, "浏览器检查", request,
      { ...request.facts, browserInstalled: true, browserAttached: true, modelAvailable: true });
    const graph = createAgentLoop({ model, runtime, trace, checkpointer: checkpoint,
      maxSteps: 12, maxRetries: 2 });
    const result = command === "start"
      ? await graph.invoke(initialState(taskId, request.goal, request.plan, request.completionCriteria),
        { configurable: { thread_id: taskId } })
      : await resumeSavedTask(graph, runtime, taskId, decision === "answer"
        ? { answer: answerParts.join(" ") } : { approved: decision === "approve" });
    console.log(JSON.stringify({ taskId, status: result.status, error: result.error,
      summary: result.summary, url: result.observation?.url,
      screenshot: result.observation?.screenshot, trace: resolve("task-a-ai.sqlite") }, null, 2));
    if (result.status === "waiting_user") {
      const question = result.lastAction?.kind === "ask_user";
      console.log(question
        ? `请回答：npm run demo:task-a:ai -- resume ${taskId} answer <回答>`
        : `批准或拒绝：npm run demo:task-a:ai -- resume ${taskId} approve|reject`);
    }
    if (result.status === "failed") process.exitCode = 1;
  } finally { await runtime?.close(); trace.close(); checkpoint.db.close(); }
}
