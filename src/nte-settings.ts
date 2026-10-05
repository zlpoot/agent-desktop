import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DesktopRuntime } from "./runtime/desktop/desktop-runtime.js";

const [command, handleText] = process.argv.slice(2);
const handle = Number(handleText);
if (!Number.isInteger(handle) || handle <= 0 ||
    !["inspect", "open-menu", "open-menu-key", "open-settings", "open-audio", "set-master-50"].includes(command)) {
  throw new Error("用法：npm run demo:nte:settings -- inspect|open-menu|open-menu-key|open-settings|open-audio|set-master-50 <异环窗口句柄>");
}
const dir = resolve(".artifacts", "nte-settings", randomUUID());
const startedAt = performance.now();
const steps: { name: string; durationMs: number; operator: string; model: null; inputTokens: number; outputTokens: number }[] = [];
async function timed<T>(name: string, operator: string, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await run(); }
  finally { steps.push({ name, durationMs: Math.round(performance.now() - start),
    operator, model: null, inputTokens: 0, outputTokens: 0 }); }
}
const runtime = await DesktopRuntime.attach({ windowHandle: handle, artifactDir: dir });
try {
  const before = await timed("观察游戏窗口", "Desktop Runtime 截图与 UIA", () => runtime.observe());
  if (before.windowTitle?.trim() !== "异环") throw new Error("绑定的窗口不是《异环》");
  if (command === "inspect") {
    console.log(JSON.stringify({ title: before.windowTitle, screenshot: before.screenshot,
      windowRect: before.windowRect, accessibility: before.accessibility }, null, 2));
  } else if (command === "open-menu-key") {
    const result = await runtime.execute({ kind: "keypress", keys: "esc" });
    if (!result.ok) throw new Error(result.message);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const after = await runtime.observe();
    console.log(JSON.stringify({ title: after.windowTitle, result,
      windowRect: after.windowRect,
      screenshot: after.screenshot, accessibility: after.accessibility,
      changed: before.screenshotHash !== after.screenshotHash }, null, 2));
  } else if (command === "set-master-50") {
    if (before.windowRect?.width !== 1942 || before.windowRect?.height !== 1136) {
      throw new Error("游戏窗口尺寸与已核对的 1920×1080 窗口模式不一致");
    }
    const label = await timed("定位主音量", "OpenCV 模板匹配", () => runtime.ground({ kind: "click", target: { kind: "vision",
      description: "template:src/runtime/desktop/templates/nte-master-label.png" } }));
    if (label.target?.kind !== "coordinate" || label.target.y < 250 || label.target.y > 310) {
      throw new Error("未在声音页找到主音量控件");
    }
    const result = await timed("设置主音量为 50", "Win32 SendInput", () => runtime.execute({ kind: "click", target: { kind: "coordinate", x: 1523, y: 279 } }));
    if (!result.ok) throw new Error(result.message);
    await timed("等待界面稳定", "工程定时器", () => new Promise<void>((resolve) => setTimeout(resolve, 900)));
    const after = await timed("观察设置结果", "Desktop Runtime 截图与 UIA", () => runtime.observe());
    const verified = await timed("核验显示 50", "OpenCV 模板匹配", () => runtime.ground({ kind: "click", target: { kind: "vision",
      description: "template:src/runtime/desktop/templates/nte-master-volume-50.png" } }));
    if (verified.target?.kind !== "coordinate" || verified.target.y < 250 || verified.target.y > 310) {
      throw new Error(`主音量数值未核验为 50：${JSON.stringify(verified.attempts)}`);
    }
    console.log(JSON.stringify({ title: after.windowTitle, result, target: { x: 1523, y: 279 },
      screenshot: after.screenshot, verified: true, verification: verified.attempts,
      steps, totalDurationMs: Math.round(performance.now() - startedAt) }, null, 2));
  } else {
    const template = command === "open-settings"
      ? "nte-settings-gear.png" : command === "open-audio" ? "nte-audio-tab.png" : "nte-menu.png";
    const action = { kind: "click" as const, target: { kind: "vision" as const,
      description: `template:src/runtime/desktop/templates/${template}` } };
    const grounded = await runtime.ground(action);
    if (!grounded.target) throw new Error(`菜单按钮未定位：${JSON.stringify(grounded.attempts)}`);
    const result = await runtime.execute({ ...action, target: grounded.target });
    if (!result.ok) throw new Error(result.message);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const after = await runtime.observe();
    console.log(JSON.stringify({ title: after.windowTitle, result, target: grounded.target,
      windowRect: after.windowRect,
      screenshot: after.screenshot, accessibility: after.accessibility,
      grounding: grounded.attempts, changed: before.screenshotHash !== after.screenshotHash }, null, 2));
  }
} finally { await runtime.close(); }
