import type { ExtensionRegistry, SpecializedTaskCapability } from "../contracts/extension.js";
import type { TaskRequest } from "../contracts/task.js";

export type TaskRoute =
  | { kind: "generic"; goal: string }
  | { kind: "specialized"; capability: SpecializedTaskCapability; request: TaskRequest };

/**
 * 主路由不再包含业务匹配：扩展通过注册表提供专用能力；
 * 没有命中时始终进入通用规划、探索或 Workflow 回放。
 */
export function routeTask(goal: string, options: { admin?: boolean; desktopTarget?: import("../contracts/task-desktop.js").TaskDesktopTarget } = {},
  registry: ExtensionRegistry): TaskRoute {
  if (typeof goal !== "string" || !goal.trim() || goal.length > 4000) {
    throw new Error("任务目标为空或过长");
  }
  if (options.desktopTarget) {
    if (options.admin) throw new Error("显式桌面任务暂不支持管理员权限提升");
    return { kind: "generic", goal };
  }
  const hit = registry.resolveCapability(goal, options);
  if (hit) return { kind: "specialized", capability: hit.capability, request: hit.request };
  if (options.admin) throw new Error("通用任务暂不支持管理员权限提升");
  return { kind: "generic", goal };
}
