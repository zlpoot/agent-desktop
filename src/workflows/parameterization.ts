import type { ComputerAction, Target } from "../actions/schema.js";
import type { Workflow, WorkflowInput, WorkflowInputValue, WorkflowStep } from "./schema.js";

function isFiniteNumber(value: WorkflowInputValue): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 通用数字按钮命名：value 为阿拉伯数字字符，variants 为可访问性标准命名的常见变体
 * （0=阿拉伯、1=中文大写）。任何数字键盘型 UI（计算器/取款机/拨号器）都适用同一映射，
 * 不是 calc 专属逻辑。
 */
export const DIGIT_BUTTON_GROUPS: ReadonlyArray<readonly string[]> = [
  ["0", "零"], ["1", "一"], ["2", "二"], ["3", "三"], ["4", "四"],
  ["5", "五"], ["6", "六"], ["7", "七"], ["8", "八"], ["9", "九"],
];

/** 通用运算符类别（人类数学语义；变体=语言/符号命名）。锚点按钮名所属类别决定 choice 候选语言。 */
export const OPERATOR_KINDS: ReadonlyArray<{ kind: string; zh: string; symbol: string; en: string }> = [
  { kind: "add", zh: "加", symbol: "+", en: "add" },
  { kind: "sub", zh: "减", symbol: "-", en: "subtract" },
  { kind: "mul", zh: "乘", symbol: "*", en: "multiply" },
  { kind: "div", zh: "除以", symbol: "/", en: "divide" },
];

/** 返回数字按钮名（按锚点按钮的变体推断；未知变体回退阿拉伯）。 */
export function digitButtonName(digit: string, anchorName: string): string {
  const group = DIGIT_BUTTON_GROUPS.find((item) => item[0] === digit);
  if (!group) throw new Error(`无法把数字位 ${digit} 映射为按钮名`);
  const anchorGroup = DIGIT_BUTTON_GROUPS.find((item) => item.includes(anchorName));
  const variant = anchorGroup?.indexOf(anchorName) ?? -1;
  return group[variant >= 0 ? variant : 0];
}

/** 判断按钮名是否为数字按钮（任意变体）。 */
export function isDigitButtonName(name: string): boolean {
  return DIGIT_BUTTON_GROUPS.some((item) => item.includes(name));
}

/** 数字按钮序列 → 数值字符串（三,七 → "37"）。 */
export function digitsFromSequence(names: readonly string[]): string | undefined {
  let out = "";
  for (const name of names) {
    const group = DIGIT_BUTTON_GROUPS.find((item) => item.includes(name));
    if (!group) return undefined;
    out += group[0];
  }
  return out;
}

/** 运算符按钮名 → 运算符类别（非运算符返回 undefined）。 */
export function operatorKindOf(name: string): string | undefined {
  return OPERATOR_KINDS.find((item) => item.zh === name || item.symbol === name || item.en === name)?.kind;
}

/** 运算符类别 → 与锚点同语言的候选按钮名（按标准顺序）。 */
export function operatorChoices(kind: string, anchorName: string): string[] {
  const language = OPERATOR_KINDS.find((item) => item.zh === anchorName) ? "zh"
    : OPERATOR_KINDS.find((item) => item.symbol === anchorName) ? "symbol" : "en";
  return OPERATOR_KINDS.map((item) => item[language]);
}

function targetText(target: Target): string | undefined {
  switch (target.kind) {
    case "role": return target.name;
    case "label": return target.label;
    case "text": return target.text;
    case "selector": return target.selector;
    case "vision": return target.description;
    default: return undefined;
  }
}

