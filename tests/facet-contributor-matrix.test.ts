import assert from "node:assert/strict";
import { test } from "node:test";
import type { Observation } from "../src/actions/schema.js";
import type {
  FacetPayload, FacetSchemaValidation, ObservationFacetProvider, FacetValue,
} from "../src/contracts/facets.js";
import { FacetRegistry } from "../src/contracts/facets.js";
import type {
  BoundEvidence, ContributorResult, DomainCriterion, VerifierContributor,
} from "../src/contracts/verifier-contributor.js";
import { ContributorRegistry, FacetEvidenceError } from "../src/contracts/verifier-contributor.js";
import { collectFacets } from "../src/verification/facet-binding.js";
import { createDomainEvaluator } from "../src/verification/domain-evaluator.js";
import { deterministicChecks } from "../src/verifier/hybrid-verifier.js";

const DOMAIN = "test.domain";

function makeProvider(overrides: { complete?: boolean; valid?: boolean; data?: unknown } = {}):
    ObservationFacetProvider {
  const valid = overrides.valid ?? true;
  return {
    id: DOMAIN, schemaVersion: 1, providerVersion: "1.0.0",
    environment: "browser", source: "dom",
    validate: ((data: unknown): FacetSchemaValidation => {
      if (!valid) return { ok: false, reason: "test schema invalid" };
      return typeof data === "object" && data !== null ? { ok: true }
        : { ok: false, reason: "not object" };
    }) as ObservationFacetProvider["validate"],
    async collect(): Promise<FacetPayload | undefined> {
      return { complete: overrides.complete ?? true,
        data: (overrides.data ?? { value: 1 }) as Record<string, unknown> };
    },
  };
}

/** 可控 contributor：equals 比较 data.value；refs 决定是否给当次证据；throwKind 决定抛错。 */
function makeContributor(controls: {
    refs?: "bound" | "none"; throwKind?: "facet" | "generic" | "none" } = {}): VerifierContributor {
  return {
    id: DOMAIN, criterionSchemaVersion: 1,
    canEvaluate: (c: DomainCriterion) => c.domain === DOMAIN && c.predicate === "equals",
    validateCriterion: (c: DomainCriterion) =>
      typeof c.args?.value === "number" ? { ok: true } : { ok: false, reason: "need number args.value" },
    evaluate(criterion: DomainCriterion, bound: BoundEvidence): ContributorResult {
      if (controls.throwKind === "facet") throw new FacetEvidenceError("facet_missing");
      if (controls.throwKind === "generic") throw new Error("boom");
      const facet = bound.requireFacet(DOMAIN);
      const refs = controls.refs === "none" ? [] : [{
        facetId: DOMAIN, captureId: bound.captureId, subjectRef: bound.subject,
        providerVersion: facet.providerVersion, schemaVersion: facet.schemaVersion }];
      const expected = Number(criterion.args.value);
      const actual = (facet.data as { value: number }).value;
      return { criterionSchemaVersion: 1, evidenceRefs: refs, actual,
        verdict: actual === expected ? "pass" : "fail",
        message: actual === expected ? "equal" : "not equal" };
    },
  };
}

async function capturedObservation(provider: ObservationFacetProvider): Promise<Observation> {
  const now = Date.now();
  const base: Observation = {
    url: "https://example.test/item",
    capture: { epoch: "ep", sequence: 3, object: "page:https://example.test/item",
      startedAt: now - 40, finishedAt: now, clock: "collector", atomic: false,
      fields: { dom: { complete: true, source: "dom" } }, enumerationComplete: true },
  };
  return collectFacets(base, [provider]);
}

function registries(provider: ObservationFacetProvider | undefined,
    contributor: VerifierContributor | undefined) {
  const facets = new FacetRegistry();
  if (provider) facets.register(provider);
  const contributors = new ContributorRegistry();
  if (contributor) contributors.register(contributor);
  return { facets, contributors, evaluate: createDomainEvaluator(contributors, facets) };
}

const criterion: DomainCriterion = { domain: DOMAIN, predicate: "equals", args: { value: 1 } };

