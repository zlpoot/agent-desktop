import type { Observation } from "../actions/schema.js";
import type {
  EvidenceSubjectRef, FacetContext, FacetPayload, FacetValue,
  FacetDomReadRequest, FacetDomReadResult, ObservationFacetProvider,
} from "../contracts/facets.js";
import { FacetRegistry } from "../contracts/facets.js";
import type { BoundEvidence } from "../contracts/verifier-contributor.js";
import { FacetEvidenceError } from "../contracts/verifier-contributor.js";

/** facet.capturedAt 与当次 capture.finishedAt 的最大时差；超出即判陈旧。 */
export const FACET_FRESHNESS_MS = 10_000;

/** 从观察的 capture 信封取当次身份；缺失则无法绑定，后续一律 UNKNOWN。 */
export function captureIdOf(observation: Observation | undefined): string | undefined {
  const capture = observation?.capture;
  if (!capture || !capture.epoch || typeof capture.sequence !== "number") return undefined;
  return `${capture.epoch}:${capture.sequence}`;
}

/** 从观察推导唯一任务对象；浏览器用 origin+pathname，桌面用窗口句柄+标题。 */
export function subjectOf(observation: Observation | undefined): EvidenceSubjectRef | undefined {
  if (!observation) return undefined;
  const object = observation.capture?.object ?? "";
  if (object.startsWith("window:") || observation.windowHandle !== undefined) {
    if (observation.windowHandle === undefined && !observation.windowTitle) return undefined;
    const key = observation.windowHandle !== undefined
      ? `window:${observation.windowHandle}:${observation.windowTitle ?? ""}`
      : `window:? :${observation.windowTitle ?? ""}`;
    return { kind: "desktop_window", key,
      ...(observation.windowHandle !== undefined ? { windowHandle: observation.windowHandle } : {}),
      ...(observation.windowTitle !== undefined ? { windowTitle: observation.windowTitle } : {}) };
  }
  if (observation.url) {
    try {
      const url = new URL(observation.url);
      return { kind: "browser_page", key: `${url.origin}${url.pathname}`, url: observation.url };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function environmentOf(observation: Observation): "browser" | "windows" | undefined {
  const object = observation.capture?.object ?? "";
  if (object.startsWith("window:")) return "windows";
  if (object.startsWith("page:")) return "browser";
  if (observation.windowHandle !== undefined) return "windows";
  if (observation.url) return "browser";
  return undefined;
}

/**
 * 核心 facet 采集管道：对命中环境的 provider 逐个采集，并由核心统一盖章证据信封。
 * provider 无法伪造 captureId/subject/source/capturedAt；不命中返回 undefined 即无 facet。
 * 任何 provider 抛错都只导致「没有该 facet」，依赖它的验收随后 fail-closed 为 UNKNOWN。
 */
export async function collectFacets(
  observation: Observation,
  providers: ObservationFacetProvider[],
  domReader?: (request: FacetDomReadRequest) => Promise<FacetDomReadResult[]>,
): Promise<Observation> {
  const environment = environmentOf(observation);
  const captureId = captureIdOf(observation);
  const subject = subjectOf(observation);
  // 无当次 capture / 无明确对象时不采集：任何域裁决都会因绑定缺失而 UNKNOWN，
  // 不允许用一枚无法绑定的 facet 冒充证据。
  if (!environment || !captureId || !subject) return observation;

  const facets = { ...(observation.facets ?? {}) };
  const capturedAt = Date.now();
  const readDom: FacetContext["readDom"] = environment === "browser" && domReader
    ? (request) => domReader(request)
    : undefined;
  const ctx: FacetContext = { environment, captureId, subject, capturedAt,
    ...(observation.url !== undefined ? { pageUrl: observation.url } : {}),
    ...(observation.windowTitle !== undefined ? { windowTitle: observation.windowTitle } : {}),
    ...(observation.accessibility !== undefined ? { accessibility: observation.accessibility } : {}),
    ...(readDom ? { readDom } : {}) };

  for (const provider of providers) {
    if (provider.environment !== environment) continue;
    let payload: FacetPayload | undefined;
    try { payload = await provider.collect(ctx); }
    catch { payload = undefined; }
    if (!payload) continue;
    // 信封由核心盖章；provider 只给 complete/data。
    facets[provider.id] = {
      facetId: provider.id,
      schemaVersion: provider.schemaVersion,
      providerVersion: provider.providerVersion,
      captureId,
      subjectRef: subject,
      source: provider.source,
      capturedAt,
      complete: payload.complete === true,
      data: payload.data,
    };
  }
  return { ...observation, facets };
}

export interface FacetBindingContext {
  captureId: string;
  subject: EvidenceSubjectRef;
  /** 当次观察的采集完成时间，用于 capturedAt 新鲜度核对。 */
  finishedAt?: number;
}

type BindFailure = FacetEvidenceError["reason"];

/** 对一枚 facet 做当次绑定与 schema 校验；任何不过都给出失败原因（fail-closed）。 */
export function validateBoundFacet(
  facet: FacetValue | undefined,
  provider: ObservationFacetProvider | undefined,
  context: FacetBindingContext,
): { ok: true } | { ok: false; reason: BindFailure } {
  if (!provider) return { ok: false, reason: "provider_unregistered" };
  if (!facet) return { ok: false, reason: "facet_missing" };
  if (facet.facetId !== provider.id) return { ok: false, reason: "bad_envelope" };
  if (facet.schemaVersion !== provider.schemaVersion) return { ok: false, reason: "schema_version_mismatch" };
  if (typeof facet.providerVersion !== "string" || !facet.providerVersion.trim()
      || facet.providerVersion !== provider.providerVersion) {
    return { ok: false, reason: "bad_envelope" };
  }
  if (!facet.captureId || facet.captureId !== context.captureId) return { ok: false, reason: "capture_stale" };
  if (!facet.subjectRef || !facet.subjectRef.key) return { ok: false, reason: "subject_unbound" };
  if (facet.subjectRef.kind !== context.subject.kind || facet.subjectRef.key !== context.subject.key) {
    return { ok: false, reason: "subject_mismatch" };
  }
  const allowedSources = ["dom", "uia", "app_api", "window", "file"];
  if (!allowedSources.includes(facet.source) || facet.source !== provider.source) {
    return { ok: false, reason: "source_mismatch" };
  }
  if (typeof facet.capturedAt !== "number" || !Number.isFinite(facet.capturedAt)) {
    return { ok: false, reason: "bad_envelope" };
  }
  if (context.finishedAt !== undefined &&
      Math.abs(facet.capturedAt - context.finishedAt) > FACET_FRESHNESS_MS) {
    return { ok: false, reason: "capture_stale" };
  }
  if (facet.complete !== true) return { ok: false, reason: "facet_incomplete" };
  const validation = provider.validate(facet.data);
  if (!validation.ok) return { ok: false, reason: "schema_invalid" };
  return { ok: true };
}

/** 构造只暴露当次已绑定 facet 的证据视图；contributor 经它取不到任何历史/Oracle/模型数据。 */
export function createBoundEvidence(
  observation: Observation,
  registry: FacetRegistry,
  context: FacetBindingContext,
): BoundEvidence {
  const environment = environmentOf(observation) ?? "windows";
  const resolve = (facetId: string): FacetValue | undefined => observation.facets?.[facetId];
  return {
    environment,
    captureId: context.captureId,
    subject: context.subject,
    requireFacet(facetId: string): FacetValue {
      const provider = registry.get(facetId);
      const facet = resolve(facetId);
      const result = validateBoundFacet(facet, provider, context);
      if (!result.ok) throw new FacetEvidenceError(result.reason);
      return facet as FacetValue;
    },
    optionalFacet(facetId: string): FacetValue | undefined {
      const facet = resolve(facetId);
      if (!facet) return undefined;
      const provider = registry.get(facetId);
      const result = validateBoundFacet(facet, provider, context);
      if (!result.ok) throw new FacetEvidenceError(result.reason);
      return facet;
    },
  };
}
