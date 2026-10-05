import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { configuredModel } from "./agent/local-config.js";
import { createAgentLoop } from "./graph/graph.js";
import { resumeSavedTask } from "./graph/resume.js";
import { initialState } from "./graph/state.js";
import { DesktopRuntime } from "./runtime/desktop/desktop-runtime.js";
import { SqliteTrace } from "./trace/sqlite-trace.js";

const [command = "check", first, second, third, ...rest] = process.argv.slice(2);
if (!["check", "start", "start-app", "resume"].includes(command)) {
  throw new Error("用法：check | start <精确窗口标题> <目标> <预期结果文字> | start-app <窗口类名> <进程路径> <目标> <预期结果文字> [预期无障碍文字] | resume <任务 ID> approve|reject|answer [回答]");
}
if (command === "start" && (!first || !second || !third)) {
  throw new Error("启动桌面任务需提供精确窗口标题、目标和预期结果文字");
}
if (command === "start-app" && (!first || !second || !third || !rest[0])) {
  throw new Error("按应用启动任务需提供窗口类名、进程路径、目标和预期结果文字");
}
if (command === "resume" && (!first || !["approve", "reject", "answer"].includes(second))) {
  throw new Error("恢复桌面任务需提供任务 ID 和 approve、reject 或 answer");
}

const { model, modelName } = configuredModel({ environment: "desktop",
  taskInstructions: "仅操作启动时指定的窗口。不要打开其他应用或窗口，不要输入账号密码，不要执行删除、发送、支付、系统设置或终端命令。搜索结果中先打开相应分类，再点击具体结果；若分类已打开，不要重复点击分类标签。" });
await model.checkConnection();
if (command === "check") {
  console.log(`模型服务连接成功，${modelName} 可用。`);
} else {
  const taskId = command === "resume" ? first : randomUUID();
  const dir = resolve(".artifacts", "desktop-ai", taskId);
  await mkdir(dir, { recursive: true });
  const trace = new SqliteTrace("desktop-ai.sqlite");
  const checkpoint = SqliteSaver.fromConnString(resolve(dir, "checkpoints.sqlite"));
  let runtime: DesktopRuntime | undefined;
  try {
    const previous = command === "resume" ? trace.load(taskId)?.observation : undefined;
    if (command === "resume" && previous?.windowHandle === undefined) {
      throw new Error(`任务 ${taskId} 没有可恢复的桌面窗口记录`);
    }
    const attachOptions = {
      ...(command === "start" ? { windowTitle: first }
        : command === "start-app" ? { windowClass: first, processPath: second }
          : { windowHandle: previous?.windowHandle }),
      artifactDir: resolve(dir, "screenshots"),
    };
    if (command === "start-app") {
      await access(resolve(second));
      let lastError: unknown;
      for (let attempt = 0; attempt < 20; attempt++) {
        try { runtime = await DesktopRuntime.attach(attachOptions); break; }
        catch (error) {
          lastError = error;
          if (!String(error).includes("窗口匹配数量为 0")) throw error;
          if (attempt === 0) {
            const app = spawn(resolve(second), [], {
              windowsHide: false, stdio: "ignore", detached: true,
            });
            app.on("error", (launchError) => { lastError = launchError; });
            app.unref();
          }
          await new Promise((done) => setTimeout(done, 500));
        }
      }
      if (!runtime) throw new Error(`应用窗口未出现：${String(lastError)}`);
    } else runtime = await DesktopRuntime.attach(attachOptions);
    const graph = createAgentLoop({ model, runtime, trace, checkpointer: checkpoint,
      maxSteps: 20, maxRetries: 2 });
    const result = command !== "resume"
      ? await graph.invoke(initialState(taskId, command === "start-app" ? third : second,
          ["观察指定窗口", "定位控件并执行操作", "核对预期结果"],
          { pageTextIncludes: command === "start-app" ? rest[0] : third,
            ...(command === "start-app" && rest[1] ? { accessibilityIncludes: rest[1] } : {}) }),
        { configurable: { thread_id: taskId } })
      : await resumeSavedTask(graph, runtime, taskId, second === "answer"
        ? { answer: [third, ...rest].filter(Boolean).join(" ") }
        : { approved: second === "approve" });
    console.log(JSON.stringify({ taskId, status: result.status, error: result.error,
      summary: result.summary, windowTitle: result.observation?.windowTitle,
      screenshot: result.observation?.screenshot, trace: resolve("desktop-ai.sqlite") }, null, 2));
    if (result.status === "waiting_user") console.log(
      `恢复任务：npm run demo:desktop:ai -- resume ${taskId} approve|reject|answer [回答]`);
    if (result.status === "failed") process.exitCode = 1;
  } finally { await runtime?.close(); trace.close(); checkpoint.db.close(); }
}