/** v2 流程参数定义的静态校验：boundTo.stepId 必须存在、argument 合法、choice 候选完整。 */
export function validateWorkflowInputDefinition(workflow: Workflow): void {
  if (workflow.workflowSchemaVersion !== 2) return;
  const byId = new Map(workflow.steps.map((step) => [step.stepId, step]));
  for (const input of workflow.inputs) {
    const kind = input.kind ?? "text";
    if (kind === "choice" && (!input.choices || input.choices.length < 2 ||
        !input.choices.includes(input.example))) {
      throw new Error(`choice 参数 ${input.name} 必须声明至少两个候选且包含 example`);
    }
    if (!input.boundTo) continue;
    const targetStep = byId.get(input.boundTo.stepId);
    if (!targetStep) throw new Error(`参数 ${input.name} 绑定步骤 ${input.boundTo.stepId} 不存在`);
    const { argument } = input.boundTo;
    if (argument !== "text" && argument !== "value/text" && argument !== "choice" &&
        argument !== "checked" && argument !== "digit_sequence") {
      throw new Error(`参数 ${input.name} 使用了非法 argument ${argument}`);
    }
    if (argument === "checked" && kind !== "bool")
      throw new Error(`参数 ${input.name}：argument=checked 要求 kind=bool`);
    if (argument === "choice" && kind !== "choice")
      throw new Error(`参数 ${input.name}：argument=choice 要求 kind=choice`);
    if (argument === "digit_sequence" && kind !== "number")
      throw new Error(`参数 ${input.name}：argument=digit_sequence 要求 kind=number`);
    const action = targetStep.action;
    const isClick = action.kind === "click" || action.kind === "double_click";
    const isToggle = isClick || action.kind === "set_checked";
    const isSelect = action.kind === "select_option";
    if ((argument === "checked" || argument === "choice") && !isToggle && !isSelect)
      throw new Error(`参数 ${input.name}：argument=${argument} 的步骤必须点击单个控件或调用通用设置动作`);
    if ((argument === "checked" || argument === "choice") &&
        "target" in action && action.target && action.target.kind === "candidates")
      throw new Error(`参数 ${input.name}：argument=${argument} 不适用于多候选点击`);
    if (argument === "checked" && action.kind === "select_option")
      throw new Error(`参数 ${input.name}：argument=checked 不适用于下拉选择步骤`);
    if (argument === "choice" && action.kind === "set_checked")
      throw new Error(`参数 ${input.name}：argument=choice 不适用于勾选步骤`);
    if (argument === "digit_sequence" && !isClick)
      throw new Error(`参数 ${input.name}：argument=digit_sequence 的锚点步骤必须点击单个控件`);
    if (argument === "digit_sequence" && "target" in action && action.target &&
        !(action.target.kind === "candidates" || action.target.kind === "coordinate") &&
        !isDigitButtonName(targetText(action.target as Target) ?? "")) {
      throw new Error(`参数 ${input.name}：argument=digit_sequence 的锚点必须是数字按钮（数字键盘型 UI 通用语义）`);
    }
  }
}

/** Replay 前参数完整性与类型校验：缺参/非有限数/非法布尔/choice 不符，全部在动作前拒绝。 */
export function validateWorkflowInputValues(workflow: Workflow,
  values: Record<string, WorkflowInputValue>): void {
  const names = new Set(workflow.inputs.map((input) => input.name));
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("参数必须为对象");
  for (const input of workflow.inputs) {
    if (!Object.hasOwn(values, input.name)) throw new Error(`缺少参数 ${input.name}，不执行`);
    const value = values[input.name];
    const kind = input.kind ?? "text";
    switch (kind) {
      case "text":
        if (typeof value !== "string" || !value.trim() || value.length > 300)
          throw new Error(`参数 ${input.name} 必须是 1-300 字符文本`);
        break;
      case "number":
        if (!isFiniteNumber(value))
          throw new Error(`参数 ${input.name} 必须是有限数字`);
        break;
      case "bool":
        if (typeof value !== "boolean")
          throw new Error(`参数 ${input.name} 必须是布尔值`);
        break;
      case "choice": {
        if (typeof value !== "string" || !input.choices?.includes(value))
          throw new Error(`参数 ${input.name} 必须是候选之一：${input.choices?.join(" | ") ?? "无"}`);
        break;
      }
      default: throw new Error(`参数 ${input.name} 使用了未知类型 ${String(kind)}`);
    }
  }
  for (const name of Object.keys(values)) {
    if (!names.has(name)) throw new Error(`未知参数 ${name}`);
  }
}