/** 篡改 observation.facets 信封中的某个字段（provider 无法在正常管道做到，仅测试门本身）。 */
function tamper(observation: Observation, patch: Partial<FacetValue>): Observation {
  const current = observation.facets![DOMAIN];
  return { ...observation, facets: { [DOMAIN]: { ...current, ...patch } } };
}

test("正例：当次同对象完整 facet 时 PASS，audit 带齐 contributor/版本/capture/subject/refs", async () => {
  const provider = makeProvider();
  const { evaluate } = registries(provider, makeContributor());
  const [outcome] = evaluate([criterion], await capturedObservation(provider));
  assert.equal(outcome.verdict, "pass");
  assert.equal(outcome.audit.contributorFound, true);
  assert.equal(outcome.audit.contributorId, DOMAIN);
  assert.equal(outcome.audit.criterionSchemaVersion, 1);
  assert.deepEqual(outcome.audit.providerVersions, ["1.0.0"]);
  assert.equal(outcome.audit.captureId, "ep:3");
  assert.equal(outcome.audit.subjectRef?.kind, "browser_page");
  assert.equal(outcome.audit.evidenceRefs.length, 1);
  // S8：同一审计链必须进入 AcceptanceReport.checks[].domainAudit（Trace 可审计）。
  const obs = await capturedObservation(provider);
  const checks = deterministicChecks({ domainChecks: [criterion] }, obs, undefined, evaluate);
  const domainCheck = checks.find((check) => check.criterion.startsWith("domainChecks:"));
  assert.equal(domainCheck?.verdict, "pass");
  assert.equal(domainCheck?.domainAudit?.contributorId, DOMAIN);
  assert.equal(domainCheck?.domainAudit?.evidenceRefs[0]?.captureId, "ep:3");
});

test("负例1：facet provider 未注册 → 无当次 facet → UNKNOWN", async () => {
  const provider = makeProvider();
  const { evaluate } = registries(undefined, makeContributor());
  const [outcome] = evaluate([criterion], await capturedObservation(provider));
  assert.equal(outcome.verdict, "unknown");
});

test("负例2：schemaVersion/providerVersion 不兼容 → UNKNOWN", async () => {
  const provider = makeProvider();
  const { evaluate } = registries(provider, makeContributor());
  const obs = await capturedObservation(provider);
  const schemaBad = evaluate([criterion], tamper(obs, { schemaVersion: 9 }))[0];
  assert.equal(schemaBad.verdict, "unknown");
  const versionBad = evaluate([criterion], tamper(obs, { providerVersion: "9.9.9" }))[0];
  assert.equal(versionBad.verdict, "unknown");
});

test("负例3：provider schema 校验失败 → UNKNOWN", async () => {
  const provider = makeProvider({ valid: false });
  const { evaluate } = registries(provider, makeContributor());
  const [outcome] = evaluate([criterion], await capturedObservation(provider));
  assert.equal(outcome.verdict, "unknown");
});

test("负例4：subjectRef 未绑定或不匹配 → UNKNOWN(target_ambiguous)", async () => {
  const provider = makeProvider();
  const { evaluate } = registries(provider, makeContributor());
  const obs = await capturedObservation(provider);
  const mismatched = evaluate([criterion],
    tamper(obs, { subjectRef: { kind: "browser_page", key: "https://other.test/x" } }))[0];
  assert.equal(mismatched.verdict, "unknown");
  assert.equal(mismatched.audit.subjectRef?.key, "https://example.test/item");
  const unbound = evaluate([criterion],
    tamper(obs, { subjectRef: { kind: "browser_page", key: "" } }))[0];
  assert.equal(unbound.verdict, "unknown");
});

test("负例5：capture 非当次或 facet 陈旧 → UNKNOWN(observation_stale)", async () => {
  const provider = makeProvider();
  const { evaluate } = registries(provider, makeContributor());
  const obs = await capturedObservation(provider);
  const staleCapture = evaluate([criterion], tamper(obs, { captureId: "ep:999" }))[0];
  assert.equal(staleCapture.verdict, "unknown");
  const staleTime = evaluate([criterion],
    tamper(obs, { capturedAt: obs.capture!.finishedAt - 20_000 }))[0];
  assert.equal(staleTime.verdict, "unknown");
});

