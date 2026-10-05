import type { AgentExtension } from "../../contracts/extension.js";
import type {
  FacetPayload, FacetSchemaValidation, ObservationFacetProvider,
} from "../../contracts/facets.js";
import type {
  BoundEvidence, ContributorResult, CriterionValidation, DomainCriterion,
  VerifierContributor,
} from "../../contracts/verifier-contributor.js";
import { readJdProduct, type JdProductData } from "./jd-product.js";

const FACET_ID = "shop.jd";
const SCHEMA_VERSION = 1;
const PROVIDER_VERSION = "1.0.0";

function isProductData(data: unknown): data is JdProductData {
  if (typeof data !== "object" || data === null) return false;
  const value = data as Record<string, unknown>;
  return typeof value.title === "string" && value.title.trim().length > 0 &&
    (value.capacityGb === undefined || typeof value.capacityGb === "number") &&
    (value.priceYuan === undefined || typeof value.priceYuan === "number") &&
    (value.priceSource === undefined || typeof value.priceSource === "string");
}

function validate(data: unknown): FacetSchemaValidation {
  return isProductData(data) ? { ok: true }
    : { ok: false, reason: "shop.jd facet data 必须含非空 title，可选 capacityGb/priceYuan/priceSource" };
}

/** 商品详情 facet provider：仅在浏览器 item.jd.com 商品页，通过核心只读 readDom 采集。 */
const jdFacetProvider: ObservationFacetProvider = {
  id: FACET_ID,
  schemaVersion: SCHEMA_VERSION,
  providerVersion: PROVIDER_VERSION,
  environment: "browser",
  source: "dom",
  validate,
  async collect(ctx): Promise<FacetPayload | undefined> {
    if (!ctx.pageUrl) return undefined;
    if (!ctx.readDom) return undefined;
    const product = await readJdProduct(ctx.pageUrl, ctx.readDom);
    if (!product) return undefined;
    // 没有价格时仍返回标题/容量，但标记 complete=false：价格类谓词因此 fail-closed 为 UNKNOWN。
    const complete = product.priceYuan !== undefined && product.capacityGb !== undefined;
    return { complete, data: product };
  },
};

function refs(bound: BoundEvidence, facet: { providerVersion: string; schemaVersion: number }) {
  return [{ facetId: FACET_ID, captureId: bound.captureId, subjectRef: bound.subject,
    providerVersion: facet.providerVersion, schemaVersion: facet.schemaVersion }];
}

/** 商品域验收贡献者：只在当次、已绑定的 shop.jd facet 上裁决，不访问网络/模型/Oracle/历史。 */
const jdContributor: VerifierContributor = {
  id: FACET_ID,
  criterionSchemaVersion: 1,
  canEvaluate(criterion: DomainCriterion): boolean {
    return criterion.domain === FACET_ID
      && ["capacityGb", "priceAtMost", "titleIncludes"].includes(criterion.predicate);
  },
  validateCriterion(criterion: DomainCriterion): CriterionValidation {
    const args = criterion.args ?? {};
    if (criterion.predicate === "capacityGb") {
      return typeof args.equals === "number" && Number.isFinite(args.equals)
        ? { ok: true } : { ok: false, reason: "capacityGb 需要数值 args.equals" };
    }
    if (criterion.predicate === "priceAtMost") {
      return typeof args.max === "number" && Number.isFinite(args.max)
        ? { ok: true } : { ok: false, reason: "priceAtMost 需要数值 args.max" };
    }
    if (criterion.predicate === "titleIncludes") {
      return typeof args.includes === "string" && args.includes.trim().length > 0
        ? { ok: true } : { ok: false, reason: "titleIncludes 需要非空字符串 args.includes" };
    }
    return { ok: false, reason: `不支持的谓词 ${criterion.predicate}` };
  },
  evaluate(criterion: DomainCriterion, bound: BoundEvidence): ContributorResult {
    const facet = bound.requireFacet(FACET_ID);
    const product = facet.data as JdProductData;
    const evidenceRefs = refs(bound, facet);
    const base = { criterionSchemaVersion: 1, evidenceRefs };
    const args = criterion.args ?? {};

    if (criterion.predicate === "capacityGb") {
      const expected = Number(args.equals);
      if (product.capacityGb === undefined) {
        return { ...base, verdict: "unknown", reason: "evidence_unavailable",
          message: "商品详情未提供可核验的容量规格", actual: product.capacityGb };
      }
      if (product.capacityGb !== expected) {
        return { ...base, verdict: "fail",
          message: `商品容量未确认是 ${expected}GB，当前为 ${product.capacityGb}GB`,
          actual: product.capacityGb };
      }
      return { ...base, verdict: "pass", message: `商品容量已确认为 ${expected}GB`,
        actual: product.capacityGb };
    }

    if (criterion.predicate === "priceAtMost") {
      const max = Number(args.max);
      if (product.priceYuan === undefined) {
        return { ...base, verdict: "unknown", reason: "evidence_unavailable",
          message: "商品详情页未提供可核验的当前价格", actual: product.priceYuan };
      }
      if (product.priceYuan > max) {
        return { ...base, verdict: "fail",
          message: `商品价格 ¥${product.priceYuan} 超过预算 ¥${max}`, actual: product.priceYuan };
      }
      return { ...base, verdict: "pass", message: `商品价格 ¥${product.priceYuan} 未超过预算 ¥${max}`,
        actual: product.priceYuan };
    }

    // titleIncludes：schema 已保证 title 为非空字符串。
    const includes = String(args.includes);
    if (!product.title.includes(includes)) {
      return { ...base, verdict: "fail", message: `商品标题未包含 ${includes}`, actual: product.title };
    }
    return { ...base, verdict: "pass", message: `商品标题已包含 ${includes}`, actual: product.title };
  },
};

/** 商城商品扩展：提供京东商品详情 facet 与域验收贡献者，不含专用执行器。 */
export function createShopExtension(): AgentExtension {
  return { id: "shop.jd", name: "商城商品（京东详情）",
    facets: [jdFacetProvider], contributors: [jdContributor] };
}