function injectTargetText(target: Target, value: string): Target {
  switch (target.kind) {
    case "role": return { ...target, name: value };
    case "label": return { ...target, label: value };
    case "text": return { ...target, text: value };
    case "selector": return { ...target, selector: value };
    case "vision": return { ...target, description: value };
    default: throw new Error(`目标类型 ${target.kind} 不可参数化`);
  }
}

function injectTextAction(action: ComputerAction, text: string): ComputerAction {
  switch (action.kind) {
    case "type": case "paste_text": return { ...action, text };
    case "navigate": return { ...action, url: text };
    case "keypress": return { ...action, keys: text };
    case "ask_user": return { ...action, question: text };
    case "done": return { ...action, summary: text };
    case "click": case "double_click":
      if (action.target.kind !== "candidates")
        return { ...action, target: injectTargetText(action.target, text) };
      throw new Error("text 参数不适用于多候选点击");
    default: throw new Error(`动作 ${action.kind} 不接受 text 参数`);
  }
}

function injectBinding(step: WorkflowStep, input: WorkflowInput,
  value: WorkflowInputValue): WorkflowStep[] {
  const kind = input.kind ?? "text";
  const action = step.action;
  if (kind === "number" && input.boundTo?.argument === "digit_sequence") {
    // 数字值按位展开为数字按钮序列点击：位数任意（1..N），非负整数；锚点步骤被 N 个
    // 展开步骤替换，展开步骤以 state_changed 为通用条件（完成证明仍由 completionCriteria 把关）。
    const n = value as number;
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`参数 ${input.name} 的 digit_sequence 只接受非负整数，收到 ${String(value)}`);
    }
    if ((action.kind !== "click" && action.kind !== "double_click") ||
        "target" in action && action.target && action.target.kind === "candidates") {
      throw new Error(`参数 ${input.name} 的 digit_sequence 锚点必须是点击单个控件`);
    }
    const anchorName = "target" in action && action.target
      ? targetText(action.target as Target) : undefined;
    if (!anchorName) throw new Error(`参数 ${input.name} 的 digit_sequence 锚点缺少目标文本`);
    const digits = String(n);
    return digits.split("").map((digit, index) => ({
      stepId: `${step.stepId}:digit:${index + 1}`,
      goal: `点击 ${digitButtonName(digit, anchorName)}`,
      action: { ...action, target: injectTargetText(action.target as Target,
        digitButtonName(digit, anchorName)) },
      preferredMethods: step.preferredMethods,
      successCondition: { kind: "state_changed" as const },
    }));
  }
  const single = injectSingle(step, input, value);
  return [single];
}

function injectSingle(step: WorkflowStep, input: WorkflowInput,
  value: WorkflowInputValue): WorkflowStep {
  const kind = input.kind ?? "text";
  const action = step.action;
  if (kind === "number") {
    const n = value as number;
    if (action.kind === "scroll") return { ...step, action: { ...action, amount: n } };
    if (action.kind === "wait") return { ...step, action: { ...action, ms: n } };
    return { ...step, action: injectTextAction(action, String(n)) };
  }
  if (kind === "bool") {
    if (action.kind === "set_checked") {
      // 通用勾选设置：只替换期望布尔值，执行层按「当前≠期望才点击」设置，绝不盲目 toggle。
      return { ...step, action: { ...action, checked: value as boolean },
        successCondition: { kind: "structured_equals", source: "dom",
          target: structuredClone(action.target as Target), field: "checked",
          expected: value as boolean } };
    }
    if ((action.kind === "click" || action.kind === "double_click") &&
        action.target.kind !== "candidates") {
      return { ...step, successCondition: { kind: "checked_equals",
        target: structuredClone(action.target), value: value as boolean } };
    }
    throw new Error("bool 参数需要点击单个控件或通用勾选设置步骤");
  }
  if (kind === "choice") {
    if (action.kind === "select_option") {
      // 通用下拉选择：替换目标选项文本，执行层按 label 选择真实 option。
      return { ...step, action: { ...action, option: String(value) },
        successCondition: { kind: "structured_equals", source: "dom",
          target: structuredClone(action.target as Target), field: "value",
          expected: String(value) } };
    }
    if ((action.kind === "click" || action.kind === "double_click") &&
        action.target.kind !== "candidates") {
      return { ...step, action: { ...action, target: injectTargetText(action.target, String(value)) } };
    }
    throw new Error("choice 参数需要点击单个控件或通用下拉选择步骤");
  }
  return { ...step, action: injectTextAction(action, String(value)) };
}

