import { createHash } from "node:crypto";
import type { ComputerAction, Observation, Target } from "../actions/schema.js";
import { semanticTarget } from "../actions/semantic-target.js";
import type { CapabilityEnvironment } from "../capabilities/registry.js";
import type { ComputerState } from "../graph/state.js";
import type { TraceStore } from "../contracts/stores.js";
import { verifyStructuredEquals } from "./structured-evidence.js";
import { extractDesktopFileContract, extractDurableContract } from "./durable-contract.js";
import { digitButtonName, digitsFromSequence, isDigitButtonName, operatorChoices,
  operatorKindOf } from "./parameterization.js";
import type { Workflow, WorkflowStep, WorkflowStepCondition } from "./schema.js";

function semanticAction(action: ComputerAction): boolean {
  if (action.kind === "drag") return action.source.kind !== "coordinate" &&
    action.destination.kind !== "coordinate";
  if (action.kind === "scroll" && action.target) return action.target.kind !== "coordinate" &&
    action.target.kind !== "candidates" &&
    (action.target.kind !== "vision" || action.target.description.trim().length >= 2);
  if (action.kind !== "click" && action.kind !== "double_click" && action.kind !== "type" &&
      action.kind !== "paste_text" && action.kind !== "set_checked" &&
      action.kind !== "select_option") return true;
  const target = action.target;
  return target.kind !== "coordinate" && target.kind !== "candidates" &&
    (target.kind !== "vision" || target.description.trim().length >= 2 &&
      !target.description.startsWith("template:"));
}

function method(action: ComputerAction): string[] {
  if (action.kind === "click" || action.kind === "double_click" || action.kind === "type" ||
      action.kind === "paste_text" || action.kind === "set_checked" ||
      action.kind === "select_option" || action.kind === "scroll" && action.target) {
    return [action.target!.kind === "selector" ? "selector" :
      action.target!.kind === "vision" ? "vision" : "accessibility"];
  }
  return [action.kind === "navigate" ? "browser" : "keyboard"];
}

function hint(action: ComputerAction): Target | undefined {
  return action.kind === "click" || action.kind === "double_click" || action.kind === "type" ||
      action.kind === "paste_text" || action.kind === "set_checked" ||
      action.kind === "select_option" || action.kind === "scroll" && action.target
    ? action.target as Target : undefined;
}

function stepGoal(action: ComputerAction): string {
  switch (action.kind) {
    case "navigate": return `打开 ${action.url}`;
    case "click": case "double_click": {
      const target = hint(action);
      const name = target && ("name" in target ? target.name : "label" in target ? target.label
        : "text" in target ? target.text : "selector" in target ? target.selector
          : "description" in target ? target.description : undefined);
      return `${action.kind === "click" ? "点击" : "双击"} ${name ?? "目标控件"}`;
    }
    case "set_checked": {
      const target = hint(action);
      const name = target && ("name" in target ? target.name : "label" in target ? target.label
        : "text" in target ? target.text : "selector" in target ? target.selector
          : "description" in target ? target.description : undefined);
      return `${action.checked ? "勾选" : "取消勾选"} ${name ?? "目标控件"}`;
    }
    case "select_option": {
      const target = hint(action);
      const name = target && ("name" in target ? target.name : "label" in target ? target.label
        : "text" in target ? target.text : "selector" in target ? target.selector
          : "description" in target ? target.description : undefined);
      return `选择 ${name ?? "目标控件"} 为 ${action.option}`;
    }
    case "type": case "paste_text": return `输入 ${action.text}`;
    case "keypress": return `按 ${action.keys}`;
    case "scroll": return `${action.direction === "down" ? "向下" : "向上"}滚动`;
    default: return action.kind;
  }
}

/** URL 条件值归一化为 pathname（去掉 origin/端口/query/hash），使浏览器 Workflow 跨端口、跨
 *  参数回放稳定；URL 条件只锁定路径，业务参数值由页面文本/DOM 条件负责验证。 */
export function normalizeUrlConditionValue(value: string): string {
  try { return new URL(value).pathname; } catch { return value; }
}

