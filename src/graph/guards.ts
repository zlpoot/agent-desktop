import { createHash } from "node:crypto";
import type { ComputerAction } from "../actions/schema.js";
import type { ComputerState } from "./state.js";

const risky = /\b(pay|purchase|buy|delete|remove|send|submit|checkout|transfer)\b|支付|购买|下单|删除|发送|提交|转账/i;

export function actionIsRisky(action: ComputerAction): boolean {
  if (action.kind === "click" || action.kind === "double_click") {
    // 导航语义：点击 link 仅打开新页面，无状态修改副作用（购买/删除等交易动作
    // 必然发生在 button/checkbox/form 控件上）。真实站点商品链接文本常含
    // 销量描述（如「下单100+人」「800+人付款」），按文本判风险会误伤只读导航。
    const target = action.target;
    if (target.kind === "role" && target.role === "link") return false;
    return risky.test(JSON.stringify(action.target));
  }
  if (action.kind === "drag") return risky.test(JSON.stringify(action.destination));
  return false;
}

export function impactFingerprint(action: ComputerAction): string | undefined {
  return action.kind === "click" || action.kind === "double_click" ||
    action.kind === "drag" ||
    (action.kind === "keypress" && /^(enter|return)$/i.test(action.keys))
    ? JSON.stringify(action) : undefined;
}

export function observationSignature(observation: ComputerState["observation"]): string | undefined {
  if (!observation) return undefined;
  return createHash("sha256").update(JSON.stringify({ url: observation.url,
    dom: observation.dom, accessibility: observation.accessibility })).digest("hex");
}

export function focusLost(state: Readonly<Pick<ComputerState, "error">>): boolean {
  return /目标窗口.*前台|目标窗口前台|window.*foreground/i.test(state.error ?? "");
}

/** Pure policy only: Graph owns state patches, approval context, Trace and dispatch. */
export type RiskDecision = "duplicate" | "approved" | "risky" | "allow";
export function riskDecision(state: Readonly<Pick<ComputerState,
  "lastAction" | "recentHistory" | "executedImpactActions" | "approvedActionFingerprint" |
  "approvalContextUrl" | "approvalContextSignature" | "observation">>): RiskDecision {
  const action = state.lastAction;
  const fingerprint = action && impactFingerprint(action);
  const previousImpact = [...(state.recentHistory ?? [])].reverse()
    .find((item) => impactFingerprint(item.action));
  const resetByNavigation = previousImpact &&
    impactFingerprint(previousImpact.action) !== fingerprint && previousImpact.verification?.ok;
  const duplicate = !!fingerprint && !!state.executedImpactActions?.includes(fingerprint) &&
    !resetByNavigation;
  const approved = action && state.approvedActionFingerprint === JSON.stringify(action) &&
      state.approvalContextUrl === state.observation?.url &&
      state.approvalContextSignature === observationSignature(state.observation);
  if (duplicate && !approved) return "duplicate";
  if (action && (actionIsRisky(action) || duplicate) && approved) return "approved";
  return action && actionIsRisky(action) ? "risky" : "allow";
}
