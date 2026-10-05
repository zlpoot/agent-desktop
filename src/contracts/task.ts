import type { CapabilityFacts, CapabilityEnvironment, CapabilityOperation } from "../capabilities/registry.js";
import type { CompletionCriteria } from "../verifier/verifier.js";

/**
 * 核心与扩展之间的任务请求协议。
 * kind 只区分“专用能力”与“通用浏览器任务”，不携带具体业务名；
 * 业务语义由扩展的 capability.id 表达。
 */
export interface TaskRequest {
  kind: "specialized" | "browser_task";
  environment: CapabilityEnvironment;
  goal: string;
  plan: string[];
  completionCriteria?: CompletionCriteria;
  facts: CapabilityFacts;
  operations: readonly CapabilityOperation[];
}

/** 通用浏览器任务的请求构造；脚本化演示与扩展都可使用。 */
export function browserTaskRequest(goal: string, plan: string[],
  completionCriteria: CompletionCriteria, deterministicIntent: boolean): TaskRequest {
  return { kind: "browser_task", environment: "browser", goal, plan, completionCriteria,
    facts: { deterministicIntent, completionCriteria: true },
    operations: ["attach", "observe", "locate", "act", "choose", "verify"] };
}
