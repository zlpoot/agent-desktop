import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DesktopRuntime } from "../src/runtime/desktop/desktop-runtime.js";
import { WindowManager } from "../src/runtime/desktop/window-manager.js";
import { singleProvider } from "../src/actions/action-resolution.js";

const suffix = randomUUID();
const dir = resolve(".artifacts", "desktop-tools-smoke", suffix);
await mkdir(dir, { recursive: true });
const exe = resolve(dir, "desktop-fixture.exe");
const compiled = spawnSync("C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
  ["/nologo", "/target:winexe", `/out:${exe}`, "/reference:System.Windows.Forms.dll",
    "/reference:System.Drawing.dll", resolve("scripts/desktop-fixture.cs")], { encoding: "utf8" });
if (compiled.status !== 0) throw new Error(`测试窗口编译失败：${compiled.stdout}${compiled.stderr}`);

const manager = new WindowManager(resolve(dir, "screenshots"));
const filter = { windowTitle: `Computer Use M5 验证窗口 ${suffix}` };
let runtime: DesktopRuntime | undefined;
try {
  runtime = await manager.ensure(filter, exe, [suffix], 10000);
  const listed = await manager.list(filter);
  if (listed.length !== 1) throw new Error(`窗口发现结果应为 1，实际为 ${listed.length}`);
  const state = await manager.focus(runtime);
  if (!state.foreground || !state.permissionsCompatible || !state.uiaControls) {
    throw new Error("窗口焦点、权限或 UIA 控件检查失败");
  }
  const input = { kind: "role", role: "Edit", name: "输入内容" } as const;
  const button = { kind: "role", role: "Button", name: "处理" } as const;
  const unauthorized = await runtime.execute({ kind: "click", target: button },
    singleProvider("windows.runtime.wait", "测试未授权执行器被拒绝"));
  if (unauthorized.ok || unauthorized.effect !== "none" ||
      !unauthorized.message.includes("未被本步 Action Resolver 授权")) {
    throw new Error("未授权执行器没有在发出动作前被拒绝");
  }
  const typeAction = { kind: "type", target: input, text: "ABC" } as const;
  const typeResolution = await runtime.resolveAction(typeAction);
  if (typeResolution.selected !== "windows.uia.act") throw new Error("输入动作未预选 UIA");
  const typed = await runtime.execute(typeAction, typeResolution);
  if (!typed.ok) throw new Error(`UIA 输入失败：${typed.message}`);
  if (typed.provider !== "windows.uia.act") throw new Error(`输入工具记录错误：${typed.provider}`);
  const focused = await runtime.execute({ kind: "click", target: input });
  if (!focused.ok) throw new Error(`输入框聚焦失败：${focused.message}`);
  for (const keys of ["ctrl+a", "backspace"]) {
    const result = await runtime.execute({ kind: "keypress", keys });
    if (!result.ok) throw new Error(`按键 ${keys} 失败：${result.message}`);
  }
  const clickAction = { kind: "click", target: button } as const;
  const clickResolution = await runtime.resolveAction(clickAction);
  if (clickResolution.selected !== "windows.uia.act") throw new Error("按钮动作未预选 UIA");
  const clicked = await runtime.execute(clickAction, clickResolution);
  if (!clicked.ok) throw new Error(`UIA 点击失败：${clicked.message}`);
  if (clicked.provider !== "windows.uia.act") throw new Error(`点击工具记录错误：${clicked.provider}`);
  const observed = await runtime.observe();
  if (!observed.pageText?.includes("已处理：") || observed.pageText.includes("已处理：ABC")) {
    throw new Error("未能通过结果文字确认 Ctrl+A 和 Backspace 已清空输入");
  }
  if (!observed.screenshot) throw new Error("窗口截图缺失");
  let clipboard: "pasted" | "protected";
  try {
    const pasted = await runtime.execute({ kind: "paste_text", target: input, text: "中文粘贴验证" });
    if (!pasted.ok || pasted.provider !== "windows.clipboard.paste_text") {
      throw new Error(`剪贴板工具记录错误：${pasted.message} ${pasted.provider}`);
    }
    await runtime.execute({ kind: "click", target: button });
    if (!(await runtime.observe()).pageText?.includes("已处理：中文粘贴验证")) {
      throw new Error("剪贴板输入后结果文字未更新");
    }
    clipboard = "pasted";
  } catch (error) {
    if (!String(error).includes("剪贴板包含非纯文本内容")) throw error;
    clipboard = "protected";
  }
  const restored = await DesktopRuntime.attach({ windowHandle: listed[0].handle,
    artifactDir: resolve(dir, "restored") });
  try {
    await restored.restore(observed);
    const probe = await manager.state(restored);
    if (probe.processId !== state.processId) throw new Error("恢复后的窗口进程不一致");
  } finally { await restored.close(); }
  console.log(JSON.stringify({ status: "done", windowCount: listed.length,
    focus: state.foreground, uia: state.uiaControls, keypress: true, clipboard,
    restore: true, screenshot: observed.screenshot, artifactDir: dir }));
} finally {
  await runtime?.close();
  // 只关闭本测试独立编译的窗口进程，不影响其他桌面应用。
  const windows = await manager.list(filter).catch(() => []);
  for (const window of windows) {
    if (window.processPath?.toLowerCase() === exe.toLowerCase()) {
      process.kill(window.processId);
    }
  }
}
