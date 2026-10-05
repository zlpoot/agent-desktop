import type {
  FacetPayload, FacetSchemaValidation, ObservationFacetProvider,
} from "../../contracts/facets.js";
import type {
  BoundEvidence, ContributorResult, CriterionValidation, DomainCriterion,
  VerifierContributor,
} from "../../contracts/verifier-contributor.js";

const FACET_ID = "music.netease";
const SCHEMA_VERSION = 1;
const PROVIDER_VERSION = "1.0.0";

export interface MusicPlaybackData {
  title: string;
  artist: string;
  playing: boolean;
}

/** 从当次 UIA 窗口标题与控件树派生播放器状态；不访问网络/模型/历史。 */
export function deriveMusicPlayback(windowTitle: string | undefined,
  accessibility: string | undefined): MusicPlaybackData | undefined {
  if (!windowTitle) return undefined;
  const ax = accessibility ?? "";
  // 与 Guest worker.py 同源：可见迷你栏控件的 autoId 只可能是 play/pause 之一。
  const hasPlay = ax.includes("btn_pc_minibar_play");
  const hasPause = ax.includes("btn_pc_minibar_pause");
  if (!hasPlay && !hasPause) return undefined;
  // worker: title_parts = window_text().rsplit(" - ", 1)
  const cut = windowTitle.lastIndexOf(" - ");
  const title = (cut >= 0 ? windowTitle.slice(0, cut) : windowTitle).trim();
  const artist = (cut >= 0 ? windowTitle.slice(cut + 3) : "").trim();
  if (!title) return undefined;
  // worker: playing = any(name=="pause" or autoId=="btn_pc_minibar_pause")
  const playing = hasPause || /\|\s*pause\s*\|/.test(ax);
  return { title, artist, playing };
}

function validate(data: unknown): FacetSchemaValidation {
  if (typeof data !== "object" || data === null) {
    return { ok: false, reason: "music.netease facet data 必须是对象" };
  }
  const value = data as Record<string, unknown>;
  return typeof value.title === "string" && value.title.length > 0 &&
    typeof value.artist === "string" && typeof value.playing === "boolean"
    ? { ok: true }
    : { ok: false, reason: "music.netease facet data 需要 title(string)/artist(string)/playing(boolean)" };
}

/** 网易云播放器 facet provider：windows/UIA，仅在检测到迷你栏控件时产出。 */
export const musicFacetProvider: ObservationFacetProvider = {
  id: FACET_ID,
  schemaVersion: SCHEMA_VERSION,
  providerVersion: PROVIDER_VERSION,
  environment: "windows",
  source: "uia",
  validate,
  async collect(ctx): Promise<FacetPayload | undefined> {
    const playback = deriveMusicPlayback(ctx.windowTitle, ctx.accessibility);
    if (!playback) return undefined;
    return { complete: true, data: playback };
  },
};

function refs(bound: BoundEvidence, facet: { providerVersion: string; schemaVersion: number }) {
  return [{ facetId: FACET_ID, captureId: bound.captureId, subjectRef: bound.subject,
    providerVersion: facet.providerVersion, schemaVersion: facet.schemaVersion }];
}

/** 播放器域验收贡献者：只在当次、已绑定的 music.netease facet 上裁决。 */
export const musicContributor: VerifierContributor = {
  id: FACET_ID,
  criterionSchemaVersion: 1,
  canEvaluate(criterion: DomainCriterion): boolean {
    return criterion.domain === FACET_ID
      && ["titleIncludes", "artistIncludes", "playing"].includes(criterion.predicate);
  },
  validateCriterion(criterion: DomainCriterion): CriterionValidation {
    const args = criterion.args ?? {};
    if (criterion.predicate === "playing") {
      return typeof args.equals === "boolean"
        ? { ok: true } : { ok: false, reason: "playing 需要布尔 args.equals" };
    }
    const key = criterion.predicate === "titleIncludes" ? "includes"
      : criterion.predicate === "artistIncludes" ? "includes" : "";
    if (key && typeof args.includes === "string" && args.includes.trim().length > 0) return { ok: true };
    return { ok: false, reason: `${criterion.predicate} 需要非空字符串 args.includes` };
  },
  evaluate(criterion: DomainCriterion, bound: BoundEvidence): ContributorResult {
    const facet = bound.requireFacet(FACET_ID);
    const playback = facet.data as MusicPlaybackData;
    const evidenceRefs = refs(bound, facet);
    const base = { criterionSchemaVersion: 1, evidenceRefs };
    const args = criterion.args ?? {};

    if (criterion.predicate === "playing") {
      const expected = args.equals === true;
      if (playback.playing !== expected) {
        return { ...base, verdict: "fail", actual: playback.playing,
          message: expected ? "播放器尚未开始播放" : "播放器尚未暂停" };
      }
      return { ...base, verdict: "pass", actual: playback.playing,
        message: expected ? "播放器正在播放" : "播放器已暂停" };
    }
    if (criterion.predicate === "artistIncludes") {
      const includes = String(args.includes);
      if (!playback.artist.includes(includes)) {
        return { ...base, verdict: "fail", actual: playback.artist,
          message: `当前播放歌手未包含 ${includes}` };
      }
      return { ...base, verdict: "pass", actual: playback.artist,
        message: `当前播放歌手已包含 ${includes}` };
    }
    const includes = String(args.includes);
    if (!playback.title.includes(includes)) {
      return { ...base, verdict: "fail", actual: playback.title,
        message: `当前播放歌曲未包含 ${includes}` };
    }
    return { ...base, verdict: "pass", actual: playback.title,
      message: `当前播放歌曲已包含 ${includes}` };
  },
};
