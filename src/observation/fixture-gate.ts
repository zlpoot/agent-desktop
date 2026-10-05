/**
 * P9-A4.5 F0.1 — Fixture Validity Gate（只读分类；不改 collector，不改 remap 阈值）。
 *
 * 所有进入 collector completeness 验收（G1–G4）的 fixture 必须先通过本 Gate：
 * 证明目标语义真实存在于该 observation 对应页面，并按业务分类：
 *   rendered-visible / rendered-semantic-only → admissible（允许进入 G1–G4）
 *   not-rendered / wrong-page-contract / undetermined → 隔离（fail closed）
 * 证据不足一律 undetermined，禁止自动猜测 root cause。
 *
 * 分类规则（与 docs/Agent-Desktop-P9-A4-5-Design.md §2 一致）：
 *   1) rendered-visible 优先于一切：当前 observation pageText 含 target 即准入；
 *   2) wrong-page-contract 只在有 provenance 时判定：source observation 中可证明 target
 *      且 source 与当前页面不一致；source 无法证明 → undetermined（fail closed）；
 *   3) not-rendered：pageText 极短（≤ NOT_RENDERED_PAGETEXT_MAX）→ 页面主体未渲染 / 外部阻塞；
 *      **优先于 rendered-semantic-only**：页面主体未渲染时，items 中的 semantic 匹配不可信
 *      （可能来自验证码页/壳层），不得归为 semantic-only；
 *   4) rendered-semantic-only 只认已保存的 semantic attrs：
 *      item.name 非 text 投影（aria-label / name 属性投影）或 item.href（URL 解码后）匹配 target；
 *      旧 trace 未保存这些 attrs → 不得猜测 → undetermined；
 *   5) 其余一律 undetermined（fail closed）。
 */
import { DatabaseSync } from "node:sqlite";

export type FixtureClass =
  | "rendered-visible"
  | "rendered-semantic-only"
  | "not-rendered"
  | "wrong-page-contract"
  | "undetermined";

export interface FixtureItem {
  role?: string;
  text?: string;
  name?: string;
  href?: string;
}

export interface FixtureObservation {
  url: string;
  pageText: string;
  items: FixtureItem[];
  complete?: boolean;
}

export interface FixtureSourceProvenance {
  /** frozen target 的来源 observation（探索时所在页面） */
  observation: FixtureObservation;
}

export interface FixtureEvidenceInput {
  /** replay / 当前 observation（待分类） */
  obs: FixtureObservation;
  /** stable token（frozen target 的可稳定识别语义） */
  target: string;
  /** provenance：target 的来源页面证据（wrong-page-contract 判定必需） */
  source?: FixtureSourceProvenance;
}

export interface FixtureVerdict {
  classification: FixtureClass;
  /** 是否允许进入 collector completeness 验收（G1–G4）：仅 rendered-visible / rendered-semantic-only */
  admissible: boolean;
  reasons: string[];
}

/** 页面可见文本低于该阈值视为渲染未就绪 / 外部阻塞（通用启发式；淘宝 blocked trace pageText=6 命中） */
export const NOT_RENDERED_PAGETEXT_MAX = 40;

export type MatchVia = "text" | "name" | "href" | "none";

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** URL 规范化：URL 解码、去 hash、去尾部斜杠、小写（用于同页判断） */
export function normalizeUrl(url: string): string {
  let u = url;
  try {
    u = decodeURIComponent(u);
  } catch {
    /* 保留原样 */
  }
  const hashIdx = u.indexOf("#");
  if (hashIdx >= 0) u = u.slice(0, hashIdx);
  u = u.replace(/\/+$/, "");
  return u.toLowerCase();
}

export function samePage(a: string, b: string): boolean {
  return normalizeUrl(a) === normalizeUrl(b);
}

/**
 * 在 items 中查找 target，命中优先级 text → name → href：
 *  - text：item.text 文本匹配（rendered 证据；textContent 投影）
 *  - name：item.name 匹配且 name 不是 text 的投影（aria-label / name 属性投影 = semantic evidence）
 *  - href：item.href URL 解码后匹配（semantic evidence）
 */
export function matchTargetInItems(items: FixtureItem[], target: string): { via: MatchVia; item?: FixtureItem } {
  for (const item of items) {
    const text = item.text ?? "";
    if (text.includes(target)) return { via: "text", item };
  }
  for (const item of items) {
    const text = item.text ?? "";
    const name = item.name ?? "";
    if (name && name !== text && name.includes(target)) return { via: "name", item };
  }
  for (const item of items) {
    const href = item.href ?? "";
    if (href && safeDecode(href).includes(target)) return { via: "href", item };
  }
  return { via: "none" };
}

