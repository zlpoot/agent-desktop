/**
 * P9-A4｜通用 Semantic Target Remapping（语义目标重映射）。
 *
 * 问题（A1/A2 共同实证）：蒸馏后的 click target name 冻结为探索时刻的具体文本
 * （如淘宝商品链接「真无线蓝牙耳机入耳式长续航…城瑞达炫皓专卖」），参数变体回放时
 * exact target contract 失效 → 每次都 fallback 重新探索。
 *
 * 本模块在 Runtime/Workflow 通用层解决：允许 target 文本发生合理漂移（关键词/
 * 动态后缀/促销文本变化），同时保持回放确定性与安全性——多候选或置信不足
 * 必须拒绝自动点击并进入 fallback（禁止 silent fuzzy click），并留下可审计的
 * matchedBy / score / alternatives / evidence。
 *
 * 纯函数、无副作用、无模型调用（0 modelCalls）。无业务词表、无 host 判断；
 * href 特征由调用方显式传入（缺省纯文本匹配）。
 */
import type { Target } from "../actions/schema.js";

export interface RemapCandidate {
  role: string;
  name?: string;
  text?: string;
  value?: string;
  href?: string;
  classTokens?: string[];
}

export interface RemapAlternative {
  role: string;
  name?: string;
  text?: string;
  href?: string;
  score: number;
  reason: string;
}

export interface RemapEvidence {
  roleOk: boolean;
  exact: boolean;
  normalizedExact: boolean;
  tokenHits: string[];
  prefix: boolean;
  frozenOverlap: boolean;
  hrefHit: boolean;
}

export type MatchedBy = "exact" | "normalized_exact" | "stable_token" | "stable_prefix" | "frozen_overlap";
export type RejectReason = "multi_candidate_conflict" | "low_confidence" | "no_candidate" | "role_mismatch";

export interface RemapVerdict {
  matched: boolean;
  /** 命中时的可执行目标（kind 与原 spec 对齐：role → role+name；label → label；text → text）。 */
  target?: Target;
  matchedBy?: MatchedBy;
  score?: number;
  alternatives: RemapAlternative[];
  evidence: RemapEvidence;
  rejectReason?: RejectReason;
}

export interface RemapInput {
  /** 蒸馏冻结的 target（role/label/text；selector/vision/coordinate 不做重映射）。 */
  spec: Target;
  /** 本次 replay 的参数值展开（如 ["蓝牙音箱"]）；空数组 = 无参数语义，只走 exact 档。 */
  inputTokens: string[];
  /** 当前页面候选（最近 observation.structured.items 或 DOM collector 输出）。 */
  candidates: readonly RemapCandidate[];
  /** 可选 href 特征（调用方显式传入，如 ["item.htm"]；缺省 = 纯文本匹配）。 */
  hrefFeatures?: string[];
}

const ROLE_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  // 输入框语义互认：ARIA combobox 常无显式 role；textbox 与 combobox 在 input 上等价。
  // 反向映射由对称展开保证：textbox ⇄ combobox。
  combobox: ["combobox", "textbox"],
  textbox: ["textbox", "combobox"],
  link: ["link"],
  button: ["button"],
  checkbox: ["checkbox"],
};

function rolesEquivalent(want: string, have: string): boolean {
  const wantKey = want.toLowerCase();
  const haveKey = have.toLowerCase();
  if (wantKey === haveKey) return true;
  return (ROLE_SYNONYMS[wantKey] ?? []).includes(haveKey);
}

/** 全角 → 半角。 */
function toHalfWidth(value: string): string {
  return value.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ");
}

