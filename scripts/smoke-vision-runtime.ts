import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { configuredModel } from "../src/agent/local-config.js";
import { FakeModel } from "../src/agent/model-adapter.js";
import { createAgentLoop } from "../src/graph/graph.js";
import { initialState } from "../src/graph/state.js";
import { DesktopRuntime } from "../src/runtime/desktop/desktop-runtime.js";
import { DesktopVisionRuntime } from "../src/runtime/desktop/vision-runtime.js";
import { WindowManager } from "../src/runtime/desktop/window-manager.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";

const dir = resolve(".artifacts", "vision-runtime-smoke", randomUUID());
await mkdir(dir, { recursive: true });
const exe = resolve(".artifacts", "desktop-fixture.exe");
const compiled = spawnSync("C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
  ["/nologo", "/target:winexe", `/out:${exe}`, "/reference:System.Windows.Forms.dll",
    "/reference:System.Drawing.dll", resolve("scripts/desktop-fixture.cs")], { encoding: "utf8" });
if (compiled.status !== 0) throw new Error(`测试应用编译失败：${compiled.stdout}${compiled.stderr}`);
const suffix = randomUUID();
const fixture = spawn(exe, [suffix], { windowsHide: false, stdio: "ignore" });
const manager = new WindowManager(resolve(dir, "screenshots"));
const desktop = await manager.attach({ windowTitle: `Computer Use M5 验证窗口 ${suffix}` }, 10000);
const { model } = configuredModel({ environment: "desktop", visualMode: true });
const runtime = new DesktopVisionRuntime(desktop, model);
const trace = new SqliteTrace(resolve(dir, "trace.sqlite"));
try {
  await manager.focus(desktop);
  const taskId = randomUUID();
  const result = await createAgentLoop({ runtime, trace, model: new FakeModel([
    { kind: "type", target: { kind: "role", role: "Edit", name: "输入内容" }, text: "苹果" },
    { kind: "click", target: { kind: "vision", description: "窗口中唯一写着‘处理’的按钮，不是输入框" } },
    { kind: "done", summary: "已处理苹果" },
  ]), maxSteps: 8 }).invoke(initialState(taskId, "在测试窗口输入苹果并点击处理",
    undefined, { pageTextIncludes: "已处理" }));
  console.log(JSON.stringify({ taskId, status: result.status, error: result.error,
    text: result.observation?.pageText?.slice(-300),
    ground: trace.events(taskId).filter((event) => event.node === "ground")
      .map((event) => event.state.groundingStrategy),
    modelMetrics: trace.metrics(taskId).filter((metric) => metric.actor === "model")
      .map((metric) => ({ node: metric.node, tokens: metric.totalTokens })) }));
  console.log(`轨迹目录：${dir}`);
  if (result.status !== "done") process.exitCode = 1;
} finally {
  await runtime.close(); fixture.kill(); trace.close();
}
