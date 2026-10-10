import type { ActionPostcondition, ComputerAction, Observation, Target, TargetSpec } from "../actions/schema.js";
import { readFile } from "node:fs/promises";
import type { ComputerState } from "../graph/state.js";
import type { ModelAdapter, TokenUsage } from "./model-adapter.js";
import type { WindowInfo } from "../runtime/desktop/desktop-runtime.js";
import type { RegisteredApp } from "../runtime/desktop/app-catalog.js";
import { parseTaskPlan, type PlannedTask } from "./task-planner.js";
import { readPrompt } from "./prompt-store.js";
import type { Workflow, WorkflowMatch } from "../workflows/schema.js";
import type { CompletionCriteria } from "../verifier/verifier.js";
import { meteredModelRequest } from "../runtime/model-budget.js";
import { compactObservationFacets } from "../contracts/facets.js";
import {parseEvidencePlan,type EvidencePlan} from '../verification/planner-contract.js';

/** Reference clock, explicitly scoped to the Host; never a claim about Guest state. */
function runtimeContext() {
  const now = new Date();
  return { clock: { source: 'host', iso: now.toISOString(), localTime: now.toString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } };
}

function compactLastResult(result?: ComputerState["lastResult"]) {
  return result && { ok: result.ok, message: result.message,
    effect: result.effect, provider: result.provider };
}

export interface ChatCompletionsOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  allowedHosts?: string[];
  taskInstructions?: string;
  timeoutMs?: number;
  environment?: "browser" | "desktop";
  visualMode?: boolean;
}

export class TaskPlanningError extends Error {
  constructor(message: string, readonly usage?: TokenUsage) { super(message); this.name = "TaskPlanningError"; }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型动作不是 JSON 对象");
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`模型动作缺少 ${name}`);
  return value;
}

function target(value: unknown): TargetSpec {
  const item = object(value);
  switch (item.kind) {
    case "role": return { kind: "role", role: string(item.role, "role"),
      ...(item.name === undefined ? {} : { name: string(item.name, "name") }) };
    case "label": return { kind: "label", label: string(item.label, "label") };
    case "text": return { kind: "text", text: string(item.text, "text") };
    case "selector": return { kind: "selector", selector: string(item.selector, "selector") };
    case "vision": return { kind: "vision", description: string(item.description, "description") };
    case "candidates": {
      if (!Array.isArray(item.options) || !item.options.length || item.options.length > 8) {
        throw new Error("候选目标数量无效");
      }
      const options = item.options.map(target);
      if (options.some((option) => option.kind === "candidates")) throw new Error("候选目标不能嵌套");
      return { kind: "candidates", options: options as Target[] };
    }
    default: throw new Error("模型目标类型不受支持");
  }
}

