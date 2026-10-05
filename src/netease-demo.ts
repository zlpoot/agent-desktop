import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { FakeModel } from "./agent/model-adapter.js";
import { createAgentLoop } from "./graph/graph.js";
import { initialState } from "./graph/state.js";
import { DesktopRuntime } from "./runtime/desktop/desktop-runtime.js";
import { SqliteTrace } from "./trace/sqlite-trace.js";

const configuredPath = process.argv[2] ?? process.env.NETEASE_APP_PATH;
if (!configuredPath) throw new Error('Set NETEASE_APP_PATH or pass an executable path');
const appPath = resolve(configuredPath);
const query = "周杰伦 稻香";
const taskId = randomUUID();
const dir = resolve(".artifacts", "netease-demo", taskId);
const options = { windowClass: "OrpheusBrowserHost", processPath: appPath,
  artifactDir: resolve(dir, "screenshots") };
let runtime: DesktopRuntime | undefined;
let lastError: unknown;
for (let attempt = 0; attempt < 12; attempt++) {
  try { runtime = await DesktopRuntime.attach(options); break; }
  catch (error) {
    lastError = error;
    if (attempt === 0) spawn(appPath, [], { windowsHide: false, stdio: "ignore", detached: true }).unref();
    await new Promise((done) => setTimeout(done, 500));
  }
}
if (!runtime) throw new Error(`网易云音乐窗口未出现：${String(lastError)}`);

const trace = new SqliteTrace("netease-demo.sqlite");
try {
  const graph = createAgentLoop({ runtime, trace, model: new FakeModel([
    { kind: "type", target: { kind: "role", role: "Edit" }, text: query },
    { kind: "click", target: { kind: "role", role: "Button", name: "search" } },
    { kind: "click", target: { kind: "role", role: "Text", name: "歌手：周杰伦" } },
    { kind: "done", summary: "已搜索并打开周杰伦歌手结果" },
  ]), maxSteps: 8, maxRetries: 2 });
  const result = await graph.invoke(initialState(taskId,
    `在网易云音乐搜索“${query}”，打开歌手“周杰伦”的结果页；不播放音乐`,
    ["输入搜索词", "打开搜索结果", "打开歌手结果", "验证歌手页"],
    { pageTextIncludes: "Jay Chou/周董", accessibilityIncludes: "歌手详情" }));
  console.log(JSON.stringify({ taskId, status: result.status, error: result.error,
    summary: result.summary, windowTitle: result.observation?.windowTitle,
    screenshot: result.observation?.screenshot, trace: resolve("netease-demo.sqlite") }, null, 2));
  if (result.status !== "done") process.exitCode = 1;
} finally { await runtime.close(); trace.close(); }