test("负例6：facet complete=false → UNKNOWN，不允许据不完整证据裁决", async () => {
  const provider = makeProvider({ complete: false });
  const { evaluate } = registries(provider, makeContributor());
  const [outcome] = evaluate([criterion], await capturedObservation(provider));
  assert.equal(outcome.verdict, "unknown");
  assert.equal(outcome.audit.evidenceRefs.length, 0);
});

test("负例7：contributor 缺失 → UNKNOWN(unsupported_condition)，不静默忽略", async () => {
  const provider = makeProvider();
  const { evaluate } = registries(provider, undefined);
  const [outcome] = evaluate([criterion], await capturedObservation(provider));
  assert.equal(outcome.verdict, "unknown");
  assert.equal(outcome.reason, "unsupported_condition");
  assert.equal(outcome.audit.contributorFound, false);
});

test("负例8：contributor 抛 FacetEvidenceError 或其它异常 → 一律 UNKNOWN", async () => {
  const provider = makeProvider();
  const facetThrow = registries(provider, makeContributor({ throwKind: "facet" })).evaluate;
  assert.equal(facetThrow([criterion], await capturedObservation(provider))[0].verdict, "unknown");
  const genericThrow = registries(provider, makeContributor({ throwKind: "generic" })).evaluate;
  const outcome = genericThrow([criterion], await capturedObservation(provider))[0];
  assert.equal(outcome.verdict, "unknown");
  assert.equal(outcome.reason, "verification_error");
});

test("负例9：FAIL/PASS 无当次证据引用 → 降 UNKNOWN；有当次反证的 FAIL 才成立", async () => {
  const failingProvider = makeProvider({ data: { value: 2 } });
  // 有反证引用：FAIL 成立。
  const withRefs = registries(failingProvider, makeContributor()).evaluate;
  const fail = withRefs([criterion], await capturedObservation(failingProvider))[0];
  assert.equal(fail.verdict, "fail");
  assert.equal(fail.audit.evidenceRefs.length, 1);
  // contributor 返回 FAIL 但不给 evidenceRefs：核心降 UNKNOWN。
  const noRefs = registries(failingProvider, makeContributor({ refs: "none" })).evaluate;
  const downgraded = noRefs([criterion], await capturedObservation(failingProvider))[0];
  assert.equal(downgraded.verdict, "unknown");
  assert.equal(downgraded.reason, "evidence_unavailable");
});

test("负例10：Oracle/EVAL provenance 无法进入生产 contributor：非允许来源 → UNKNOWN", async () => {
  const provider = makeProvider();
  const { evaluate } = registries(provider, makeContributor());
  const obs = await capturedObservation(provider);
  // eval_oracle 不在生产 FacetSource 允许列表，即便伪造进信封也会被来源门拒绝。
  const forged = evaluate([criterion],
    tamper(obs, { source: "eval_oracle" as FacetValue["source"] }))[0];
  assert.equal(forged.verdict, "unknown");
  // 生产允许来源集合固定为 5 类，不含 eval_oracle。
  const allowed = ["dom", "uia", "app_api", "window", "file"] as const;
  assert.equal(allowed.includes("eval_oracle" as never), false);
});

test("缺观察/缺 capture/缺对象身份 → UNKNOWN，不放行", () => {
  const provider = makeProvider();
  const { evaluate } = registries(provider, makeContributor());
  assert.equal(evaluate([criterion], undefined)[0].verdict, "unknown");
  assert.equal(evaluate([criterion], { url: "https://example.test/item" })[0].verdict, "unknown");
  assert.equal(evaluate([criterion],
    { capture: { epoch: "ep", sequence: 1, object: "page:x", startedAt: 1, finishedAt: 2,
      clock: "collector", atomic: false, fields: {} } })[0].verdict, "unknown");
});