function postcondition(value:unknown):ActionPostcondition|undefined {
  if(value===undefined)return;
  const item=object(value);
  if(item.kind==='url_equals'||item.kind==='url_includes') {
    const expected=string(item.value,'postcondition.value').trim();
    if(expected.length>300||item.kind==='url_includes'&&!(/^https?:\/\//i.test(expected)||/^\/[^/]/.test(expected)))
      throw new Error('URL 后置条件必须是完整网址或明确路径');
    if(item.kind==='url_equals') {
      const url=new URL(expected);
      if(!/^https?:$/.test(url.protocol))throw new Error('URL 后置条件只支持 HTTP(S)');
      return {kind:item.kind,value:url.href};
    }
    if(/^https?:\/\//i.test(expected)) {
      const url=new URL(expected);
      if(!/^https?:$/.test(url.protocol))throw new Error('URL 后置条件只支持 HTTP(S)');
    }
    return {kind:item.kind,value:expected};
  }
  if(item.kind==='uia_present') {
    const selected=target(item.target);
    if(selected.kind==='candidates'||selected.kind==='vision'||selected.kind==='coordinate'||
      selected.kind==='role'&&!selected.name)throw new Error('UIA 后置条件需要可唯一辨认的结构化目标');
    return {kind:'uia_present',target:selected};
  }
  if(item.kind==='desktop_file') {
    const path=string(item.path,'postcondition.path').trim();
    if(path.length>260||!path||path.includes('..')||/[\r\n\0]/.test(path))
      throw new Error('桌面文件后置条件路径无效');
    const contentEquals=item.contentEquals===undefined?undefined:string(item.contentEquals,'postcondition.contentEquals');
    const sha256=item.sha256===undefined?undefined:string(item.sha256,'postcondition.sha256');
    if(contentEquals!==undefined&&contentEquals.length>4096||sha256!==undefined&&!/^[0-9a-f]{64}$/i.test(sha256))
      throw new Error('桌面文件后置条件内容或 SHA256 无效');
    return {kind:'desktop_file',path,...(contentEquals===undefined?{}:{contentEquals}),
      ...(sha256===undefined?{}:{sha256:sha256.toLowerCase()})};
  }
  throw new Error('不支持的动作后置条件');
}

export function parseModelAction(content: string, allowedHosts?: readonly string[]): ComputerAction {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let item: Record<string, unknown>;
  try { item = object(JSON.parse(trimmed)); }
  catch { throw new Error("模型没有返回有效的动作 JSON"); }
  switch (item.kind) {
    case "navigate": {
      const url = new URL(string(item.url, "url"));
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只允许打开 HTTP(S) 网页");
      if (allowedHosts?.length && !allowedHosts.some((host) =>
        url.hostname === host || url.hostname.endsWith(`.${host}`))) {
        throw new Error(`网址不在允许范围：${url.hostname}`);
      }
      return { kind: "navigate", url: url.href };
    }
    case "click": return { kind: "click", target: target(item.target),
      ...(item.postcondition===undefined?{}:{postcondition:postcondition(item.postcondition)}) };
    case "double_click": return { kind: "double_click", target: target(item.target),
      ...(item.postcondition===undefined?{}:{postcondition:postcondition(item.postcondition)}) };
    case "type": return { kind: "type", target: target(item.target), text: string(item.text, "text") };
    case "paste_text": return { kind: "paste_text", target: target(item.target), text: string(item.text, "text") };
    case "set_checked":
      if (typeof item.checked !== "boolean") throw new Error("勾选设置必须为布尔值");
      return { kind: "set_checked", target: target(item.target), checked: item.checked };
    case "select_option":
      if (typeof item.option !== "string" || !item.option.trim() || item.option.length > 300)
        throw new Error("下拉选择选项无效");
      return { kind: "select_option", target: target(item.target), option: item.option.trim() };
    case "drag": {
      const source = target(item.source);
      const destination = target(item.destination);
      if (source.kind === "candidates" || destination.kind === "candidates" ||
          source.kind === "vision" || destination.kind === "vision") {
        throw new Error("拖拽需要两个明确的结构化目标");
      }
      return { kind: "drag", source, destination };
    }
    case "keypress": return { kind: "keypress", keys: string(item.keys, "keys"),
      ...(item.postcondition===undefined?{}:{postcondition:postcondition(item.postcondition)}) };
    case "scroll":
      if (item.direction !== "up" && item.direction !== "down") throw new Error("滚动方向无效");
      if (typeof item.amount !== "number" || !Number.isFinite(item.amount)) throw new Error("滚动距离无效");
      return { kind: "scroll", direction: item.direction, amount: item.amount,
        ...(item.target === undefined ? {} : { target: target(item.target) }) };
    case "wait":
      if (typeof item.ms !== "number" || !Number.isFinite(item.ms) || item.ms < 0) throw new Error("等待时长无效");
      return { kind: "wait", ms: item.ms };
    case "screenshot": return { kind: "screenshot" };
    case "ask_user": return { kind: "ask_user", question: string(item.question, "question") };
    case "done": return { kind: "done", summary: string(item.summary, "summary") };
    default: throw new Error("模型动作类型不受支持");
  }
}

export class ChatCompletionsModel implements ModelAdapter {
  readonly kind = "model";
  readonly name: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private lastUsage?: TokenUsage;
  private lastVisualUsage?: TokenUsage;
  constructor(private readonly options: ChatCompletionsOptions) {
    this.name = options.model;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 45000;
    if (!options.apiKey) throw new Error("缺少模型服务 API Key");
  }

  private async request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const invoke = async () => {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.options.apiKey}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}) },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`模型服务返回 HTTP ${response.status}`);
    return object(body);
    };
    return path === '/models' ? invoke() : meteredModelRequest('deepseek', invoke);
  }

  private usage(body: Record<string, unknown>): TokenUsage | undefined {
    if (!body.usage || typeof body.usage !== "object" || Array.isArray(body.usage)) return undefined;
    const usage = body.usage as Record<string, unknown>;
    const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value : undefined;
    const inputTokens = number(usage.prompt_tokens);
    const outputTokens = number(usage.completion_tokens);
    return { inputTokens, outputTokens,
      totalTokens: number(usage.total_tokens) ??
        (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined) };
  }

  private output(body: Record<string, unknown>): string {
    const first = Array.isArray(body.choices) ? body.choices[0] as { message?: { content?: unknown } } : undefined;
    if (typeof first?.message?.content !== "string") throw new Error("模型未返回文本");
    return first.message.content;
  }

  private async image(path: string): Promise<{ url: string; width: number; height: number }> {
    const png = await readFile(path);
    if (png.length > 5 * 1024 * 1024 || png.length < 24 ||
        png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error("视觉输入必须是 5 MB 内的 PNG 截图");
    }
    return { url: `data:image/png;base64,${png.toString("base64")}`,
      width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  }

  private async visionRequest(path: string, instruction: string): Promise<{
    content: string; usage?: TokenUsage; width: number; height: number;
  }> {
    this.lastVisualUsage = undefined;
    const image = await this.image(path);
    const body = await this.request("/chat/completions", { method: "POST", body: JSON.stringify({
      model: this.options.model, messages: [{ role: "system", content: instruction },
        { role: "user", content: [{ type: "text", text: `截图尺寸 ${image.width}×${image.height} 像素。` },
          { type: "image_url", image_url: { url: image.url } }] }],
    }) });
    this.lastVisualUsage = this.usage(body);
    return { content: this.output(body), usage: this.lastVisualUsage,
      width: image.width, height: image.height };
  }

  takeVisualUsage(): TokenUsage | undefined {
    const usage = this.lastVisualUsage;
    this.lastVisualUsage = undefined;
    return usage;
  }

  async transcribeScreenshot(path: string): Promise<{ text: string; usage?: TokenUsage }> {
    const result = await this.visionRequest(path, readPrompt("vision-ocr"));
    let value: unknown;
    try { value = JSON.parse(result.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
    catch { throw new Error("视觉文字识别未返回 JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        typeof (value as { text?: unknown }).text !== "string") throw new Error("视觉文字识别结果无效");
    return { text: (value as { text: string }).text.slice(0, 30000), usage: result.usage };
  }

  async locateVisualTarget(path: string, description: string): Promise<{
    x: number; y: number; confidence: number; usage?: TokenUsage;
  }> {
    const result = await this.visionRequest(path,
      readPrompt("vision-locate").replaceAll("{{description}}", description));
    let value: unknown;
    try { value = JSON.parse(result.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
    catch { throw new Error("视觉定位器未返回 JSON"); }
    const item = value as { visible?: unknown; unique?: unknown; box?: unknown; confidence?: unknown };
    if (!item || item.visible !== true || item.unique !== true || !Array.isArray(item.box) ||
        item.box.length !== 4 || item.box.some((entry) => typeof entry !== "number" || !Number.isFinite(entry)) ||
        typeof item.confidence !== "number" || item.confidence < 0.75 || item.confidence > 1) {
      throw new Error("视觉目标不存在、不唯一或置信度不足");
    }
    const [left, top, right, bottom] = item.box as number[];
    if (!(0 <= left && left < right && right <= result.width &&
          0 <= top && top < bottom && bottom <= result.height)) {
      throw new Error("视觉定位框超出截图或面积无效");
    }
    return { x: Math.floor((left + right) / 2), y: Math.floor((top + bottom) / 2),
      confidence: item.confidence, usage: result.usage };
  }

  async checkConnection(): Promise<void> {
    const body = await this.request("/models");
    if (!Array.isArray(body.data) || !body.data.some((item) =>
      item && typeof item === "object" && (item as { id?: unknown }).id === this.options.model)) {
      throw new Error(`模型列表中未找到 ${this.options.model}`);
    }
  }

  async planTask(goal: string, windows: readonly WindowInfo[] = [],
    apps: readonly RegisteredApp[] = [], criteriaOverride?: CompletionCriteria): Promise<{
    task: PlannedTask; usage?: TokenUsage;
  }> {
    const visible = windows.filter((window) => window.visible && !window.minimized);
    const body = await this.request("/chat/completions", { method: "POST", body: JSON.stringify({
      model: this.options.model,
      messages: [{ role: "system", content: readPrompt("task-planner") },
        { role: "user", content: JSON.stringify({ goal, runtimeContext: runtimeContext(),
          executionEnvironment:this.options.environment,
          availableEvidence:this.options.environment==='browser'?['browser','dom']:undefined,
          observation: { windows: visible.map((window) => ({
          handle: window.handle, title: window.title, windowClass: window.windowClass,
          processPath: window.processPath, foreground: window.foreground,
        })), registeredApps: apps.map((app) => ({ id: app.id, name: app.name })) }, recentHistory: [], constraints: {
          allowOnlyVisibleWindowsOrRegisteredApps: true, requireIndependentCompletionCriteria: true,
          requireFrozenVerificationContract: true,
          highImpactActionsRequireApproval: true,
        } }) }],
    }) });
    const first = Array.isArray(body.choices) ? body.choices[0] as { message?: { content?: unknown } } : undefined;
    if (typeof first?.message?.content !== "string") throw new Error("任务规划器未返回文本");
    const usage = body.usage && typeof body.usage === "object" && !Array.isArray(body.usage)
      ? body.usage as Record<string, unknown> : undefined;
    const tokens = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value : undefined;
    const recordedUsage = usage ? {
      inputTokens: tokens(usage.prompt_tokens), outputTokens: tokens(usage.completion_tokens),
      totalTokens: tokens(usage.total_tokens),
    } : undefined;
    try { return { task: parseTaskPlan(first.message.content, visible, goal, apps, criteriaOverride),
      usage: recordedUsage }; }
    catch (error) { throw new TaskPlanningError(error instanceof Error ? error.message : "任务规划结果无效",
      recordedUsage); }
  }

  async matchWorkflows(goal: string, workflows: readonly Workflow[]): Promise<{
    match?: WorkflowMatch; usage?: TokenUsage;
  }> {
    const candidates = workflows.filter((item) => item.status !== "retired").slice(0, 20);
    if (!candidates.length) return {};
    const body = await this.request("/chat/completions", { method: "POST", body: JSON.stringify({
      model: this.options.model,
      messages: [{ role: "system", content: readPrompt("workflow-match") },
        { role: "user", content: JSON.stringify({ goal,
          workflows: candidates.map((item) => ({ id: item.id, version: item.version,
            status: item.status, taskPattern: item.taskPattern, inputs: item.inputs })) }) }],
    }) });
    const usage = this.usage(body);
    let value: unknown;
    try { value = JSON.parse(this.output(body).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
    catch { return { usage }; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return { usage };
    const item = value as Record<string, unknown>;
    const workflow = candidates.find((candidate) => candidate.id === item.workflow_id &&
      candidate.version === item.version);
    if (!workflow || !item.inputs || typeof item.inputs !== "object" || Array.isArray(item.inputs)) {
      if (workflow?.inputs.length === 0 && (item.inputs === undefined || item.inputs === null)) {
        return { match: { workflow, values: {}, score: 0.75 }, usage };
      }
      return { usage };
    }
    const proposed = item.inputs as Record<string, unknown>;
    if (Object.keys(proposed).length !== workflow.inputs.length) return { usage };
    const values: Record<string, string> = {};
    for (const input of workflow.inputs) {
      const entry = proposed[input.name];
      if (typeof entry !== "string" || !entry.trim() || entry.length > 300 || !goal.includes(entry.trim())) {
        return { usage };
      }
      values[input.name] = entry.trim();
    }
    return { match: { workflow, values, score: 0.75 }, usage };
  }

  async planStage(state: Readonly<ComputerState>): Promise<{
    goal: string; successCondition: string; isFinal: boolean; usage?: TokenUsage; verification?:EvidencePlan }> {
    const observation = state.observation;
    const content = JSON.stringify({ goal: state.goal, runtimeContext: runtimeContext(), recentHistory: state.recentHistory?.slice(-8), target: state.taskContract?.target,
      constraint: state.taskContract?.constraint,
      completionCriteria: state.completionCriteria,
      evidenceSources:state.verificationContract?.evidenceSources,
      environment:state.taskContract?.environment??this.options.environment,
      completedStages: state.completedStages?.map(({ goal, evidence }) => ({ goal, evidence })) ?? [],
      previousStage: state.stage?.goal, failure: state.error, diagnosis: state.diagnosis,
      pageText: observation?.pageText?.slice(0, 6000),
      accessibility: observation?.accessibility?.slice(0, 6000),
      url:observation?.url,dom:observation?.dom?.slice(0,6000),
      capture:observation?.capture,windowTitle: observation?.windowTitle });
    const userContent = observation?.screenshot
      ? [{ type: "text", text: content },
        { type: "image_url", image_url: { url: (await this.image(observation.screenshot)).url } }]
      : content;
    const body = await this.request("/chat/completions", { method: "POST", body: JSON.stringify({
      model: this.options.model, messages: [
        { role: "system", content: readPrompt("stage-planner") },
        { role: "user", content: userContent }],
    }) });
    const item = object(JSON.parse(this.output(body).trim().replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")));
    const goal = string(item.goal, "阶段目标").trim();
    const successCondition = string(item.successCondition, "阶段完成条件").trim();
    if (goal.length > 160 || successCondition.length > 200 || typeof item.isFinal !== "boolean") {
      throw new Error("阶段规划格式无效");
    }
    this.lastUsage = this.usage(body);
    return { goal, successCondition, isFinal: item.isFinal, usage: this.lastUsage,
      verification:parseEvidencePlan(item.verification,['stage-result']) };
  }

  async verifyStage(stage: NonNullable<ComputerState["stage"]>, observation: Observation): Promise<{
    ok: boolean; confidence: number; evidence: string;
    source: "uia" | "dom" | "visual_model"; usage?: TokenUsage }> {
    if (observation.dom?.includes(stage.successCondition)) {
      return { ok: true, confidence: 1, evidence: stage.successCondition, source: "dom" };
    }
    if (observation.accessibility?.includes(stage.successCondition)) {
      return { ok: true, confidence: 1, evidence: stage.successCondition,
        source: observation.url ? "dom" : "uia" };
    }
    const verificationScreenshot = observation.desktopScreenshot ?? observation.screenshot;
    if (!verificationScreenshot) return { ok: false, confidence: 0,
      evidence: "没有窗口截图", source: "visual_model" };
    const result = await this.visionRequest(verificationScreenshot,
      `${readPrompt("stage-verifier")}\n阶段目标：${stage.goal}\n成功条件：${stage.successCondition}`);
    this.lastUsage = result.usage;
    const item = object(JSON.parse(result.content.trim().replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")));
    const confidence = typeof item.confidence === "number" ? item.confidence : 0;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error("阶段验收置信度无效");
    }
    return { ok: item.ok === true && confidence >= 0.8,
      confidence, evidence: typeof item.evidence === "string" ? item.evidence.slice(0, 300) : "",
      source: "visual_model", usage: result.usage };
  }

  async reconcileStage(state: Readonly<ComputerState>): Promise<{
    decision: "continue" | "skip" | "replan"; evidence: string; usage?: TokenUsage }> {
    if (!state.stage || !state.observation?.screenshot) {
      return { decision: "replan", evidence: "缺少当前阶段或截图" };
    }
    const result = await this.visionRequest(state.observation.screenshot,
      `${readPrompt("stage-reconcile")}\n总目标：${state.goal}\n任务约束：${state.taskContract?.constraint ?? ""}\n当前阶段：${state.stage.goal}`);
    const item = object(JSON.parse(result.content.trim().replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")));
    this.lastUsage = result.usage;
    return { decision: item.decision === "skip" || item.decision === "continue"
      ? item.decision : "replan",
      evidence: typeof item.evidence === "string" ? item.evidence.slice(0, 300) : "未提供依据",
      usage: result.usage };
  }

  async diagnoseStage(state: Readonly<ComputerState>): Promise<{
    decision: "continue" | "replan"; reason: string; remedy: string; usage?: TokenUsage }> {
    if (!state.stage || !state.observation?.screenshot) throw new Error("阶段诊断缺少当前截图");
    const context = { goal: state.goal, runtimeContext: runtimeContext(), completionCriteria: state.completionCriteria, stage: state.stage.goal,
      constraint: state.taskContract?.constraint,
      successCondition: state.stage.successCondition,
      lastStageEvidence: state.lastStageVerification?.evidence,
      lastAction: state.lastAction, lastResult: compactLastResult(state.lastResult),
      recentHistory: state.recentHistory?.slice(-5),
      beforeText: state.beforeObservation?.pageText?.slice(-3500),
      currentText: state.observation.pageText?.slice(-3500),
      previousDiagnosis: state.diagnosis };
    const result = await this.visionRequest(state.observation.screenshot,
      `${readPrompt("stage-diagnosis")}\n上下文：${JSON.stringify(context)}`);
    const item = object(JSON.parse(result.content.trim().replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")));
    const reason = string(item.reason, "原因").trim().slice(0, 300);
    const remedy = string(item.remedy, "解决策略").trim().slice(0, 300);
    this.lastUsage = result.usage;
    return { decision: item.decision === "replan" ? "replan" : "continue",
      reason, remedy, usage: result.usage };
  }

  async decide(state: Readonly<ComputerState>): Promise<ComputerAction> {
    this.lastUsage = undefined;
    const observation = state.observation;
    const desktop = this.options.environment === "desktop";
    // The previous execution may embed an entire stale UIA/DOM observation.
    // The current observation below is the only screen state for this decision.
    const context = {
      goal: state.goal, runtimeContext: runtimeContext(), plan: state.plan, stage: state.stage,
      constraint: state.taskContract?.constraint, step: state.step,
      retryCount: state.retryCount,
      completionCriteria: state.completionCriteria, userAnswer: state.userAnswer,
      recentHistory: state.recentHistory?.slice(-8),
      lastAction: state.lastAction, lastResult: compactLastResult(state.lastResult),
      lastVerification: state.lastVerification,
      lastStageVerification: state.lastStageVerification,
      diagnosis: state.diagnosis, error: state.error,
      observation: observation && { url: observation.url, windowTitle: observation.windowTitle,
        desktopPath: observation.desktopPath,
        // 业务证据以通用 facet 信封透传：只给 id/complete/data，核心不认识任何具体域。
        facets: compactObservationFacets(observation.facets),
        pageText: observation.pageText?.slice(0, desktop ? 4000 : 12000),
        accessibility: observation.accessibility?.slice(0, 12000),
        // Guest UIA DOM repeats the accessibility tree with volatile runtime IDs
        // and rectangles. Keep browser DOM, where it is the primary evidence.
        dom: desktop ? undefined : observation.dom?.slice(0, 16000) },
    };
    const userContent = this.options.visualMode && observation?.screenshot
      ? [{ type: "text", text: JSON.stringify(context) },
        { type: "image_url", image_url: { url: (await this.image(observation.screenshot)).url } }]
      : JSON.stringify(context);
    const body = await this.request("/chat/completions", { method: "POST", body: JSON.stringify({
      model: this.options.model,
      messages: [{ role: "system", content: (this.options.environment === "desktop"
        ? readPrompt("desktop-decision") + (this.options.visualMode ? `\n${readPrompt("desktop-visual")}` : "")
        : readPrompt("browser-decision")) +
        (state.stage ? "\n当前阶段由系统在每个动作后独立验收；只有用户总目标已达成时才返回 done。" : "") +
        (this.options.taskInstructions ? `\n本任务附加要求：${this.options.taskInstructions}` : "") },
        { role: "user", content: userContent }],
    }) });
    this.lastUsage = this.usage(body);
    const action = parseModelAction(this.output(body), this.options.allowedHosts);
    if (this.options.environment === "desktop" && action.kind === "navigate") {
      throw new Error("桌面任务不支持网页导航");
    }
    return action;
  }

  takeUsage(): TokenUsage | undefined {
    const usage = this.lastUsage;
    this.lastUsage = undefined;
    return usage;
  }
}