/** URL 条件值的编码变体：字面 / encodeURI（保留结构字符）/ decodeURIComponent（容错非编码串）。 */
function urlConditionVariants(value: string): string[] {
  const variants: string[] = [value];
  try { variants.push(encodeURI(value)); } catch { /* 忽略 */ }
  try { variants.push(decodeURIComponent(value)); } catch { /* 忽略 */ }
  return [...new Set(variants)];
}

/** URL 观察是否满足 includes 条件：路径归一化后匹配（兼容新旧条件值，含带 query 的旧值）。 */
function urlEvidenceMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  if (actual.includes(expected)) return true;
  try {
    const path = new URL(actual).pathname;
    const normalized = normalizeUrlConditionValue(expected);
    return urlConditionVariants(normalized).some((variant) => path.includes(variant));
  } catch { return false; }
}

/** URL 观察是否满足 equals 条件：路径归一化后相等（兼容新旧条件值）。 */
function urlEvidenceEquals(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  if (actual === expected) return true;
  try {
    const path = new URL(actual).pathname;
    const normalized = normalizeUrlConditionValue(expected);
    return urlConditionVariants(normalized).some((variant) => path === variant);
  } catch { return false; }
}

function condition(action: ComputerAction, before?: Observation, after?: Observation): WorkflowStepCondition {
  if (action.kind === "navigate") {
    const url = new URL(action.url);
    // URL 条件归一化为 pathname（去掉 origin/端口/query）：跨端口/跨参数 replay 稳定。
    return { kind: "url_includes", value: url.pathname };
  }
  if (action.kind === "set_checked") {
    // 勾选步骤的语义条件：当次完整 DOM 枚举中唯一 checkbox 的 checked 严格等于期望。
    const target = action.target;
    if (target.kind === "role" && target.name) {
      return { kind: "structured_equals", source: "dom" as const, target,
        field: "checked" as const, expected: action.checked };
    }
    return { kind: "state_changed" };
  }
  if (action.kind === "select_option") {
    // 下拉步骤的语义条件：当次完整 DOM 枚举中唯一 combobox 的 value 严格等于所选选项文本。
    const target = action.target;
    if (target.kind === "role" && target.name) {
      return { kind: "structured_equals", source: "dom" as const, target,
        field: "value" as const, expected: action.option };
    }
    return { kind: "state_changed" };
  }
  if (action.kind === "type" || action.kind === "paste_text") return after?.accessibility?.includes(action.text)
    ? { kind: "accessibility_includes", value: action.text }
    : { kind: "text_includes", value: action.text };
  if (isClearAction(action) && after?.accessibility?.includes("显示为 0")) {
    return { kind: "accessibility_includes", value: "显示为 0" };
  }
  if (after?.url && before?.url !== after.url) {
    const url = new URL(after.url);
    return { kind: "url_includes", value: url.pathname };
  }
  const previousLines = new Set((before?.pageText ?? "").split(/\r?\n/).map((line) => line.trim()));
  const newLine = (after?.pageText ?? "").split(/\r?\n/).map((line) => line.trim())
    .find((line) => line.length >= 2 && line.length <= 120 && !previousLines.has(line));
  if (newLine) return { kind: "text_includes", value: newLine };
  return { kind: "state_changed" };
}

function isClearAction(action: ComputerAction): boolean {
  if (action.kind !== "click" || action.target.kind !== "role") return false;
  return /^(清除|Clear)$/i.test(action.target.name ?? "");
}

function parameterize(goal: string, steps: WorkflowStep[]): { pattern: string; inputs: Workflow["inputs"] } {
  let pattern = goal;
  const inputs: Workflow["inputs"] = [];
  for (const step of steps) {
    if (step.action.kind !== "type" && step.action.kind !== "paste_text") continue;
    const value = step.action.text.trim();
    if (value.length < 2 || !pattern.includes(value) || inputs.some((input) => input.example === value)) continue;
    const name = `input${inputs.length + 1}`;
    pattern = pattern.replaceAll(value, `{{${name}}}`);
    inputs.push({ name, example: value });
  }
  return { pattern, inputs };
}

function parameterizableStepValue(step: WorkflowStep):
  { kind: "text" | "number"; argument: "text" | "value/text"; value: string } | undefined {
  const action = step.action;
  if (action.kind === "type" || action.kind === "paste_text") {
    return { kind: "text", argument: "text", value: action.text };
  }
  if (action.kind === "scroll" && typeof action.amount === "number" && action.amount >= 0) {
    return { kind: "number", argument: "value/text", value: String(action.amount) };
  }
  if (action.kind === "wait" && action.ms >= 0) {
    return { kind: "number", argument: "value/text", value: String(action.ms) };
  }
  return undefined;
}

