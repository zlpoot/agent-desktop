import { createHash } from "node:crypto";
import type { ComputerState } from "../graph/state.js";
import type { Workflow, WorkflowStep } from "./schema.js";
import { instantiateWorkflow, preconditionsMet } from "./matcher.js";
import { verifyWorkflowStep } from "./distill.js";

export interface WorkflowRecoveryDecision {
  decision: "continue" | "confirmed" | "blocked";
  reason: string;
  replay?: NonNullable<ComputerState["workflowReplayState"]>;
}
export class WorkflowRecoveryError extends Error {}

/** A field replacement may be repeated only when a complete fresh UIA snapshot
 * identifies exactly one enabled Edit and confirms its current value differs. */
function canReapplyEdit(step: WorkflowStep, state: Readonly<ComputerState>): boolean {
  const action = step.action;
  if ((action.kind !== "type" && action.kind !== "paste_text") ||
      action.target.kind !== "role" || action.target.role !== "Edit" || !action.target.name ||
      (step.successCondition.kind !== "text_includes" &&
       step.successCondition.kind !== "accessibility_includes") ||
      step.successCondition.value !== action.text ||
      !state.observation?.capture?.enumerationComplete ||
      state.observation.capture.fields.dom?.complete !== true ||
      state.observation.capture.fields.dom.source !== "uia" || !state.observation.dom) return false;
  const targetName = action.target.name;
  let controls: unknown;
  try { controls = JSON.parse(state.observation.dom); } catch { return false; }
  if (!Array.isArray(controls)) return false;
  const matches = controls.filter((item): item is Record<string, unknown> =>
    item !== null && typeof item === "object" && !Array.isArray(item) &&
    item.role === "Edit" && item.name === targetName);
  return matches.length === 1 && matches[0].nameComplete === true &&
    matches[0].valueComplete === true && matches[0].enabled === true &&
    matches[0].visible === true && typeof matches[0].value === "string" &&
    matches[0].value !== action.text;
}

/** Only execution definition participates: counters/status are mutable independently.
 *
 * v1（缺省/1）保持历史实现逐字节不变：旧库 verified Workflow 的 definitionHash 不漂移。
 * v2（=2）显式把 workflowSchemaVersion 纳入摘要，因此 v1→v2 迁移必然产生新 hash；
 * 同一定义绝不会出现 v1/v2 同 hash，杜绝「静默升级后继续冒充同一个 verified Workflow」。 */
export function workflowDigest(workflow: Workflow): string {
  if (workflow.workflowSchemaVersion === 2) {
    return createHash("sha256").update(JSON.stringify({ workflowSchemaVersion: 2,
      scope: workflow.scope ?? "task", environment: workflow.environment, inputs: workflow.inputs,
      preconditions: workflow.preconditions, steps: workflow.steps,
      successConditions: workflow.successConditions, stageCondition: workflow.stageCondition }))
      .digest("hex");
  }
  return createHash("sha256").update(JSON.stringify({ scope: workflow.scope ?? "task",
    environment: workflow.environment, inputs: workflow.inputs, preconditions: workflow.preconditions,
    steps: workflow.steps, successConditions: workflow.successConditions,
    stageCondition: workflow.stageCondition })).digest("hex");
}

export function reconcileWorkflow(state: Readonly<ComputerState>, original?: Workflow): WorkflowRecoveryDecision {
  const block = (reason: string): WorkflowRecoveryDecision => ({ decision: "blocked", reason });
  const ref = state.workflowRef;
  if (!ref || !original || original.id !== ref.id || original.version !== ref.version)
    return block("原 Workflow 版本不存在，不能改用其他版本");
  if (original.status === "retired") return block("原 Workflow 版本已撤回");
  if (!ref.definitionHash) return block("旧任务缺少流程定义摘要，需要人工确认后重新提交");
  if (ref.definitionHash !== workflowDigest(original)) return block("原 Workflow 执行定义已变化");
  if (!state.observation) return block("缺少恢复后的新观察");
  let workflow: Workflow;
  try { workflow = instantiateWorkflow({ workflow: original, values: ref.values, score: 1 }); }
  catch { return block("原 Workflow 参数不完整"); }
  if (!preconditionsMet(workflow, state.observation)) return block("Workflow 前置条件不满足");
  const replay = state.workflowReplayState;
  if (!replay || !Number.isInteger(replay.nextIndex) || replay.nextIndex < 0 || replay.nextIndex > workflow.steps.length)
    return block("缺少有效的 Workflow 恢复位置");
  if (replay.exploring) return block("流程已偏离回放，需要人工确认恢复策略");
  const active = replay.activeIndex;
  if (active !== undefined && (!Number.isInteger(active) || active < 0 || active >= workflow.steps.length || replay.nextIndex !== active + 1))
    return block("Workflow 未决步骤位置无效");
  if (state.recoveryUncertain && active === undefined) return block("无法关联未决动作与 Workflow 步骤");
  if (state.recoveryUncertain && JSON.stringify(state.inFlightAction) !== JSON.stringify(workflow.steps[active!].action))
    return block("未决动作与原 Workflow 步骤不一致");
  const evidenceIndex = active ?? replay.nextIndex - 1;
  if (evidenceIndex >= 0) {
    const step = workflow.steps[evidenceIndex];
    if (step.successCondition.kind === "state_changed" ||
        !verifyWorkflowStep(step, undefined, state.observation)) {
      if (!state.recoveryUncertain && !state.inFlightAction && active === undefined &&
          canReapplyEdit(step, state)) {
        return { decision: "continue",
          reason: "新观察确认输入框值已回退；仅重做该字段替换，再核对后续步骤",
          replay: { ...replay, nextIndex: evidenceIndex, activeIndex: undefined } };
      }
      return block("新观察不能确认恢复边界的步骤结果，请核对现场");
    }
  }
  return { decision: state.recoveryUncertain ? "confirmed" : "continue",
    reason: "原版本、参数、前置条件及恢复边界已由新观察核对",
    replay: { ...replay, activeIndex: undefined } };
}
