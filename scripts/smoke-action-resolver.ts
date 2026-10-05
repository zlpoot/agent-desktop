import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { FakeModel } from "../src/agent/model-adapter.js";
import type { ChatCompletionsModel } from "../src/agent/chat-completions-model.js";
import { createAgentLoop } from "../src/graph/graph.js";
import { initialState } from "../src/graph/state.js";
import { DesktopVisionRuntime } from "../src/runtime/desktop/vision-runtime.js";
import { WindowManager } from "../src/runtime/desktop/window-manager.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";

const suffix = randomUUID();
const dir = resolve(".artifacts", "action-resolver-smoke", suffix);
await mkdir(dir, { recursive: true });
const exe = resolve(dir, "vision-fixture.exe");
const compiled = spawnSync("C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
  ["/nologo", "/target:winexe", `/out:${exe}`, "/reference:System.Windows.Forms.dll",
    "/reference:System.Drawing.dll", resolve("scripts/vision-fixture.cs")], { encoding: "utf8" });
if (compiled.status !== 0) throw new Error(`测试窗口编译失败：${compiled.stdout}${compiled.stderr}`);
const title = `Computer Use 视觉验证窗口 ${suffix}`;
const manager = new WindowManager(resolve(dir, "screenshots"));
const trace = new SqliteTrace(resolve(dir, "trace.sqlite"));
const taskId = randomUUID();
let runtime: DesktopVisionRuntime | undefined;
try {
  const desktop = await manager.ensure({ windowTitle: title }, exe, [suffix]);
  await manager.focus(desktop);
  const vision = { name: "测试视觉定位器",
    transcribeScreenshot: async () => ({ text: "" }),
    locateVisualTarget: async () => ({ x: 320, y: 210, confidence: 0.99 }),
    takeVisualUsage: () => undefined } as unknown as ChatCompletionsModel;
  runtime = new DesktopVisionRuntime(desktop, vision);
  const model = new FakeModel([{ kind: "click", target: { kind: "candidates", options: [
    { kind: "role", role: "Button", name: "设置" },
    { kind: "vision", description: "画面中央蓝色设置按钮" },
  ] } }, { kind: "done", summary: "设置页已打开" }]);
  const state = await createAgentLoop({ model, runtime, trace, maxSteps: 3 }).invoke(
    initialState(taskId, "打开设置页", undefined, { windowTitleIncludes: title }));
  const resolution = trace.actionResolutions(taskId)[0];
  const grounding = trace.groundingStats(taskId);
  const verified = trace.events(taskId).some((event) =>
    event.node === "verify" && event.state.lastVerification?.ok);
  console.log(JSON.stringify({ status: state.status, verified,
    selected: resolution?.selected, actual: resolution?.actual,
    attempts: resolution?.candidates, grounding, dir }));
  if (state.status !== "done" || !verified ||
      resolution?.selected !== "windows.pywinauto_mouse.act" ||
      resolution.actual !== "windows.pywinauto_mouse.act" ||
      !grounding.some((entry) => entry.strategy === "vision" && entry.selections === 1)) {
    process.exitCode = 1;
  }
} finally {
  await runtime?.close();
  trace.close();
  const windows = await manager.list({ windowTitle: title }).catch(() => []);
  for (const window of windows) if (window.processPath?.toLowerCase() === exe.toLowerCase()) {
    process.kill(window.processId);
  }
}
