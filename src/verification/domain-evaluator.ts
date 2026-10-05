import type { Observation } from "../actions/schema.js";
import type { FacetRegistry } from "../contracts/facets.js";
import type {
  ContributorResult, DomainCriterion, EvidenceRef, VerifierContributor,
} from "../contracts/verifier-contributor.js";
import { FacetEvidenceError } from "../contracts/verifier-contributor.js";
import {
  captureIdOf, createBoundEvidence, subjectOf, validateBoundFacet,
} from "./facet-binding.js";

/** 进入 Trace 的可审计链：DomainCriterion → contributor/version → capture/subject/evidenceRefs → verdict。 */
export interface DomainCriterionAudit {
  domain: string;
  predicate: string;
  args: Record<string, unknown>;
  contributorId: string;
  contributorFound: boolean;
  criterionSchemaVersion?: number;
  providerVersions: string[];
  captureId?: string;
  subjectRef?: EvidenceRef["subjectRef"];
  evidenceRefs: EvidenceRef[];
}

export interface DomainCheckOutcome {
  criterion: string;
  verdict: "pass" | "fail" | "unknown";
  reason?: string;
  message: string;
  actual?: unknown;
  audit: DomainCriterionAudit;
}

export type DomainEvaluator = (
  domainChecks: DomainCriterion[] | undefined,
  observation: Observation | undefined,
) => DomainCheckOutcome[];

function unknownOutcome(
  criterion: DomainCriterion,
  index: number,
  reason: string,
  message: string,
  partial: Partial<DomainCriterionAudit> = {},
): DomainCheckOutcome {
  return {
    criterion: `domainChecks:${index}:${criterion.domain}:${criterion.predicate}`,
    verdict: "unknown", reason, message,
    audit: { domain: criterion.domain, predicate: criterion.predicate, args: criterion.args ?? {},
      contributorId: criterion.domain, contributorFound: partial.contributorFound ?? false,
      providerVersions: partial.providerVersions ?? [], evidenceRefs: [],
      ...(partial.criterionSchemaVersion !== undefined ? { criterionSchemaVersion: partial.criterionSchemaVersion } : {}),
      ...(partial.captureId !== undefined ? { captureId: partial.captureId } : {}),
      ...(partial.subjectRef !== undefined ? { subjectRef: partial.subjectRef } : {}),
      ...(partial.evidenceRefs ? { evidenceRefs: partial.evidenceRefs } : {}) },
  };
}

/**
 * 核心域裁决：业务无关地遍历 domainChecks，把证据外壳门统一做掉。
 * 缺 contributor / schema 不合法 / 抛错 / 证据非当次或对象不明 / FAIL 无当次反证 → UNKNOWN。
 */
