import type { ComputerAction, GroundingAttempt, GroundingResult, Observation, Target } from "../../actions/schema.js";
import type { ActionResolution } from "../../actions/action-resolution.js";
import type { TokenUsage } from "../../agent/model-adapter.js";
import type { PlanningModel } from "../../contracts/model-provider.js";
import type { RuntimeAdapter } from "../runtime-adapter.js";
import type { DesktopProbe } from "./desktop-runtime.js";
import type {DesktopFileSnapshot} from '../../verification/file-evidence.js';
import { isBudgetExceeded } from '../model-budget.js';

export interface VisionDesktopRuntime extends RuntimeAdapter {
  observe(screenCapture?: boolean): Promise<Observation>;
  probe(focus?: boolean): Promise<DesktopProbe>;
  close(): Promise<void>;
  ground(action: ComputerAction): Promise<GroundingResult>;
  resolveAction(action: ComputerAction): Promise<ActionResolution>;
  recoverFocus(): Promise<void>;
  restore(observation: Observation): Promise<void>;
}

type VisualMetric = { actor: "model"; operator: string; modelName: string } & TokenUsage;

/** UIA 优先；缺少结构化控件时才用模型观察截图并提议窗口内坐标。 */
export class DesktopVisionRuntime implements RuntimeAdapter {
  readonly name = "Windows UIA + 视觉";
  private metric?: VisualMetric;
  private lastOcrHash?: string;
  private lastOcrText?: string;

  constructor(private readonly desktop: VisionDesktopRuntime, private readonly vision: PlanningModel) {}

  inspectFile(path:string):Promise<DesktopFileSnapshot> {
    if(!this.desktop.inspectFile)throw new Error('Guest file evidence unavailable');
    return this.desktop.inspectFile(path);
  }

  takeOperationMetric(): VisualMetric | undefined {
    const value = this.metric;
    this.metric = undefined;
    return value;
  }

  async observe(): Promise<Observation> {
    this.metric = undefined;
    const snapshot = await this.desktop.observe(true);
    if (!snapshot.screenshot) return snapshot;
    if (snapshot.screenshotHash === this.lastOcrHash && this.lastOcrText !== undefined) {
      return { ...snapshot, pageText: [snapshot.pageText, this.lastOcrText].filter(Boolean).join("\n"),
        textEvidence: [...(snapshot.textEvidence ?? []),
          { source: "visual_model", text: this.lastOcrText }] };
    }
    this.metric = { actor: "model", operator: "截图文字识别", modelName: this.vision.name ?? "视觉模型" };
    let result;
    try { result = await this.vision.transcribeScreenshot(snapshot.screenshot); }
    catch (error) {
      this.metric = { ...this.metric, ...this.vision.takeVisualUsage() };
      throw error;
    }
    this.lastOcrHash = snapshot.screenshotHash;
    this.lastOcrText = result.text;
    this.metric = { actor: "model", operator: "截图文字识别", modelName: this.vision.name ?? "视觉模型",
      ...result.usage };
    this.vision.takeVisualUsage();
    return { ...snapshot, pageText: [snapshot.pageText, result.text].filter(Boolean).join("\n"),
      textEvidence: [...(snapshot.textEvidence ?? []), { source: "visual_model", text: result.text }] };
  }

  async ground(action: ComputerAction): Promise<GroundingResult> {
    this.metric = undefined;
    if (action.kind !== "click" && action.kind !== "double_click" && action.kind !== "type" &&
        action.kind !== "paste_text" && !(action.kind === "scroll" && action.target)) {
      return this.desktop.ground(action);
    }
    const spec = action.target!;
    const targets = spec.kind === "candidates" ? spec.options : [spec];
    const structured = targets.filter((item) => item.kind !== "vision");
    const attempts: GroundingAttempt[] = [];
    if (structured.length) {
      const first = await this.desktop.ground({ ...action,
        target: structured.length === 1 ? structured[0] : { kind: "candidates", options: structured } });
      attempts.push(...first.attempts);
      if (first.target) return { target: first.target, attempts };
    }
    for (const target of targets) {
      if (target.kind !== "vision") continue;
      const attempt: GroundingAttempt = { strategy: "vision", matched: false,
        selected: false, detail: "" };
      attempts.push(attempt);
      if (action.kind === "type" || action.kind === "paste_text") {
        attempt.detail = "视觉目标不能直接输入"; continue;
      }
      try {
        const snapshot = await this.desktop.observe(true);
        if (!snapshot.screenshot) throw new Error("没有窗口截图");
        this.metric = { actor: "model", operator: "截图目标定位", modelName: this.vision.name ?? "视觉模型" };
        const located = await this.vision.locateVisualTarget(snapshot.screenshot, target.description);
        this.metric = { actor: "model", operator: "截图目标定位", modelName: this.vision.name ?? "视觉模型",
          ...located.usage };
        this.vision.takeVisualUsage();
        const coordinate: Target = { kind: "coordinate", x: located.x, y: located.y };
        const bounded = await this.desktop.ground({ ...action, target: coordinate });
        if (!bounded.target) throw new Error("视觉位置未通过窗口边界检查");
        attempt.matched = true;
        attempt.selected = true;
        attempt.detail = `截图定位置信度 ${located.confidence.toFixed(2)}；窗口边界已检查`;
        return { target: coordinate, attempts };
      } catch (error) {
        if (this.metric) this.metric = { ...this.metric, ...this.vision.takeVisualUsage() };
        if (isBudgetExceeded(error)) throw error;
        if (/目标窗口.*前台|目标窗口前台/.test(String(error))) throw error;
        attempt.detail = String(error);
      }
    }
    return { attempts };
  }

  execute(action: ComputerAction, resolution?: ActionResolution) { return this.desktop.execute(action, resolution); }
  resolveAction(action: ComputerAction) { return this.desktop.resolveAction(action); }
  recoverFocus() { return this.desktop.recoverFocus(); }
  restore(observation: Observation) { return this.desktop.restore(observation); }
  close() { return this.desktop.close(); }
}
