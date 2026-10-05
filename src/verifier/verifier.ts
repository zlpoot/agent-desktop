import type { ActionResult, ComputerAction, Observation } from "../actions/schema.js";
import {checkStructuredState} from '../verification/structured-state.js';
import type { DomainCriterion } from "../contracts/verifier-contributor.js";
import type { DomainEvaluator } from "../verification/domain-evaluator.js";

export interface VerificationResult {
  ok: boolean;
  message: string;
  evidence?: Array<{ criterion: string; source: string; strength: "strong" | "weak" | "unknown" }>;
}

export interface CompletionCriteria {
  structuredStates?: Array<{target:{role:string;name?:string;text?:string};
    field:"text"|"value"|"checked"|"classToken";equals:string|boolean;
    /**
     * 可编辑字段的持久化证明方式。rebind：仅凭「保存动作→目标缺席→以新控件身份重投影的
     * 新鲜值」证明应用接受了本次提交；当前输入框缓冲与静态结果提示均不构成证据。
     */
    persistedAfter?:"rebind"}>;
  urlIncludes?: string;
  windowTitleIncludes?: string;
  pageTextIncludes?: string;
  pageTextIncludesAll?: string[];
  pageTextNumberLabels?: string[];
  domIncludes?: string;
  accessibilityIncludes?: string;
  /**
   * 域完成条件（替代历史商品/媒体旧键）：由扩展侧 VerifierContributor 在当次、已绑定的
   * facet 证据上裁决；核心只做来源/新鲜/对象/schema 门。历史旧键由 LegacyCriteriaAdapter
   * 在读取/迁移边界转换，新任务不得再产生旧键。
   */
  domainChecks?: DomainCriterion[];
}

function changed(before: Observation | undefined, after: Observation): boolean {
  return before?.url !== after.url || before?.pageText !== after.pageText ||
    before?.dom !== after.dom || before?.accessibility !== after.accessibility ||
    (before?.screenshotHash !== undefined && after.screenshotHash !== undefined &&
      before.screenshotHash !== after.screenshotHash);
}

export function verifyAction(
  action: ComputerAction,
  execution: ActionResult | undefined,
  before: Observation | undefined,
  after: Observation | undefined,
): VerificationResult {
  if (!execution?.ok) return { ok: false, message: execution?.message ?? "动作没有执行结果" };
  if (!after) return { ok: false, message: "动作后没有新的页面观察" };
  if (action.kind === "navigate") {
    try {
      const expected = new URL(action.url);
      const actual = new URL(after.url ?? "");
      const expectedPage = expected.origin + expected.pathname + expected.search;
      const actualPage = actual.origin + actual.pathname + actual.search;
      return actualPage === expectedPage
        ? { ok: true, message: `已到达 ${after.url}` }
        : { ok: false, message: `目标页面不符：${after.url ?? "无网址"}` };
    } catch { return { ok: false, message: "无法验证导航网址" }; }
  }
  if (action.kind === "type" || action.kind === "paste_text") {
    const found = [after.accessibility, after.dom, after.pageText].some((value) => value?.includes(action.text));
    return found ? { ok: true, message: "新观察中包含输入文字" }
      : { ok: false, message: "输入后未在页面状态中找到文字" };
  }
  if (action.kind === "click" || action.kind === "double_click" || action.kind === "keypress" ||
      action.kind === "drag") {
    return changed(before, after) ? { ok: true, message: "页面状态已发生变化" }
      : { ok: false, message: "动作已执行，但页面状态未变化" };
  }
  if (action.kind === "scroll" && action.target) {
    const visibleText = (value?: string) => (value ?? "").replace(/\b\d{1,2}:\d{2}\b/g, "")
      .replace(/\s+/g, " ").trim();
    return visibleText(before?.pageText) !== visibleText(after.pageText)
      ? { ok: true, message: "滚动后可见文本已变化，仍需阶段验收" }
      : { ok: false, message: "滚动已发出，但可见文本没有变化；请检查目标区域或方向" };
  }
  return { ok: true, message: "动作已执行，并已重新观察页面" };
}