export function evaluateDomainCriterion(
  criterion: DomainCriterion,
  index: number,
  observation: Observation | undefined,
  contributors: ContributorRegistryLike,
  facets: FacetRegistry,
): DomainCheckOutcome {
  const label = `domainChecks:${index}:${criterion.domain}:${criterion.predicate}`;
  const captureId = captureIdOf(observation);
  const subject = subjectOf(observation);

  if (!observation) {
    return unknownOutcome(criterion, index, "evidence_unavailable", "缺少任务后新鲜观察，域条件无法验收");
  }
  if (!captureId) {
    return unknownOutcome(criterion, index, "observation_stale", "观察缺少当次 capture 身份，不能据此裁决域条件");
  }
  if (!subject) {
    return unknownOutcome(criterion, index, "target_ambiguous", "观察对象身份不明确，域证据不能绑定到任务对象",
      { captureId });
  }

  const contributor = contributors.get(criterion.domain);
  if (!contributor) {
    return unknownOutcome(criterion, index, "unsupported_condition",
      `域 ${criterion.domain} 的验收贡献者未注册，禁止静默忽略`, { contributorFound: false, captureId, subjectRef: subject });
  }
  const base = { contributorFound: true, captureId, subjectRef: subject,
    criterionSchemaVersion: contributor.criterionSchemaVersion };

  if (!criterion || typeof criterion.predicate !== "string" || !criterion.predicate
      || (criterion.args !== undefined && (typeof criterion.args !== "object" || Array.isArray(criterion.args)))) {
    return unknownOutcome(criterion, index, "unsupported_condition", "域完成条件结构不合法", base);
  }
  if (!contributor.canEvaluate(criterion)) {
    return unknownOutcome(criterion, index, "unsupported_condition",
      `贡献者 ${criterion.domain} 不接受谓词 ${criterion.predicate}`, base);
  }
  const criterionValidation = contributor.validateCriterion(criterion);
  if (!criterionValidation.ok) {
    return unknownOutcome(criterion, index, "unsupported_condition",
      `域完成条件 schema 校验失败：${criterionValidation.reason}`, base);
  }

  const bound = createBoundEvidence(observation, facets, { captureId, subject,
    finishedAt: observation.capture?.finishedAt });

  let result: ContributorResult;
  try {
    result = contributor.evaluate(criterion, bound);
  } catch (error) {
    if (error instanceof FacetEvidenceError) {
      return unknownOutcome(criterion, index, facetReasonToUnknown(error.reason),
        `域证据未通过当次绑定：${error.reason}`, base);
    }
    return unknownOutcome(criterion, index, "verification_error",
      `域贡献者执行异常，未放行：${error instanceof Error ? error.message : String(error)}`, base);
  }

  if (!result || !["pass", "fail", "unknown"].includes(result.verdict)) {
    return unknownOutcome(criterion, index, "verification_error", "域贡献者返回了无效结论", base);
  }
  if (result.criterionSchemaVersion !== contributor.criterionSchemaVersion) {
    return unknownOutcome(criterion, index, "unsupported_condition",
      "域贡献者返回的 criterionSchemaVersion 与其注册版本不一致", base);
  }
  if (typeof result.message !== "string" || !result.message) {
    return unknownOutcome(criterion, index, "verification_error", "域贡献者返回缺少 message", base);
  }

  // 只接受能解析到「当次 capture + 同一 subject + 已通过 schema 校验」facet 的证据引用。
  const validRefs: EvidenceRef[] = [];
  for (const ref of Array.isArray(result.evidenceRefs) ? result.evidenceRefs : []) {
    if (!ref || ref.captureId !== captureId) continue;
    if (!ref.subjectRef || ref.subjectRef.key !== subject.key) continue;
    const provider = facets.get(ref.facetId);
    const facet = observation.facets?.[ref.facetId];
    const check = validateBoundFacet(facet, provider, { captureId, subject,
      finishedAt: observation.capture?.finishedAt });
    if (!check.ok || !provider) continue;
    validRefs.push({ facetId: ref.facetId, captureId, subjectRef: subject,
      providerVersion: provider.providerVersion, schemaVersion: provider.schemaVersion });
  }

  const audit: DomainCriterionAudit = {
    domain: criterion.domain, predicate: criterion.predicate, args: criterion.args ?? {},
    contributorId: contributor.id, contributorFound: true,
    criterionSchemaVersion: contributor.criterionSchemaVersion,
    providerVersions: [...new Set(validRefs.map((ref) => ref.providerVersion))],
    captureId, subjectRef: subject, evidenceRefs: validRefs,
  };

  if (result.verdict === "unknown") {
    return { criterion: label, verdict: "unknown",
      reason: result.reason ?? "evidence_unavailable", message: result.message,
      ...(result.actual !== undefined ? { actual: result.actual } : {}), audit };
  }
  // PASS 与 FAIL 都必须绑定至少一份当次证据；FAIL 尤其必须有当次反证，否则降 UNKNOWN。
  if (validRefs.length === 0) {
    return { criterion: label, verdict: "unknown", reason: "evidence_unavailable",
      message: `${result.verdict === "fail" ? "FAIL 缺少当次反证" : "PASS 缺少当次证据"}，已降为 UNKNOWN`,
      ...(result.actual !== undefined ? { actual: result.actual } : {}),
      audit: { ...audit, evidenceRefs: [] } };
  }
  return { criterion: label, verdict: result.verdict,
    message: result.message, ...(result.actual !== undefined ? { actual: result.actual } : {}), audit };
}

function facetReasonToUnknown(reason: FacetEvidenceError["reason"]): string {
  switch (reason) {
    case "provider_unregistered":
    case "facet_missing": return "evidence_unavailable";
    case "schema_version_mismatch":
    case "schema_invalid":
    case "bad_envelope":
    case "source_mismatch": return "unsupported_condition";
    case "subject_unbound":
    case "subject_mismatch": return "target_ambiguous";
    case "capture_stale": return "observation_stale";
    case "facet_incomplete": return "evidence_unavailable";
    default: return "evidence_unavailable";
  }
}

/** ContributorRegistry 的最小结构（避免核心模块循环依赖具体类）。 */
export interface ContributorRegistryLike {
  get(domain: string): VerifierContributor | undefined;
}

export function createDomainEvaluator(
  contributors: ContributorRegistryLike,
  facets: FacetRegistry,
): DomainEvaluator {
  return (domainChecks, observation) =>
    (domainChecks ?? []).map((criterion, index) =>
      evaluateDomainCriterion(criterion, index, observation, contributors, facets));
}
