import type { ComputerState } from "../graph/state.js";
import type { ExtensionRegistry, TaskProfile } from "../contracts/extension.js";

export type { TaskProfile } from "../contracts/extension.js";

/** 场景知识只由扩展登记；阶段图、规划器和执行器不识别应用名称。 */
export function taskProfile(goal: string, registry: ExtensionRegistry): TaskProfile | undefined {
  return registry.profileFor(goal);
}

export function taskContract(goal: string, profile?: TaskProfile): NonNullable<ComputerState["taskContract"]> {
  return { target: profile?.target?.(goal) ?? goal, stageActionLimit: 24, taskActionLimit: 80,
    constraint: profile?.constraint ?? "按照用户目标执行；每阶段以当前可观察结果为准，不扩大任务范围",
    ...(profile ? { profileId: profile.id } : {}),
    ...(profile?.allowedActions ? { allowedActions: profile.allowedActions } : {}),
    ...(profile?.requireTargetedScroll ? { requireTargetedScroll: true } : {}),
  };
}
