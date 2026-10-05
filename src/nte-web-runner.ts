import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { ComputerAction, GroundingResult, Observation } from "./actions/schema.js";
import type { ComputerState } from "./graph/state.js";
import { DesktopRuntime } from "./runtime/desktop/desktop-runtime.js";
import { WindowManager } from "./runtime/desktop/window-manager.js";
import { SqliteTrace, type NodeMetric } from "./trace/sqlite-trace.js";
import { resolveCapability, requireCapability, type CapabilityFacts } from "./capabilities/registry.js";

const taskId = process.argv[2];
if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(taskId ?? "")) {
  throw new Error("任务 ID 无效");
}
const root = process.cwd();
const trace = new SqliteTrace(resolve(root, "web-tasks.sqlite"));
let state = trace.load(taskId);
if (!state || state.status !== "running" || !/异环/.test(state.goal) || !/音量/.test(state.goal)) {
  trace.close();
  throw new Error("任务记录不是待执行的《异环》音量任务");
}
let runtime: DesktopRuntime | undefined;
const template = (name: string): ComputerAction => ({ kind: "click", target: { kind: "vision",
  description: `template:src/runtime/desktop/templates/${name}` } });

async function timed<T>(node: string, operator: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  try { return await fn(); }
  finally {
    const metric: NodeMetric = { step: state!.step, node, startedAt,
      durationMs: Math.round(performance.now() - start), actor: node === "execute" ? "runtime" : "rule",
      operator, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    trace.recordNodeMetric(taskId!, metric);
  }
}

async function observe(): Promise<Observation> {
  const observation = await timed("observe", "Desktop Runtime 截图与 UIA", () => runtime!.observe());
  state = { ...state!, observation };
  trace.save("observe", state);
  return observation;
}

async function locate(name: string): Promise<GroundingResult> {
  return timed("ground", "OpenCV 模板匹配", () => runtime!.ground(template(name)));
}

async function has(name: string, area?: { xMin: number; xMax: number; yMin: number; yMax: number }): Promise<boolean> {
  const found = await locate(name);
  const target = found.target;
  return target?.kind === "coordinate" && (!area ||
    (target.x >= area.xMin && target.x <= area.xMax && target.y >= area.yMin && target.y <= area.yMax));
}

async function actionStep(label: string, action: ComputerAction, expectedTemplate: string,
  area?: { xMin: number; xMax: number; yMin: number; yMax: number }): Promise<void> {
  state = { ...state!, step: state!.step + 1, lastAction: action, lastResult: undefined,
    lastVerification: undefined, summary: label };
  trace.save("decide", state);
  trace.recordNodeMetric(taskId!, { step: state.step, node: "decide", startedAt: new Date().toISOString(),
    durationMs: 0, actor: "rule", operator: "固定《异环》音量流程", inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  let execution = action;
  if (action.kind === "click" && action.target.kind === "vision") {
    const grounded = await timed("ground", "OpenCV 模板匹配", () => runtime!.ground(action));
    trace.recordGrounding(taskId!, state.step, grounded.attempts);
    if (!grounded.target) throw new Error(`${label}：找不到目标`);
    execution = { ...action, target: grounded.target };
    state = { ...state, groundedAction: execution, groundingStrategy: "vision" };
    trace.save("ground", state);
  }
  const result = await timed("execute", action.kind === "keypress" ? "Win32 SendInput 扫描码" :
    "Win32 SendInput 鼠标", () => runtime!.execute(execution));
  state = { ...state, lastResult: result };
  trace.save("execute", state);
  if (action.kind === "click" && action.target.kind === "vision") {
    trace.recordGroundingExecution(taskId!, state.step, result.ok);
  }
  if (!result.ok) throw new Error(`${label}：${result.message}`);
  await timed("wait", "等待游戏界面稳定", () => new Promise<void>((done) => setTimeout(done, 900)));
  await observe();
  const verified = await has(expectedTemplate, area);
  state = { ...state, lastVerification: { ok: verified,
    message: verified ? `${label}完成，画面匹配预期` : `${label}后未看到预期画面` } };
  trace.save("verify", state);
  if (!verified) throw new Error(`${label}后未看到预期画面`);
}

try {
  const manager = new WindowManager(resolve(root, ".artifacts", "web-tasks", taskId!, "screenshots"));
  runtime = await manager.attach({ windowTitle: "异环  ", windowClass: "UnrealWindow" });
  state = { ...state, step: 1, lastAction: { kind: "screenshot" }, summary: "识别已打开的游戏窗口" };
  trace.save("decide", state);
  const first = await observe();
  if (first.windowTitle?.trim() !== "异环" || first.windowRect?.width !== 1942 ||
      first.windowRect?.height !== 1136) throw new Error("只支持已核对的《异环》1920×1080 窗口布局");
  const probe = await manager.focus(runtime);
  const templates = ["nte-master-volume-50.png", "nte-master-label.png",
    "nte-audio-tab.png", "nte-settings-gear.png"];
  const facts: CapabilityFacts = { windowDiscovered: true, windowAttached: true,
    screenshotAvailable: !!first.screenshot, uiaControls: probe.uiaControls && probe.windowClass !== "UnrealWindow",
    templateAvailable: templates.every((name) => existsSync(resolve(root, "src/runtime/desktop/templates", name))),
    unrealWindow: probe.windowClass === "UnrealWindow", windowForeground: probe.foreground,
    permissionsCompatible: probe.elevated && probe.permissionsCompatible,
    deterministicIntent: true, mediaObservable: false };
  for (const operation of ["attach", "observe", "locate", "act", "choose", "verify"] as const) {
    const resolution = resolveCapability(operation, "windows", facts);
    trace.recordCapabilityResolution(taskId!, state.step, "窗口检查", resolution, facts);
    requireCapability(resolution);
  }
  state = { ...state, lastVerification: { ok: true, message: "游戏窗口与分辨率已确认" } };
  trace.save("verify", state);

  const volumeArea = { xMin: 1480, xMax: 1770, yMin: 250, yMax: 310 };
  if (!(await has("nte-master-volume-50.png", volumeArea))) {
    if (!(await has("nte-master-label.png", { xMin: 140, xMax: 260, yMin: 245, yMax: 315 }))) {
      if (!(await has("nte-audio-tab.png"))) {
        if (!(await has("nte-settings-gear.png"))) {
          await actionStep("打开游戏菜单", { kind: "keypress", keys: "esc" }, "nte-settings-gear.png");
        }
        await actionStep("打开设置页", template("nte-settings-gear.png"), "nte-audio-tab.png");
      }
      await actionStep("进入声音设置", template("nte-audio-tab.png"), "nte-master-label.png",
        { xMin: 140, xMax: 260, yMin: 245, yMax: 315 });
    }
    await actionStep("将主音量设为 50", { kind: "click", target: { kind: "coordinate", x: 1523, y: 279 } },
      "nte-master-volume-50.png", volumeArea);
  }
  state = { ...state, status: "done", summary: "《异环》主音量已设置为 50，画面数值核验通过",
    goalVerification: { ok: true, message: "声音设置页显示主音量 50；截图模板匹配通过" } };
  trace.save("finish", state);
} catch (error) {
  state = { ...state!, status: "failed", error: String(error), summary: "《异环》音量任务未完成" };
  trace.save("task_error", state);
  process.exitCode = 1;
} finally {
  await runtime?.close();
  trace.close();
}