function clickTargetName(step: WorkflowStep): string | undefined {
  const action = step.action;
  if (action.kind !== "click" && action.kind !== "double_click") return undefined;
  const target = action.target;
  if (!target || target.kind === "candidates" || target.kind === "coordinate") return undefined;
  return "name" in target ? target.name : "label" in target ? target.label
    : "text" in target ? target.text : "selector" in target ? target.selector
      : "description" in target ? target.description : undefined;
}

/** v2 参数化：数字序列（连续数字按钮点击）→ number/digit_sequence；运算符按钮 → choice；
 *  browser 表单（勾选→bool、下拉→choice）；type/scroll/wait → text/number。
 *  每个参数显式绑定 stepId + argument，绝不按数组下标。 */
function parameterizeV2(goal: string, steps: WorkflowStep[],
  selectOptionsByStep?: ReadonlyMap<string, string[]>):
  { pattern: string; inputs: Workflow["inputs"]; steps: WorkflowStep[] } {
  let pattern = goal;
  const inputs: Workflow["inputs"] = [];
  const boundStepIds = new Set<string>();
  let remaining = steps;

  // 1) 数字序列：连续数字按钮点击段，且 goal 含对应数字串（三,七 → "37"）。
  //    保留段首为锚点（digit_sequence 绑定），其余数字步骤从定义移除，由注入按值展开。
  const sequences: Array<{ start: number; end: number; digits: string; anchorStepId: string }> = [];
  {
    let i = 0;
    while (i < remaining.length) {
      const anchor = remaining[i];
      const anchorName = anchor.stepId && !boundStepIds.has(anchor.stepId)
        ? clickTargetName(anchor) : undefined;
      if (anchorName && isDigitButtonName(anchorName)) {
        let j = i;
        const names: string[] = [];
        while (j < remaining.length) {
          const step = remaining[j];
          const name = step.stepId && !boundStepIds.has(step.stepId)
            ? clickTargetName(step) : undefined;
          if (!name || !isDigitButtonName(name)) break;
          names.push(name);
          j++;
        }
        const digits = digitsFromSequence(names);
        if (digits && pattern.includes(digits)) {
          sequences.push({ start: i, end: j - 1, digits, anchorStepId: remaining[i].stepId! });
          i = j;
          continue;
        }
      }
      i++;
    }
  }
  for (const sequence of [...sequences].reverse()) {
    for (let index = sequence.end; index > sequence.start; index--) {
      remaining = remaining.filter((_, itemIndex) => itemIndex !== index);
    }
  }
  for (const sequence of sequences) {
    const name = `input${inputs.length + 1}`;
    pattern = pattern.replaceAll(sequence.digits, `{{${name}}}`);
    inputs.push({ name, example: sequence.digits, kind: "number",
      boundTo: { stepId: sequence.anchorStepId, argument: "digit_sequence" } });
    boundStepIds.add(sequence.anchorStepId);
  }

  // 2) 运算符按钮 → choice（通用运算符类别；候选与锚点同语言，标准顺序）。
  for (const step of remaining) {
    if (!step.stepId || boundStepIds.has(step.stepId)) continue;
    const name = clickTargetName(step);
    if (!name) continue;
    const kind = operatorKindOf(name);
    if (!kind) continue;
    const inputName = `input${inputs.length + 1}`;
    pattern = pattern.replaceAll(name, `{{${inputName}}}`);
    inputs.push({ name: inputName, example: name, kind: "choice",
      choices: operatorChoices(kind, name),
      boundTo: { stepId: step.stepId, argument: "choice" } });
    boundStepIds.add(step.stepId);
  }

  // 2b) browser 表单：勾选步骤 → bool；下拉步骤 → choice（候选取当次 DOM 枚举的 options）。
  //     占位语义：勾选步骤把「控件名+探索状态词」替换为「控件名+{{inputN}}」（捕获是/否 → true/false）；
  //     下拉步骤把选项文本替换为 {{inputN}}（捕获的选项文本必须在 choices 内）。
  for (const step of remaining) {
    if (!step.stepId || boundStepIds.has(step.stepId)) continue;
    if (step.action.kind !== "set_checked") continue;
    const target = step.action.target;
    if (target.kind !== "role" || !("name" in target) || !target.name) continue;
    const controlName = target.name;
    if (!pattern.includes(controlName)) continue;
    const marker = step.action.checked ? "是" : "否";
    const span = `${controlName} ${marker}`;
    if (!pattern.includes(span)) continue;
    const name = `input${inputs.length + 1}`;
    pattern = pattern.replaceAll(span, `${controlName} {{${name}}}`);
    inputs.push({ name, example: marker, kind: "bool",
      boundTo: { stepId: step.stepId, argument: "checked" } });
    boundStepIds.add(step.stepId);
  }
  for (const step of remaining) {
    if (!step.stepId || boundStepIds.has(step.stepId)) continue;
    if (step.action.kind !== "select_option") continue;
    const target = step.action.target;
    if (target.kind !== "role" || !("name" in target) || !target.name) continue;
    const option = step.action.option;
    if (!option || option.length < 2 || !pattern.includes(option) ||
        inputs.some((input) => input.example === option)) continue;
    const options = selectOptionsByStep?.get(step.stepId) ?? [];
    if (options.length < 2 || !options.includes(option)) continue;
    const name = `input${inputs.length + 1}`;
    pattern = pattern.replaceAll(option, `{{${name}}}`);
    inputs.push({ name, example: option, kind: "choice", choices: [...options],
      boundTo: { stepId: step.stepId, argument: "choice" } });
    boundStepIds.add(step.stepId);
  }

  // 3) 文本/数值字段（type/scroll/wait）。
  for (const step of remaining) {
    if (!step.stepId || boundStepIds.has(step.stepId)) continue;
    const candidate = parameterizableStepValue(step);
    if (!candidate) continue;
    const value = candidate.value.trim();
    if (value.length < 2 || !pattern.includes(value) ||
        inputs.some((input) => input.example === value)) continue;
    const name = `input${inputs.length + 1}`;
    pattern = pattern.replaceAll(value, `{{${name}}}`);
    inputs.push({ name, example: value, kind: candidate.kind,
      boundTo: { stepId: step.stepId, argument: candidate.argument } });
    boundStepIds.add(step.stepId);
  }
  return { pattern, inputs, steps: remaining };
}