export function verifyGoal(
  criteria: CompletionCriteria | undefined,
  observation: Observation | undefined,
  evaluateDomain?: DomainEvaluator,
): VerificationResult {
  if (!observation) return { ok: false, message: "没有可用于完成验证的页面观察" };
  if (!criteria || !Object.values(criteria).some((value) =>
    typeof value === "number" || typeof value === "boolean" ||
    typeof value === "string" && value.length > 0 ||
    Array.isArray(value) && value.length > 0)) {
    return { ok: false, message: "未配置独立的任务完成条件" };
  }
  const evidence: NonNullable<VerificationResult["evidence"]> = [];
  const textSource = (value: string) => observation.textEvidence?.find((item) =>
    item.source !== "visual_model" && item.text.includes(value)) ??
    observation.textEvidence?.find((item) => item.text.includes(value));
  const numericTextUnverified = (value: string) => /\d/.test(value) &&
    !observation.textEvidence?.some((item) => item.source !== "visual_model" && item.text.includes(value));
  const checks: Array<["urlIncludes" | "windowTitleIncludes" | "pageTextIncludes" | "domIncludes" | "accessibilityIncludes",
    string | undefined, string]> = [
    ["urlIncludes", observation.url, "网址"],
    ["windowTitleIncludes", observation.windowTitle, "窗口标题"],
    ["pageTextIncludes", observation.pageText, "页面文本"],
    ["domIncludes", observation.dom, "DOM"],
    ["accessibilityIncludes", observation.accessibility, "无障碍信息"],
  ];
  for (const [key, actual, label] of checks) {
    const expected = criteria[key];
    if (expected && !actual?.includes(expected)) {
      return { ok: false, message: `${label}未满足完成条件：${expected}` };
    }
    if (key === "pageTextIncludes" && expected && numericTextUnverified(expected)) {
      return { ok: false, message: `页面数值 ${expected} 缺少 DOM/UIA 原始证据，不能自动确认` };
    }
    if (expected) {
      const source = key === "pageTextIncludes" ? textSource(expected)?.source :
        key === "urlIncludes" ? "browser" : key === "windowTitleIncludes" ? "window" :
        key === "domIncludes" ? "dom" : "uia";
      evidence.push({ criterion: key, source: source ?? "unknown",
        strength: source === "visual_model" ? "weak" : source ? "strong" : "unknown" });
    }
  }
  for (const expected of criteria.pageTextIncludesAll ?? []) {
    if (!observation.pageText?.includes(expected)) {
      return { ok: false, message: `页面文本未满足完成条件：${expected}` };
    }
    if (numericTextUnverified(expected)) {
      return { ok: false, message: `页面数值 ${expected} 缺少 DOM/UIA 原始证据，不能自动确认` };
    }
    const source = textSource(expected)?.source;
    evidence.push({ criterion: `pageTextIncludesAll:${expected}`, source: source ?? "unknown",
      strength: source === "visual_model" ? "weak" : source ? "strong" : "unknown" });
  }
  for (const label of criteria.pageTextNumberLabels ?? []) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\d[\\d,]*\\s*${escaped}`);
    if (!pattern.test(observation.pageText ?? "")) {
      return { ok: false, message: `页面文本未找到 ${label} 的数值` };
    }
    const source = observation.textEvidence?.find((item) =>
      item.source !== "visual_model" && pattern.test(item.text))?.source;
    if (!source) return { ok: false,
      message: `${label} 的数值只有截图模型转录或未知来源，缺少 DOM/UIA 原始证据，不能自动确认` };
    evidence.push({ criterion: `pageTextNumberLabels:${label}`, source, strength: "strong" });
  }
  for (const condition of criteria.structuredStates ?? []) {
    const source=observation.structured?.source??
      (observation.capture?.fields.dom?.source==='uia'?'uia':'dom');
    const checked=checkStructuredState(condition,observation,source);
    if(checked.verdict!=='pass')return {ok:false,message:checked.message};
    evidence.push({criterion:`structured:${condition.target.role}:${condition.field}`,
      source,strength:'strong'});
  }
  for (const domainCheck of criteria.domainChecks ?? []) {
    if (!evaluateDomain) {
      return { ok: false, message: "配置了域完成条件，但未装配域验收贡献器，不能自动确认" };
    }
    const [outcome] = evaluateDomain([domainCheck], observation);
    if (!outcome || outcome.verdict !== "pass") {
      return { ok: false, message: outcome?.message ?? "域完成条件未能通过当次证据验收" };
    }
    for (const ref of outcome.audit.evidenceRefs) {
      evidence.push({ criterion: outcome.criterion, source: ref.facetId, strength: "strong" });
    }
  }
  return { ok: true, message: "独立完成条件已通过当前页面状态验证", evidence };
}
