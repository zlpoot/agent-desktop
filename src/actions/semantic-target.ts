import type { ComputerAction, GroundingAttempt, GroundingStrategy, Observation, Target, TargetSpec } from "./schema.js";

/** 跨浏览器和桌面复用的目标含义，不包含一次性坐标或 DOM 选择器。 */
export interface SemanticTarget {
  label: string;
  role?: string;
}

/** 一次观察中的定位结果；selected 不是 Workflow 的持久目标。 */
export interface TargetBinding {
  semantic?: SemanticTarget;
  selected: Target;
  strategy: GroundingStrategy;
  detail: string;
  context: { url?: string; windowHandle?: number; screenshotHash?: string };
}

function fromTarget(target: Target): SemanticTarget | undefined {
  if (target.kind === "role" && target.name?.trim()) {
    return { label: target.name.trim(), role: target.role.trim().toLowerCase() };
  }
  if (target.kind === "label") return target.label.trim() ? { label: target.label.trim() } : undefined;
  if (target.kind === "text") return target.text.trim() ? { label: target.text.trim() } : undefined;
  if (target.kind === "vision") return target.description.trim()
    ? { label: target.description.trim() } : undefined;
  return undefined;
}

export function semanticTarget(spec: TargetSpec): SemanticTarget | undefined {
  if (spec.kind !== "candidates") return fromTarget(spec);
  const meanings = spec.options.map(fromTarget).filter((item): item is SemanticTarget => !!item);
  if (!meanings.length || meanings.some((item) => item.label !== meanings[0].label)) return undefined;
  return meanings.find((item) => item.role) ?? meanings[0];
}

export function bindTarget(action: ComputerAction, selected: Target,
  attempts: readonly GroundingAttempt[], observation?: Observation): TargetBinding | undefined {
  if (action.kind !== "click" && action.kind !== "double_click" && action.kind !== "type" &&
      action.kind !== "paste_text" && action.kind !== "scroll") return undefined;
  if (action.kind === "scroll" && !action.target) return undefined;
  const match = attempts.find((attempt) => attempt.selected);
  const semantic = semanticTarget(action.target!);
  return { ...(semantic ? { semantic } : {}),
    selected, strategy: match?.strategy ?? selected.kind,
    detail: match?.detail ?? "运行时未提供定位证据",
    context: { ...(observation?.url ? { url: observation.url } : {}),
      ...(observation?.windowHandle !== undefined ? { windowHandle: observation.windowHandle } : {}),
      ...(observation?.screenshotHash ? { screenshotHash: observation.screenshotHash } : {}) } };
}
