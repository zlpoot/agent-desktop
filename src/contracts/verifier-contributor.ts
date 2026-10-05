import type { EvidenceSubjectRef, FacetValue } from "./facets.js";

/**
 * VerifierContributor —— 可插拔、可审计、fail-closed 的域验收贡献者（P8 批次 2 / §11.3）。
 *
 * 核心统一把住证据外壳（来源/新鲜/对象/枚举/schema/当次 capture）；域「谓词怎么算」由扩展提供。
 * contributor 只能消费核心已绑定的当次证据，无法访问 Oracle、模型或历史动作。
 */

/** 域完成条件；domain 与 contributor id 对齐。新任务只产生 DomainCriterion，不再产生旧的商品/媒体键。 */
export interface DomainCriterion {
  domain: string;
  predicate: string;
  args: Record<string, unknown>;
}

/** 指向某份当次、已绑定 facet 的证据引用；contributor 的每个结论都必须给出。 */
export interface EvidenceRef {
  facetId: string;
  captureId: string;
  subjectRef: EvidenceSubjectRef;
  providerVersion: string;
  schemaVersion: number;
}

export type ContributorVerdict = "pass" | "fail" | "unknown";

/** 核心统一的 contributor 侧 unknown 原因（与 HybridVerifier 三态语义对齐）。 */
export type ContributorUnknownReason =
  | "unsupported_condition"
  | "evidence_unavailable"
  | "target_ambiguous"
  | "observation_stale"
  | "verification_error";

export interface ContributorResult {
  verdict: ContributorVerdict;
  reason?: ContributorUnknownReason;
  message: string;
  actual?: unknown;
  criterionSchemaVersion: number;
  /** pass/fail 都必须给出当次、已绑定的证据引用；无当次反证的 fail 会被核心降为 unknown。 */
  evidenceRefs: EvidenceRef[];
}

export type CriterionValidation =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * 交给 contributor 的当次绑定证据。只能读取同一 capture / 同一 subject 的已校验 facet；
 * requireFacet 在 facet 缺失/陈旧/对象不明/schema 不合法/不完整时抛出 FacetEvidenceError，
 * 由核心统一转成 UNKNOWN。
 */
export interface BoundEvidence {
  readonly environment: "browser" | "windows";
  readonly captureId: string;
  readonly subject: EvidenceSubjectRef;
  requireFacet(facetId: string): FacetValue;
  optionalFacet(facetId: string): FacetValue | undefined;
}

/** requireFacet 取不到合格当次证据时抛出；reason 决定核心的 UNKNOWN 归因。 */
export class FacetEvidenceError extends Error {
  constructor(readonly reason:
      | "provider_unregistered"
      | "facet_missing"
      | "schema_version_mismatch"
      | "schema_invalid"
      | "subject_unbound"
      | "subject_mismatch"
      | "capture_stale"
      | "source_mismatch"
      | "facet_incomplete"
      | "bad_envelope") {
    super(`facet evidence unavailable: ${reason}`);
    this.name = "FacetEvidenceError";
  }
}

export interface VerifierContributor {
  readonly id: string;
  readonly criterionSchemaVersion: number;
  canEvaluate(criterion: DomainCriterion): boolean;
  validateCriterion(criterion: DomainCriterion): CriterionValidation;
  /** 纯函数式裁决：只读 BoundEvidence，不允许网络/模型/Oracle/历史。抛错由核心转 UNKNOWN。 */
  evaluate(criterion: DomainCriterion, evidence: BoundEvidence): ContributorResult;
}

/** Contributor 注册表；重复 id 拒绝。 */
export class ContributorRegistry {
  private readonly contributors = new Map<string, VerifierContributor>();

  register(contributor: VerifierContributor): void {
    if (this.contributors.has(contributor.id)) {
      throw new Error(`Verifier contributor ${contributor.id} 已注册`);
    }
    if (!Number.isInteger(contributor.criterionSchemaVersion) || contributor.criterionSchemaVersion < 1) {
      throw new Error(`Contributor ${contributor.id} 的 criterionSchemaVersion 必须是 >=1 的整数`);
    }
    for (const method of ["canEvaluate", "validateCriterion", "evaluate"] as const) {
      if (typeof contributor[method] !== "function") {
        throw new Error(`Contributor ${contributor.id} 缺少 ${method}`);
      }
    }
    this.contributors.set(contributor.id, contributor);
  }

  get(domain: string): VerifierContributor | undefined {
    return this.contributors.get(domain);
  }

  list(): VerifierContributor[] {
    return [...this.contributors.values()];
  }
}