/** items 是否保存了 semantic attrs（name=aria-label/name 投影，或 href）——旧 trace 未保存则不得猜测 semantic-only */
export function hasPersistedSemanticAttrs(items: FixtureItem[]): boolean {
  return items.some((i) => i.name !== undefined || i.href !== undefined);
}

/** 页面主体是否未渲染 / 外部阻塞（pageText 极短） */
export function isNotRendered(obs: FixtureObservation): boolean {
  return obs.pageText.length <= NOT_RENDERED_PAGETEXT_MAX;
}

export function classifyFixtureEvidence(ev: FixtureEvidenceInput): FixtureVerdict {
  const reasons: string[] = [];
  const pageHas = ev.obs.pageText.includes(ev.target);
  const itemHit = matchTargetInItems(ev.obs.items, ev.target);

  // 0) rendered-visible 优先于一切：当前 pageText 含 target 即准入（即使同时有 provenance）
  if (pageHas) {
    reasons.push("target present in observation pageText (rendered-visible)");
    return { classification: "rendered-visible", admissible: true, reasons };
  }

  // 1) wrong-page-contract：仅在提供 provenance 且可证明 source 存在 target 时判定
  if (ev.source) {
    const src = ev.source.observation;
    const srcHas = src.pageText.includes(ev.target) || matchTargetInItems(src.items, ev.target).via !== "none";
    if (!srcHas) {
      reasons.push(
        "provenance provided but target not proven in source observation (pageText/items); fail closed → undetermined",
      );
      return { classification: "undetermined", admissible: false, reasons };
    }
    if (!samePage(src.url, ev.obs.url)) {
      reasons.push(
        `target proven in source page (${src.url}) but replay page (${ev.obs.url}) differs and lacks target → wrong-page-contract`,
      );
      return { classification: "wrong-page-contract", admissible: false, reasons };
    }
    reasons.push("source page matches replay page; continuing with ordinary evidence checks");
  }

  // 2) not-rendered：页面主体未渲染 / 外部阻塞（pageText 极短）。
  //    优先于 rendered-semantic-only：页面主体未渲染时，items 中的 semantic 匹配不可信
  //    （可能来自验证码页 / 壳层），不得归为 semantic-only。
  if (isNotRendered(ev.obs)) {
    reasons.push(
      `pageText length ${ev.obs.pageText.length} <= ${NOT_RENDERED_PAGETEXT_MAX}: page body not rendered / external blocked`,
    );
    return { classification: "not-rendered", admissible: false, reasons };
  }

  // 3) rendered-semantic-only：pageText 无目标，但已保存 semantic attrs 明确匹配
  if (itemHit.via === "name" || itemHit.via === "href") {
    if (hasPersistedSemanticAttrs(ev.obs.items)) {
      reasons.push(`target matched via recorded DOM semantic evidence (${itemHit.via}); absent from pageText`);
      return { classification: "rendered-semantic-only", admissible: true, reasons };
    }
    reasons.push("semantic match observed but semantic attrs not persisted in trace; cannot attribute; fail closed");
    return { classification: "undetermined", admissible: false, reasons };
  }

  // 4) 其余：证据不足，fail closed
  const attrNote = hasPersistedSemanticAttrs(ev.obs.items)
    ? "semantic attrs persisted but no match"
    : "semantic attrs not persisted in trace (old trace)";
  reasons.push(
    `insufficient evidence: target absent from pageText; no semantic evidence match (${attrNote}); ` +
      "no provenance / render-blocked evidence; undetermined (fail closed, no root-cause guessing)",
  );
  return { classification: "undetermined", admissible: false, reasons };
}

/** 从 trace sqlite 读取全部 observe 事件，返回 observation 列表（只读，无副作用）。 */
export function loadTraceObservations(dbPath: string): FixtureObservation[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT payload_json FROM events WHERE node='observe' ORDER BY rowid`)
      .all() as Array<{ payload_json: string }>;
    const out: FixtureObservation[] = [];
    for (const row of rows) {
      const p = JSON.parse(row.payload_json) as Record<string, unknown>;
      const o = (p.observation ?? p) as {
        url?: string;
        pageText?: string;
        structured?: { items?: FixtureItem[]; complete?: boolean };
      };
      out.push({
        url: o.url ?? "",
        pageText: o.pageText ?? "",
        items: o.structured?.items ?? [],
        complete: o.structured?.complete,
      });
    }
    return out;
  } finally {
    db.close();
  }
}
