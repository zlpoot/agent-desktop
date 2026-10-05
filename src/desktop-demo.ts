import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { FakeModel } from "./agent/model-adapter.js";
import { createAgentLoop } from "./graph/graph.js";
import { initialState } from "./graph/state.js";
import { DesktopRuntime } from "./runtime/desktop/desktop-runtime.js";
import { WindowManager } from "./runtime/desktop/window-manager.js";
import { SqliteTrace } from "./trace/sqlite-trace.js";

const taskId = randomUUID();
const exe = resolve(".artifacts/desktop-fixture.exe");
const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const compiled = spawnSync(compiler, ["/nologo", "/target:winexe", `/out:${exe}`,
  "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll",
  resolve("scripts/desktop-fixture.cs")], { encoding: "utf8" });
if (compiled.status !== 0) throw new Error(`测试窗口编译失败：${compiled.stdout}${compiled.stderr}`);
const fixture = spawn(exe, [taskId], {
  windowsHide: false, stdio: "ignore",
});
const trace = new SqliteTrace("desktop-demo.sqlite");
let runtime: DesktopRuntime | undefined;
try {
  const manager = new WindowManager(resolve(".artifacts", "desktop-demo", taskId));
  runtime = await manager.attach({ windowTitle: `Computer Use M5 验证窗口 ${taskId}` }, 10000);
  const windowState = await manager.focus(runtime);
  if (!windowState.foreground || !windowState.permissionsCompatible || !windowState.uiaControls) {
    throw new Error("测试窗口未通过聚焦、权限或 UIA 检查");
  }
  const first = await runtime.observe();
  const controls = JSON.parse(first.dom ?? "[]") as Array<{
    name: string; role: string; rect: { x: number; y: number; width: number; height: number };
  }>;
  const button = controls.find((control) => control.role === "Button" && control.name === "处理");
  if (!button || !first.windowRect || !first.screenshot) throw new Error("测试按钮未出现在窗口观察中");
  const template = resolve(".artifacts", "desktop-demo", taskId, "button.png");
  const crop = spawnSync("python", [resolve("scripts/create-template.py"), first.screenshot, template,
    String(button.rect.x - first.windowRect.left), String(button.rect.y - first.windowRect.top),
    String(button.rect.width), String(button.rect.height)], { encoding: "utf8" });
  if (crop.status !== 0) throw new Error(`视觉模板生成失败：${crop.stderr}`);
  const graph = createAgentLoop({ runtime, trace, model: new FakeModel([
    { kind: "type", target: { kind: "role", role: "Edit", name: "输入内容" }, text: "M5 desktop" },
    { kind: "click", target: { kind: "vision", description: `template:${template}` } },
    { kind: "done", summary: "桌面窗口已处理输入" },
  ]) });
  const result = await graph.invoke(initialState(taskId, "在 Windows 测试窗口输入并处理文本",
    ["定位输入框", "输入内容", "点击处理", "核对结果"],
    { pageTextIncludes: "已处理：M5 desktop" }));
  console.log(JSON.stringify({ taskId, status: result.status, error: result.error,
    screenshot: result.observation?.screenshot, trace: resolve("desktop-demo.sqlite") }, null, 2));
  if (result.status !== "done") process.exitCode = 1;
} finally {
  await runtime?.close();
  trace.close();
  fixture.kill();
}