function replaceStrings<T>(value: T, search: string, replacement: string): T {
  if (typeof value === "string") return value.replaceAll(search, replacement) as T;
  if (Array.isArray(value)) return value.map((item) => replaceStrings(item, search, replacement)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, replaceStrings(item, search, replacement)])) as T;
  return value;
}

/** 仅从模型驱动且独立验收成功的轨迹提炼候选；坐标/模板不能作为主要流程。 */
export function distillWorkflow(trace: TraceStore, taskId: string, sourceTrace: string,
  environment: CapabilityEnvironment, stage?: {
    goal: string; successCondition: string; startStep: number; endStep: number;
  }): Workflow | undefined {
  const final = trace.load(taskId);
  if (!final || final.humanReview?.approved || (!stage && (final.status !== "done" || !final.goalVerification?.ok ||
      !final.completionCriteria)) || !trace.metrics(taskId).some((metric) =>
      metric.node === "decide" && metric.actor === "model" &&
      (!stage || metric.step > stage.startStep && metric.step <= stage.endStep))) {
    return undefined;
  }
  const events = trace.events(taskId).filter((event) => !stage ||
    event.step > stage.startStep && event.step <= stage.endStep);
  // 回放动作即使成功发出，也可能未达到该步骤的语义条件；它不能进入修订版。
  const executed = events.filter((event, index) => {
    if (event.node !== "execute" || !event.state.lastResult?.ok) return false;
    const following = events.slice(index + 1).filter((next) => next.step === event.step);
    return following.some((next) => next.node === "verify" && next.state.lastVerification?.ok) &&
      !following.some((next) => next.node === "workflow_step_rejected");
  });
  const steps: WorkflowStep[] = [];
  for (const item of executed) {
    const state = item.state;
    const action = state.lastAction && semanticAction(state.lastAction)
      ? state.lastAction : state.groundedAction ?? state.lastAction;
    if (!action || !semanticAction(action)) return undefined;
    if (action.kind === "screenshot" || action.kind === "wait") continue;
    if (action.kind === "ask_user" || action.kind === "done") return undefined;
    const next = events.find((event) => event.step === item.step && event.node === "observe" &&
      event.state.observation && events.indexOf(event) > events.indexOf(item));
    const before = state.beforeObservation;
    const after = next?.state.observation;
    if (!after) return undefined;
    const fallbackEvidence = state.groundingStrategy ? [`定位策略：${state.groundingStrategy}`] : [];
    if (action.kind === "click" || action.kind === "double_click") {
      if (action.target.kind === "vision" && state.groundedAction &&
          (state.groundedAction.kind === "click" || state.groundedAction.kind === "double_click") &&
          state.groundedAction.target.kind === "coordinate") {
        fallbackEvidence.push(`来源截图：${before?.screenshot ?? "未记录"}`);
        fallbackEvidence.push(`来源坐标（仅证据）：${state.groundedAction.target.x},${state.groundedAction.target.y}`);
      }
    }
    const targetHint = hint(action);
    const semantic = state.targetBinding?.semantic ?? (targetHint ? semanticTarget(targetHint) : undefined);
    steps.push({ goal: stepGoal(action), action, preferredMethods: method(action),
      ...(targetHint ? { targetHint } : {}),
      ...(semantic ? { semanticTarget: semantic } : {}),
      successCondition: condition(action, before, after),
      ...(isClearAction(action) ? { idempotent: true } : {}),
      fallbackEvidence,
    });
  }
  if (!steps.length) return undefined;
  const { pattern, inputs } = parameterize(stage?.goal ?? final.goal, steps);
  for (const input of inputs) {
    for (const step of steps) {
      step.goal = step.goal.replaceAll(input.example, `{{${input.name}}}`);
      step.action = replaceStrings(step.action, input.example, `{{${input.name}}}`);
      if (step.targetHint) step.targetHint = replaceStrings(step.targetHint, input.example,
        `{{${input.name}}}`);
      if (step.semanticTarget) step.semanticTarget = replaceStrings(step.semanticTarget, input.example,
        `{{${input.name}}}`);
      if ("value" in step.successCondition && typeof step.successCondition.value === "string") {
        const conditionValue = step.successCondition.value;
        // URL 条件（url_includes）pathname 中的中文以 encodeURIComponent 形式存在
        // （如 /wiki/%E5%9B%B4%E6%A3%8B）：参数化同时替换字面与编码形式，否则参数变体回放时
        // URL 条件仍冻结在探索值上（query-sensitive contract，P9-A1 真实站点暴露）。
        step.successCondition.value = step.successCondition.kind === "url_includes"
          ? conditionValue.replaceAll(encodeURIComponent(input.example), `{{${input.name}}}`)
            .replaceAll(input.example, `{{${input.name}}}`)
          : conditionValue.replaceAll(input.example, `{{${input.name}}}`);
      }
    }
  }
  const preconditions: Workflow["preconditions"] = [];
  const first = stage
    ? events.find((event) => event.node === "execute")?.state.beforeObservation
    : events.find((event) => event.node === "observe")?.state.observation;
  if (environment === "browser" && first?.url && first.url !== "about:blank") {
    preconditions.push({ kind: "url_host", value: new URL(first.url).hostname });
  }
  if (environment === "windows" && first?.windowTitle) {
    preconditions.push({ kind: "window_title", value: first.windowTitle });
  }
  const knownFailures = [...new Set(events.filter((event) => event.node === "recover")
    .map((event) => event.state.error).filter((error): error is string => !!error))].slice(0, 10);
  const id = createHash("sha256").update(`${environment}\0${stage ? "stage" : "task"}\0${pattern}`)
    .digest("hex").slice(0, 24);
  const successConditions = structuredClone(stage ? {} : final.completionCriteria!);
  let stageCondition = stage?.successCondition;
  for (const input of inputs) {
    if (stageCondition) stageCondition = stageCondition.replaceAll(input.example, `{{${input.name}}}`);
    for (const [key, value] of Object.entries(successConditions)) {
      if (typeof value === "string") (successConditions as Record<string, unknown>)[key] =
        value.replaceAll(input.example, `{{${input.name}}}`);
    }
  }
  return { id, version: 1, status: "candidate", environment, taskPattern: pattern,
    ...(stage ? { scope: "stage" as const, stageCondition } : {}),
    inputs, preconditions, steps, successConditions,
    knownFailures, sourceTaskId: taskId, sourceTrace, createdAt: new Date().toISOString(),
    successCount: 0, failureCount: 0 };
}

