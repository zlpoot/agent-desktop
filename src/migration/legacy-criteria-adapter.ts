import type { CompletionCriteria } from "../verifier/verifier.js";
import type { DomainCriterion } from "../contracts/verifier-contributor.js";

/**
 * LegacyCriteriaAdapter —— 历史商品/媒体（product 系列与 media 系列）完成条件的只读迁移边界
 * （P8 批次 2 / §11.3）。
 *
 * 位置刻意放在 src/migration（kernel 业务词护栏扫描目录之外）：兼容逻辑只能存在于
 * migration/adapter boundary，绝不回灌新的 HybridVerifier。核心新代码不认识这些旧键。
 *
 * 语义：
 *  - 仅在「读取/迁移历史持久化任务」时调用一次，把旧键翻译成 DomainCriterion；
 *  - 新任务不得再产生旧键（见 assertNoLegacyCriteriaKeys，规划契约解析处强制）；
 *  - 翻译后的域条件与全新域条件走完全相同的当次 facet 证据门，缺证据仍 UNKNOWN；
 *  - 删除条件：当 web-tasks.sqlite 中不再存在含这些旧键的未完成任务、且批次 2 之后两个发布周期
 *    无旧任务回放需求时，可整体删除本文件与 load() 中的调用（附回归删除）。
 */

/** 旧商品/媒体完成条件键 → 迁移后的域/谓词。仅本文件允许出现这些历史标识符。 */
const LEGACY_PRODUCT_KEYS = [
  "productCapacityGb",
  "productPriceAtMost",
  "productTitleIncludes",
] as const;
const LEGACY_MEDIA_KEYS = [
  "mediaTitleIncludes",
  "mediaArtistIncludes",
  "mediaPlaying",
] as const;

export const LEGACY_CRITERIA_KEYS: readonly string[] =
  [...LEGACY_PRODUCT_KEYS, ...LEGACY_MEDIA_KEYS];

export interface LegacyCriteriaAdaptation {
  criteria: CompletionCriteria;
  adapted: boolean;
  legacyKeys: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把任意历史 completionCriteria（unknown，来自旧 JSON）迁移为新 CompletionCriteria。
 * 不修改入参；无旧键时原样返回（adapted=false）。无法识别的字段保持不动，交由核心 fail-closed。
 */
export function adaptLegacyCriteria(raw: unknown): LegacyCriteriaAdaptation {
  if (!isRecord(raw)) return { criteria: (raw ?? {}) as CompletionCriteria, adapted: false, legacyKeys: [] };

  const legacyKeys = LEGACY_CRITERIA_KEYS.filter((key) => raw[key] !== undefined);
  if (legacyKeys.length === 0) {
    return { criteria: raw as CompletionCriteria, adapted: false, legacyKeys: [] };
  }

  const domainChecks: DomainCriterion[] = [];

  if (raw.productCapacityGb !== undefined) {
    domainChecks.push({ domain: "shop.jd", predicate: "capacityGb",
      args: { equals: Number(raw.productCapacityGb) } });
  }
  if (raw.productPriceAtMost !== undefined) {
    domainChecks.push({ domain: "shop.jd", predicate: "priceAtMost",
      args: { max: Number(raw.productPriceAtMost) } });
  }
  if (raw.productTitleIncludes !== undefined) {
    domainChecks.push({ domain: "shop.jd", predicate: "titleIncludes",
      args: { includes: String(raw.productTitleIncludes) } });
  }
  if (raw.mediaTitleIncludes !== undefined) {
    domainChecks.push({ domain: "music.netease", predicate: "titleIncludes",
      args: { includes: String(raw.mediaTitleIncludes) } });
  }
  if (raw.mediaArtistIncludes !== undefined) {
    domainChecks.push({ domain: "music.netease", predicate: "artistIncludes",
      args: { includes: String(raw.mediaArtistIncludes) } });
  }
  if (raw.mediaPlaying !== undefined) {
    domainChecks.push({ domain: "music.netease", predicate: "playing",
      args: { equals: raw.mediaPlaying === true } });
  }

  const migrated: Record<string, unknown> = { ...raw };
  for (const key of legacyKeys) delete migrated[key];
  const existing = Array.isArray(migrated.domainChecks) ? migrated.domainChecks as DomainCriterion[] : [];
  migrated.domainChecks = [...existing, ...domainChecks];

  return { criteria: migrated as CompletionCriteria, adapted: true, legacyKeys };
}

export function hasLegacyCriteriaKeys(raw: unknown): boolean {
  return isRecord(raw) && LEGACY_CRITERIA_KEYS.some((key) => raw[key] !== undefined);
}

/**
 * 新任务边界强制：规划/任务创建产生的完成条件若含旧键即拒绝（fail-closed），
 * 禁止新任务继续写旧的 product 系列 / media 系列键。
 */
export function assertNoLegacyCriteriaKeys(raw: unknown): void {
  if (hasLegacyCriteriaKeys(raw)) {
    throw new Error("新任务不得再产生历史 product/media 完成条件；请使用 domainChecks 域条件");
  }
}