/**
 * v2 typed 参数注入：按 input.boundTo（stepId + argument）把值注入对应步骤，
 * 绝不按数组下标绑定；随后对 goal/taskPattern/successConditions/preconditions/
 * stageCondition 做 {{name}} 占位符替换。注入前先做定义与值校验，全部 fail-closed。
 */
export function applyWorkflowInputs(workflow: Workflow,
  values: Record<string, WorkflowInputValue>): Workflow {
  if (workflow.workflowSchemaVersion !== 2) throw new Error("typed 参数化仅适用于 v2 流程");
  validateWorkflowInputDefinition(workflow);
  validateWorkflowInputValues(workflow, values);
  let steps = workflow.steps;
  for (const input of workflow.inputs) {
    if (!input.boundTo) continue;
    const index = steps.findIndex((step) => step.stepId === input.boundTo!.stepId);
    if (index < 0) throw new Error(`参数绑定步骤 ${input.boundTo.stepId} 不存在`);
    const injected = injectBinding(steps[index], input, values[input.name]);
    steps = [...steps.slice(0, index), ...injected, ...steps.slice(index + 1)];
  }
  const substitute = (value: string): string => value.replace(/\{\{([a-z][a-z0-9]*)\}\}/gi,
    (_, name: string) => {
      const replacement = values[name];
      if (replacement === undefined) throw new Error(`流程输入 ${name} 未提供`);
      return String(replacement);
    });
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return substitute(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, walk(item)]));
    return value;
  };
  const copy: Workflow = { ...workflow, steps };
  copy.steps = steps.map((step) => ({ ...step, goal: substitute(step.goal),
    action: walk(step.action) as typeof step.action,
    ...(step.semanticTarget ? { semanticTarget: walk(step.semanticTarget) as typeof step.semanticTarget } : {}),
    successCondition: walk(step.successCondition) as typeof step.successCondition }));
  copy.successConditions = walk(copy.successConditions) as typeof copy.successConditions;
  copy.preconditions = walk(copy.preconditions) as typeof copy.preconditions;
  if(copy.durableContract)copy.durableContract=walk(copy.durableContract) as typeof copy.durableContract;
  if (copy.stageCondition) copy.stageCondition = substitute(copy.stageCondition);
  return copy;
}

/** 把匹配得到的参数值按 input.kind 规整（number/bool 转换），非法则拒绝。 */
export function coerceMatchedInputs(workflow: Workflow,
  matched: Record<string, WorkflowInputValue>): Record<string, WorkflowInputValue> {
  const typed: Record<string, WorkflowInputValue> = {};
  for (const input of workflow.inputs) {
    const raw = matched[input.name];
    if (raw === undefined) throw new Error(`流程输入 ${input.name} 未匹配到值`);
    const kind = input.kind ?? "text";
    if (kind === "number") {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) throw new Error(`参数 ${input.name} 必须解析为有限数字`);
      typed[input.name] = n;
    } else if (kind === "bool") {
      if (typeof raw === "boolean") typed[input.name] = raw;
      else {
        const normalized = String(raw).trim().toLowerCase();
        if (normalized === "true" || normalized === "是" || normalized === "1") typed[input.name] = true;
        else if (normalized === "false" || normalized === "否" || normalized === "0") typed[input.name] = false;
        else throw new Error(`参数 ${input.name} 无法解析为布尔值：${raw}`);
      }
    } else if (kind === "choice") {
      if (input.choices && !input.choices.some((choice) => String(choice) === String(raw))) {
        throw new Error(`参数 ${input.name} 必须是候选之一：${input.choices.join(" / ")}（收到：${raw}）`);
      }
      typed[input.name] = raw;
    } else {
      typed[input.name] = raw;
    }
  }
  return typed;
}
