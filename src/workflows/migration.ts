import { createHash } from "node:crypto";
import type { Workflow } from "./schema.js";

/** 为 v2 步骤生成确定性的 stepId：同一 v1 定义迁移两次得到相同 stepId。 */
function stableStepId(workflowId: string, index: number, goal: string): string {
  return `step-${index + 1}-` + createHash("sha256")
    .update(`${workflowId}\0${index}\0${goal}`).digest("hex").slice(0, 8);
}

/**
 * 显式 v1→v2 迁移（纯函数，不落库）：
 * - 入参 v1 对象原样保留，由调用方继续持有/存储旧版本；
 * - 产物 workflowSchemaVersion=2、每个 step 持久化 stepId（确定性生成）；
 * - 状态强制回到 candidate：原 verified 不继承，lastVerifiedAt 与成败计数清零，
 *   必须重新经过完整 replay 才能晋级 verified；
 * - workflowDigest(产物) 必然 ≠ workflowDigest(入参)（v2 摘要含 schemaVersion），
 *   因此新版本绝不可能冒充原 verified Workflow。
 */
export function migrateWorkflowToV2(original: Workflow): Workflow {
  if (original.workflowSchemaVersion === 2) throw new Error("流程已是 v2，无需迁移");
  return {
    ...original,
    workflowSchemaVersion: 2,
    status: "candidate",
    lastVerifiedAt: undefined,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date().toISOString(),
    steps: original.steps.map((step, index) => ({
      ...step,
      stepId: step.stepId ?? stableStepId(original.id, index, step.goal),
    })),
  };
}
