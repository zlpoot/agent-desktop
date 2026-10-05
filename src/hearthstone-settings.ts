/** 《炉石传说》受控现场验收：只打开设置页并返回，不修改任何设置。 */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { ComputerAction, Observation } from "./actions/schema.js";
import { resolveCapability, requireCapability, type CapabilityFacts } from "./capabilities/registry.js";
import { initialState, type ComputerState } from "./graph/state.js";
import { DesktopRuntime } from "./runtime/desktop/desktop-runtime.js";
import { WindowManager } from "./runtime/desktop/window-manager.js";
import { SqliteTrace, type NodeMetric } from "./trace/sqlite-trace.js";

const taskId = randomUUID();
const root = process.cwd();
const dir = resolve(root, ".artifacts", "hearthstone-settings", taskId);
await mkdir(dir, { recursive: true });
const trace = new SqliteTrace(resolve(root, "hearthstone-settings.sqlite"));
const manager = new WindowManager(resolve(dir, "screenshots"));
let runtime: DesktopRuntime | undefined;
let state: ComputerState = initialState(taskId, "在已打开的《炉石传说》中打开设置页并返回", [
  "确认游戏窗口与起始页面", "打开游戏菜单", "打开选项页", "关闭选项页", "关闭游戏菜单并返回起点",
]);
trace.save("start", state);

const target = (name: string): ComputerAction => ({ kind: "click", target: { kind: "vision",
  description: `template:src/runtime/desktop/templates/${name}` } });
const gear = "hearthstone-settings-gear.png";
const options = "hearthstone-options-label.png";
const heading = "hearthstone-settings-heading.png";
const menuHeading = "hearthstone-menu-heading.png";

async function timed<T>(node: string, actor: NodeMetric["actor"], operator: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  try { return await fn(); }
  finally { trace.recordNodeMetric(taskId, { step: state.step, node, startedAt,
    durationMs: Math.max(0, performance.now() - start), actor, operator,
    inputTokens: 0, outputTokens: 0, totalTokens: 0 }); }
}

async function observe(): Promise<Observation> {
  const observation = await timed("observe", "runtime", "DesktopRuntime 截图/UIA", () => runtime!.observe());
  state = { ...state, observation };
  trace.save("observe", state);
  return observation;
}

async function has(name: string): Promise<boolean> {
  const result = await timed("verify", "rule", "OpenCV 模板核验", () => runtime!.ground(target(name)));
  return !!result.target;
}

async function actionStep(label: string, action: ComputerAction, expected: string,
  absent: string[] = []): Promise<void> {
  state = { ...state, step: state.step + 1, lastAction: action, lastResult: undefined,
    lastVerification: undefined, summary: label };
  trace.save("decide", state);
  trace.recordNodeMetric(taskId, { step: state.step, node: "decide", startedAt: new Date().toISOString(),
    durationMs: 0, actor: "rule", operator: "受控设置页测试", inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  let executable = action;
  if (action.kind === "click") {
    const grounded = await timed("ground", "runtime", "OpenCV 模板定位", () => runtime!.ground(action));
    trace.recordGrounding(taskId, state.step, grounded.attempts);
    if (!grounded.target) throw new Error(`${label}：视觉目标未唯一匹配`);
    executable = { ...action, target: grounded.target };
    state = { ...state, groundedAction: executable, groundingStrategy: "vision" };
    trace.save("ground", state);
  }
  const probe = await manager.focus(runtime!);
  const facts: CapabilityFacts = { windowDiscovered: true, windowAttached: true,
    screenshotAvailable: !!state.observation?.screenshot, templateAvailable: true,
    uiaControls: probe.uiaControls, unrealWindow: false,
    unityWindow: probe.windowClass === "UnityWndClass", clickAction: action.kind === "click",
    escapeAction: action.kind === "keypress" && action.keys.toLowerCase() === "esc",
    windowForeground: probe.foreground, permissionsCompatible: probe.permissionsCompatible };
  const resolution = resolveCapability("act", "windows", facts);
  trace.recordCapabilityResolution(taskId, state.step, "动作前检查", resolution, facts);
  const selected = requireCapability(resolution);
  const expectedProvider = action.kind === "click" ? "windows.win32.unity.click" : "windows.pyautogui.unity.escape";
  if (selected !== expectedProvider) throw new Error(`${label}：选择的执行能力与动作不符：${selected}`);
  const operator = action.kind === "click" ? "Win32 SendInput 鼠标" : "PyAutoGUI Esc";
  const result = await timed("execute", "runtime", operator, () => runtime!.execute(executable));
  if (action.kind === "click") trace.recordGroundingExecution(taskId, state.step, result.ok);
  state = { ...state, lastResult: result };
  trace.save("execute", state);
  if (!result.ok) throw new Error(`${label}：${result.message}`);
  await timed("wait", "rule", "等待游戏画面稳定", () => new Promise<void>((done) => setTimeout(done, 700)));
  await observe();
  const verified = await has(expected) && (await Promise.all(absent.map(has))).every((present) => !present);
  const verificationMessage = verified ? `${label}后画面符合预期` : `${label}后画面未通过独立核验`;
  state = { ...state, lastVerification: { ok: verified,
    message: verificationMessage } };
  trace.save("verify", state);
  if (!verified) throw new Error(verificationMessage);
}

try {
  runtime = await manager.attach({ windowTitle: "炉石传说", windowClass: "UnityWndClass" });
  const probe = await manager.state(runtime);
  const first = await observe();
  if (probe.processPath?.toLowerCase().split(/[\\/]/).at(-1) !== "hearthstone.exe" ||
      probe.uiaControls || !probe.permissionsCompatible ||
      first.windowRect?.width !== 2825 || first.windowRect?.height !== 1543 ||
      !(await has(gear)) || await has(menuHeading) || await has(heading)) {
    throw new Error("游戏窗口、布局或起始画面不符合本次已核对的条件");
  }
  await actionStep("打开游戏菜单", target(gear), menuHeading);
  await actionStep("打开设置页", target(options), heading);
  await actionStep("关闭设置页", { kind: "keypress", keys: "esc" }, menuHeading, [heading]);
  await actionStep("关闭菜单并返回起点", { kind: "keypress", keys: "esc" }, gear, [menuHeading, heading]);
  state = { ...state, status: "done", summary: "《炉石传说》设置页已打开并返回起点，未修改设置",
    goalVerification: { ok: true, message: "设置页与返回画面均经截图模板核验" } };
  trace.save("finish", state);
} catch (error) {
  state = { ...state, status: "failed", error: String(error), summary: "《炉石传说》设置页测试未完成" };
  trace.save("task_error", state);
  process.exitCode = 1;
} finally {
  await runtime?.close();
  trace.close();
}
console.log(JSON.stringify({ taskId, status: state.status, error: state.error,
  screenshot: state.observation?.screenshot, trace: resolve(root, "hearthstone-settings.sqlite") }, null, 2));