/** v2 蒸馏：与 v1 相同的只从模型驱动且独立验收成功的轨迹提炼，但产 v2 泛化格式
 * （steps 持久化 stepId、inputs 带 kind + boundTo 参数绑定）。 */
export function distillWorkflowV2(trace: TraceStore, taskId: string, sourceTrace: string,
  environment: CapabilityEnvironment, stage?: {
    goal: string; successCondition: string; startStep: number; endStep: number;
  }): Workflow | undefined {
  const final = trace.load(taskId);
  if (!final || final.humanReview?.approved || (!stage && (final.status !== "done" || !final.goalVerification?.ok ||
      !final.completionCriteria)) || !trace.metrics(taskId).some((metric) =>
      metric.node === "decide" && metric.actor === "model" &&
      (!stage || metric.step > stage.startStep && metric.step <= stage.endStep))) {
    return undefined;
  }
  const events = trace.events(taskId).filter((event) => !stage ||
    event.step > stage.startStep && event.step <= stage.endStep);
  const executed = events.filter((event, index) => {
    if (event.node !== "execute" || !event.state.lastResult?.ok) return false;
    const following = events.slice(index + 1).filter((next) => next.step === event.step);
    return following.some((next) => next.node === "verify" && next.state.lastVerification?.ok) &&
      !following.some((next) => next.node === "workflow_step_rejected");
  });
  const steps: WorkflowStep[] = [];
  const selectOptionsByStep = new Map<string, string[]>();
  for (const item of executed) {
    const state = item.state;
    const action = state.lastAction && semanticAction(state.lastAction)
      ? state.lastAction : state.groundedAction ?? state.lastAction;
    if (!action || !semanticAction(action)) return undefined;
    if (action.kind === "screenshot" || action.kind === "wait") continue;
    if (action.kind === "ask_user" || action.kind === "done") return undefined;
    const next = events.find((event) => event.step === item.step && event.node === "observe" &&
      event.state.observation && events.indexOf(event) > events.indexOf(item));
    const before = state.beforeObservation;
    const after = next?.state.observation;
    if (!after) return undefined;
    const fallbackEvidence = state.groundingStrategy ? [`定位策略：${state.groundingStrategy}`] : [];
    if (action.kind === "click" || action.kind === "double_click") {
      if (action.target.kind === "vision" && state.groundedAction &&
          (state.groundedAction.kind === "click" || state.groundedAction.kind === "double_click") &&
          state.groundedAction.target.kind === "coordinate") {
        fallbackEvidence.push(`来源截图：${before?.screenshot ?? "未记录"}`);
        fallbackEvidence.push(`来源坐标（仅证据）：${state.groundedAction.target.x},${state.groundedAction.target.y}`);
      }
    }
    const targetHint = hint(action);
    const semantic = state.targetBinding?.semantic ?? (targetHint ? semanticTarget(targetHint) : undefined);
    const stepIdValue = `step-${steps.length + 1}-` + createHash("sha256")
      .update(`${environment}\0${item.step}\0${stepGoal(action)}`).digest("hex").slice(0, 8);
    // 下拉步骤的候选选项取自该步骤动作后的当次完整 DOM 枚举（只读 options 字段，不读 fixture 模式）。
    if (action.kind === "select_option" && action.target.kind === "role" &&
        "name" in action.target && action.target.name) {
      const targetName = action.target.name;
      const subject = after.structured?.items.find((item) =>
        item.role === "combobox" && item.name === targetName);
      if (subject?.options?.length) selectOptionsByStep.set(stepIdValue, [...subject.options]);
    }
    steps.push({ stepId: stepIdValue, goal: stepGoal(action), action, preferredMethods: method(action),
      ...(targetHint ? { targetHint } : {}),
      ...(semantic ? { semanticTarget: semantic } : {}),
      successCondition: condition(action, before, after),
      ...(isClearAction(action) || action.kind === "set_checked" || action.kind === "select_option"
        ? { idempotent: true } : {}),
      fallbackEvidence,
    });
  }
  if (!steps.length) return undefined;
  // URL 条件（navigate 目标、点击后置条件/成功条件）归一化为 path+search：去掉 origin/端口，
  // 使浏览器 Workflow 可跨端口/跨实例（不同测试服务、不同本地端口）回放。
  for (const step of steps) {
    const action = step.action;
    if ("postcondition" in action && action.postcondition &&
        (action.postcondition.kind === "url_equals" || action.postcondition.kind === "url_includes")) {
      action.postcondition.value = normalizeUrlConditionValue(action.postcondition.value);
    }
    if (step.successCondition.kind === "url_includes") {
      step.successCondition.value = normalizeUrlConditionValue(step.successCondition.value);
    }
  }
  const { pattern, inputs, steps: parameterizedSteps } =
    parameterizeV2(stage?.goal ?? final.goal, steps, selectOptionsByStep);
  const stepsToUse = parameterizedSteps;
  for (const input of inputs) {
    if (!input.boundTo) continue;
    const step = stepsToUse.find((item) => item.stepId === input.boundTo!.stepId);
    if (step) {
      step.goal = step.goal.replaceAll(input.example, `{{${input.name}}}`);
      step.action = replaceStrings(step.action, input.example, `{{${input.name}}}`);
      if (step.targetHint) step.targetHint = replaceStrings(step.targetHint, input.example,
        `{{${input.name}}}`);
      if (step.semanticTarget) step.semanticTarget = replaceStrings(step.semanticTarget, input.example,
        `{{${input.name}}}`);
      if ("value" in step.successCondition && typeof step.successCondition.value === "string") {
        const conditionValue = step.successCondition.value;
        // URL 条件（url_includes）pathname 中的中文以 encodeURIComponent 形式存在
        // （如 /wiki/%E5%9B%B4%E6%A3%8B）：参数化同时替换字面与编码形式，否则参数变体回放时
        // URL 条件仍冻结在探索值上（query-sensitive contract，P9-A1 真实站点暴露）。
        step.successCondition.value = step.successCondition.kind === "url_includes"
          ? conditionValue.replaceAll(encodeURIComponent(input.example), `{{${input.name}}}`)
            .replaceAll(input.example, `{{${input.name}}}`)
          : conditionValue.replaceAll(input.example, `{{${input.name}}}`);
      }
      // 结构化条件（browser 表单勾选/下拉）的参数化：expected 文本同样按参数示例替换，
      // 否则参数变体回放时步骤成功条件仍冻结在探索值上。
      if (step.successCondition.kind === "structured_equals" &&
          typeof step.successCondition.expected === "string") {
        step.successCondition.expected = step.successCondition.expected.replaceAll(input.example,
          `{{${input.name}}}`);
      }
    }
    // URL 条件参数化不限于 boundTo 步骤：keypress/navigate 等非输入步骤的 URL 条件
    // 也可能携带参数示例的编码形式（如 /wiki/%E5%9B%B4%E6%A3%8B），必须同步参数化，
    // 否则参数变体回放时 URL 条件仍冻结在探索值上（query-sensitive contract）。
    for (const candidateStep of stepsToUse) {
      if (candidateStep.successCondition.kind === "url_includes" &&
          typeof candidateStep.successCondition.value === "string" &&
          candidateStep.successCondition.value.includes(encodeURIComponent(input.example))) {
        candidateStep.successCondition.value = candidateStep.successCondition.value
          .replaceAll(encodeURIComponent(input.example), `{{${input.name}}}`)
          .replaceAll(input.example, `{{${input.name}}}`);
      }
    }
  }
  // 点击步骤的文本快照（动作后新行/数字屏回显）是参数相关或结果快照：含参数示例、
  // 与任务级完成条件文本重叠（"显示为 95" ⊇ "95"）、或含数字回显（"显示为 3"）时，
  // 参数变体回放不得以旧文本判定步骤成功 → 降级 state_changed（步骤只证明状态改变，
  // 最终结果由当次任务完成验证 verify_task / requiredConditions 裁决）。
  const completionTexts = Object.values(final.completionCriteria ?? {})
    .filter((value): value is string => typeof value === "string");
  for (const step of stepsToUse) {
    const cond = step.successCondition;
    if (cond.kind !== "text_includes" && cond.kind !== "accessibility_includes") continue;
    if (typeof cond.value !== "string") continue;
    if (step.action.kind !== "click" && step.action.kind !== "double_click") continue;
    const paramRelated = inputs.some((input) => cond.value!.includes(input.example));
    const resultSnapshot = completionTexts.some((text) =>
      cond.value!.includes(text) && cond.value!.length > text.length);
    const numericRevert = /\d/.test(cond.value!);
    if (paramRelated || resultSnapshot || numericRevert) {
      step.successCondition = { kind: "state_changed" };
    }
  }
  const preconditions: Workflow["preconditions"] = [];
  const first = stage
    ? events.find((event) => event.node === "execute")?.state.beforeObservation
    : events.find((event) => event.node === "observe")?.state.observation;
  if (environment === "browser" && first?.url && first.url !== "about:blank") {
    preconditions.push({ kind: "url_host", value: new URL(first.url).hostname });
  }
  if (environment === "windows" && first?.windowTitle) {
    preconditions.push({ kind: "window_title", value: first.windowTitle });
  }
  const knownFailures = [...new Set(events.filter((event) => event.node === "recover")
    .map((event) => event.state.error).filter((error): error is string => !!error))].slice(0, 10);
  const id = createHash("sha256").update(`${environment}\0${stage ? "stage" : "task"}\0${pattern}`)
    .digest("hex").slice(0, 24);
  const successConditions = structuredClone(stage ? {} : final.completionCriteria!);
  let stageCondition = stage?.successCondition;
  for (const input of inputs) {
    if (stageCondition) stageCondition = stageCondition.replaceAll(input.example, `{{${input.name}}}`);
    for (const [key, value] of Object.entries(successConditions)) {
      if (typeof value === "string") (successConditions as Record<string, unknown>)[key] =
        value.replaceAll(input.example, `{{${input.name}}}`);
    }
  }
  // B3-5：持久化契约只从替换后的冻结完成条件与步骤后置条件提取（绝不从 goal 猜），证明仍由核心承担。
  const durableContract = [
    ...extractDurableContract(successConditions),
    ...extractDesktopFileContract(stepsToUse),
  ];
  return { id, version: 1, workflowSchemaVersion: 2, status: "candidate", environment,
    taskPattern: pattern, ...(stage ? { scope: "stage" as const, stageCondition } : {}),
    inputs, preconditions, steps: stepsToUse, successConditions,
    ...(durableContract.length ? { durableContract } : {}),
    knownFailures, sourceTaskId: taskId, sourceTrace, createdAt: new Date().toISOString(),
    successCount: 0, failureCount: 0 };
}