/** 通用去噪（无业务词表）：空白/标点/数字价格簇/URL/年份/emoji 与符号簇。 */
export function normalizeTargetText(value: string): string {
  let out = toHalfWidth(value)
    .replace(/\s+/g, " ")
    // URL
    .replace(/https?:\/\/\S+/gi, " ")
    // 数字价格簇：¥?12.34元 / 27.58 / 4万+ / 32.32k
    .replace(/[¥￥$]?\d+(?:[.,]\d+)?\s*(?:元|块|万|k|K)?/g, " ")
    // 年份：2026年
    .replace(/\b20\d{2}\s*年?/g, " ")
    // 标点与符号簇（含 emoji、箭头、装饰符号）
    .replace(/[，。！？、；：·…—–-“”‘’（）()【】\[\]《》〈〉<>«»"'"'`~!@#$%^&*_+=|\\/{}:;,.?]+/g, " ")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2B05}-\u{2B07}\u{25A0}-\u{25FF}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return out;
}

/** 切成稳定 token：≥2 字符的连续片段（去噪后）。 */
function stableTokens(value: string): string[] {
  return normalizeTargetText(value).split(" ").map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

function targetText(spec: Target): string | undefined {
  switch (spec.kind) {
    case "role": return spec.name;
    case "label": return spec.label;
    case "text": return spec.text;
    default: return undefined;
  }
}

/** 候选展示文本：text > name（商品链接 aria-label 常缺，textContent 为主）。 */
function candidateText(candidate: RemapCandidate): string {
  return (candidate.text ?? candidate.name ?? "").trim();
}

interface Scored { index: number; score: number; matchedBy: MatchedBy; reason: string }

/**
 * 语义目标重映射：对候选集合评分 → 唯一高置信命中 / 拒绝（fallback）。
 *
 * 匹配链（取候选最高档）：
 *   exact → normalized_exact → stable_prefix(0.95) → stable_token(0.85)
 *   → frozen_overlap(0.70)；href 特征命中 +0.05（可选）。
 * 门槛：top.score ≥ 0.70 且 top − second ≥ 0.15；否则拒绝，绝不自动点击。
 */
export function remapTarget(input: RemapInput): RemapVerdict {
  const { spec, candidates } = input;
  const want = targetText(spec);
  const frozenName = want?.trim() ?? "";
  const inputTokens = [...new Set(input.inputTokens.map((token) => token.trim()).filter((token) => token.length >= 1))];
  // 最长输入 token 优先：最具体的关键词先试。
  const sortedTokens = [...inputTokens].sort((a, b) => b.length - a.length);
  const frozenTokens = frozenName ? stableTokens(frozenName) : [];
  const frozenFirstToken = frozenTokens[0];
  const hrefFeatures = input.hrefFeatures ?? [];

  const evidence: RemapEvidence = {
    roleOk: false, exact: false, normalizedExact: false,
    tokenHits: [], prefix: false, frozenOverlap: false, hrefHit: false,
  };
  const alternatives: RemapAlternative[] = [];
  let top: Scored | undefined;

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    // role 硬约束仅对 role spec 生效；label/text spec 是纯文本定位，不比较 role。
    if (spec.kind === "role" && !rolesEquivalent(spec.role, candidate.role)) {
      alternatives.push({ role: candidate.role, name: candidate.name, text: candidate.text,
        href: candidate.href, score: 0, reason: "role_mismatch" });
      continue;
    }
    const text = candidateText(candidate);
    if (!text) {
      alternatives.push({ role: candidate.role, name: candidate.name, text: candidate.text,
        href: candidate.href, score: 0, reason: "no_text" });
      continue;
    }
    // 内部用整数百分分（0..100）避免浮点比较（0.95−0.80 的 IEEE 表示会误触发 margin）。
    let score100 = 0;
    let matchedBy: MatchedBy | undefined;
    let reason = "";

    const normalizedCandidate = normalizeTargetText(text);
    const normalizedFrozen = normalizeTargetText(frozenName);

    if (frozenName && text === frozenName) {
      score100 = 95; matchedBy = "exact"; reason = "exact";
    } else if (frozenName && normalizedCandidate && normalizedCandidate === normalizedFrozen) {
      score100 = 90; matchedBy = "normalized_exact"; reason = "normalized_exact";
    } else {
      // 输入 token 匹配（参数语义）：prefix 优先。
      const tokenHit = sortedTokens.find((token) => text.includes(token));
      if (tokenHit) {
        const prefix = text.startsWith(tokenHit);
        score100 = prefix ? 95 : 80;
        matchedBy = prefix ? "stable_prefix" : "stable_token";
        reason = prefix ? `stable_prefix:${tokenHit}` : `stable_token:${tokenHit}`;
      } else if (frozenName && frozenTokens.length) {
        // 冻结名与候选的稳定 token 重叠（探索值场景，无输入 token）。
        const shared = stableTokens(text).filter((token) => frozenTokens.includes(token));
        if (shared.length >= 1 && frozenFirstToken && text.includes(frozenFirstToken)) {
          score100 = 70; matchedBy = "frozen_overlap";
          reason = `frozen_overlap:${shared.slice(0, 3).join("|")}`;
        }
      }
    }

    if (hrefFeatures.length && candidate.href &&
        hrefFeatures.some((feature) => candidate.href!.includes(feature))) {
      score100 = Math.min(100, score100 + 5);
      reason = reason ? `${reason}+href` : "href";
    }

    const hrefHit = hrefFeatures.length > 0 && !!candidate.href &&
      hrefFeatures.some((feature) => candidate.href!.includes(feature));
    if (score100 === 0) {
      alternatives.push({ role: candidate.role, name: candidate.name, text: candidate.text,
        href: candidate.href, score: 0, reason: reason || "no_match" });
      continue;
    }
    const score = score100 / 100;
    if (!top || score > top.score) {
      top = { index, score, matchedBy: matchedBy!, reason };
    }
    alternatives.push({ role: candidate.role, name: candidate.name, text: candidate.text,
      href: candidate.href, score, reason });
  }

  if (!top) {
    // 区分拒绝根因：全部候选因 role 不符被排除 → role_mismatch；有文本候选但无命中 → low_confidence。
    const allRoleRejected = candidates.length > 0 &&
      alternatives.every((item) => item.reason === "role_mismatch");
    return { matched: false, alternatives: sortAlternatives(alternatives), evidence,
      rejectReason: candidates.length === 0 ? "no_candidate"
        : allRoleRejected ? "role_mismatch" : "low_confidence" };
  }

  evidence.roleOk = true;
  evidence.exact = top.matchedBy === "exact";
  evidence.normalizedExact = top.matchedBy === "normalized_exact";
  evidence.prefix = top.matchedBy === "stable_prefix";
  evidence.frozenOverlap = top.matchedBy === "frozen_overlap";
  const topCandidate = candidates[top.index];
  const topText = candidateText(topCandidate);
  evidence.tokenHits = sortedTokens.filter((token) => topText.includes(token));
  evidence.hrefHit = hrefFeatures.length > 0 && !!topCandidate.href &&
    hrefFeatures.some((feature) => topCandidate.href!.includes(feature));

  const sorted = sortAlternatives(alternatives);
  const secondScore100 = sorted.length > 1 ? Math.round(sorted[1].score * 100) : 0;
  const topScore100 = Math.round(top.score * 100);
  if (topScore100 < 70) {
    return { matched: false, alternatives: sorted, evidence, rejectReason: "low_confidence",
      score: top.score, matchedBy: top.matchedBy };
  }
  if (topScore100 - secondScore100 < 15) {
    return { matched: false, alternatives: sorted, evidence, rejectReason: "multi_candidate_conflict",
      score: top.score, matchedBy: top.matchedBy };
  }

  const target: Target = spec.kind === "role"
    ? { kind: "role", role: spec.role, name: topText.slice(0, 300) }
    : spec.kind === "label"
      ? { kind: "label", label: topText.slice(0, 300) }
      : { kind: "text", text: topText.slice(0, 300) };
  return { matched: true, target, matchedBy: top.matchedBy, score: top.score,
    alternatives: sorted, evidence };
}

function sortAlternatives(items: RemapAlternative[]): RemapAlternative[] {
  return [...items].sort((a, b) => b.score - a.score);
}