export function verifyWorkflowStep(step: WorkflowStep, before: Observation | undefined,
  after: Observation | undefined): boolean {
  if (!after) return false;
  switch (step.successCondition.kind) {
    case "url_includes": return urlEvidenceMatches(after.url, step.successCondition.value);
    case "text_includes": return !!after.pageText?.includes(step.successCondition.value);
    case "accessibility_includes": return !!after.accessibility?.includes(step.successCondition.value);
    case "state_changed": return before?.url !== after.url || before?.pageText !== after.pageText ||
      before?.accessibility !== after.accessibility || before?.dom !== after.dom ||
      (!!before?.screenshotHash && before.screenshotHash !== after.screenshotHash);
    case "checked_equals": {
      // 勾选期望必须基于当次完整结构化枚举：incomplete/无目标控件/不唯一 一律不算达成。
      const structured = after.structured;
      if (!structured || structured.complete !== true) return false;
      const target = step.successCondition.target;
      if (target.kind !== "role" || !target.name) return false;
      const matches = structured.items.filter((item) =>
        item.role === target.role && item.name === target.name);
      if (matches.length !== 1) return false;
      return matches[0].checked === step.successCondition.value;
    }
    case "structured_equals":
      // 当次完整枚举 + source 匹配 + 唯一 subject + 字段严格相等；stale/incomplete/ambiguous 全部 fail closed。
      return verifyStructuredEquals(after, step.successCondition);
  }
}
