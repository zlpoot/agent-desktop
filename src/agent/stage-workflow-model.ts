import type { ComputerAction } from "../actions/schema.js";
import type { ComputerState } from "../graph/state.js";
import type { CapabilityEnvironment } from "../capabilities/registry.js";
import type { WorkflowStore } from "../contracts/stores.js";
import { instantiateWorkflow, selectWorkflow } from "../workflows/matcher.js";
import { WorkflowReplayModel } from "../workflows/replay-model.js";
import { workflowDigest, WorkflowRecoveryError } from "../workflows/recovery.js";
import type { ModelAdapter, TokenUsage } from "./model-adapter.js";

/** 阶段目标确定后才检索流程；阶段切换和恢复时重新构造回放器。 */
export class StageWorkflowModel implements ModelAdapter {
  readonly name: string;
  readonly kind = "model" as const;
  private stageId?: string;
  private replay?: WorkflowReplayModel;
  private ref?: ComputerState["workflowRef"];
  private forceExplore = false;
  private auxiliaryUsage?: TokenUsage;

  constructor(private readonly explore: ModelAdapter, private readonly store: WorkflowStore,
    private readonly onFallback?: (reason: string, state: Readonly<ComputerState>) => void,
    private readonly environment: CapabilityEnvironment = "windows",
    private readonly legacyPolicy?: { allowedActions?: ComputerAction["kind"][];
      requireTargetedScroll?: boolean }) {
    this.name = explore.name ?? "阶段探索";
  }

  private select(state: Readonly<ComputerState>): void {
    if (!state.stage) throw new Error("缺少当前阶段");
    if (this.stageId === state.stage.id) return;
    this.replay = undefined;
    this.ref = undefined;
    this.forceExplore = false;
    const workflows = this.store.list(this.environment).filter((item) => item.scope === "stage" &&
      item.failureCount === 0);
    const pinned = state.workflowRef?.stageId === state.stage.id ? state.workflowRef : undefined;
    const saved = pinned ? this.store.get(pinned.id, pinned.version) : undefined;
    if (pinned && (!saved || saved.status === "retired" ||
        pinned.definitionHash && pinned.definitionHash !== workflowDigest(saved)))
      throw new WorkflowRecoveryError("原阶段 Workflow 版本缺失、撤回或定义变化，不能重新匹配");
    this.stageId = state.stage.id;
    const match = saved
      ? { workflow: saved, values: state.workflowRef!.values, score: 1 }
      : selectWorkflow(workflows, state.stage.goal, true, true) ??
        // A first and final stage may paraphrase the user's task. Use the frozen
        // original target as a second exact template source, not model similarity.
        (state.stage.isFinal && state.stage.startedAtStep === 0 && state.taskContract?.target
          ? selectWorkflow(workflows, state.taskContract.target, true, true) : undefined);
    if (!match) return;
    this.replay = new WorkflowReplayModel(instantiateWorkflow(match), this.explore,
      (reason, current) => this.onFallback?.(reason, current));
    if (saved && state.workflowReplayState) {
      this.replay.restoreState(state.workflowReplayState);
      this.forceExplore = state.workflowReplayState.exploring;
    }
    // 诊断后的策略优先于旧流程；服务重启时也保持探索模式。
    if (state.diagnosis) this.forceExplore = true;
    this.ref = { id: match.workflow.id, version: match.workflow.version,
      values: match.values, stageId: state.stage.id, definitionHash: workflowDigest(match.workflow) };
  }

  async decide(state: Readonly<ComputerState>): Promise<ComputerAction> {
    this.select(state);
    if (state.lastAction?.kind === "done" && state.lastStageVerification?.ok === false) {
      this.forceExplore = true;
    }
    const action = await (this.replay && !this.forceExplore
      ? this.replay.decide(state) : this.explore.decide(state));
    const allowed = state.taskContract?.allowedActions ?? this.legacyPolicy?.allowedActions;
    if (allowed && !allowed.includes(action.kind)) {
      throw new Error(`当前任务契约不允许 ${action.kind} 动作`);
    }
    if (action.kind === "scroll" &&
        (state.taskContract?.requireTargetedScroll ?? this.legacyPolicy?.requireTargetedScroll) &&
        !action.target) {
      throw new Error("当前任务要求为滚动指定可见目标区域");
    }
    return action;
  }

  currentWorkflowRef() { return this.ref; }
  snapshotState() {
    if (!this.replay) return undefined;
    return { ...this.replay.snapshotState(), exploring: this.forceExplore || this.replay.mode === "explore" };
  }
  restoreState(state: NonNullable<ComputerState["workflowReplayState"]>): void {
    this.replay?.restoreState(state);
    this.forceExplore = state.exploring;
  }
  takeUsage() {
    if (this.auxiliaryUsage) {
      const usage = this.auxiliaryUsage;
      this.auxiliaryUsage = undefined;
      this.explore.takeUsage?.();
      return usage;
    }
    return this.replay && !this.forceExplore
    ? this.replay.takeUsage() : this.explore.takeUsage?.(); }
  takeDecisionMetadata() { return this.replay && !this.forceExplore
    ? this.replay.takeDecisionMetadata() : this.explore.takeDecisionMetadata?.(); }
  async planStage(state: Readonly<ComputerState>) {
    if (!this.explore.planStage) throw new Error("探索模型不支持阶段规划");
    const result = await this.explore.planStage(state);
    this.auxiliaryUsage = result.usage;
    return result;
  }
  async verifyStage(stage: NonNullable<ComputerState["stage"]>,
    observation: NonNullable<ComputerState["observation"]>) {
    if (!this.explore.verifyStage) throw new Error("探索模型不支持阶段验收");
    const result = await this.explore.verifyStage(stage, observation);
    this.auxiliaryUsage = result.usage;
    return result;
  }
  async reconcileStage(state: Readonly<ComputerState>) {
    // The graph already reobserved and verified the stage. A model without an
    // optional reconciliation hook may continue the unfinished stage; it must
    // never infer that the stage was completed or skip an unknown action.
    if (!this.explore.reconcileStage) return { decision: "continue" as const,
      evidence: "新观察未证实当前阶段完成；继续从已核实的阶段边界决策" };
    const result = await this.explore.reconcileStage(state);
    this.auxiliaryUsage = result.usage;
    return result;
  }
  async diagnoseStage(state: Readonly<ComputerState>) {
    if (!this.explore.diagnoseStage) throw new Error("探索模型不支持阶段诊断");
    this.forceExplore = true;
    const result = await this.explore.diagnoseStage(state);
    const prior = this.auxiliaryUsage;
    this.auxiliaryUsage = { inputTokens: (prior?.inputTokens ?? 0) + (result.usage?.inputTokens ?? 0),
      outputTokens: (prior?.outputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
      totalTokens: (prior?.totalTokens ?? 0) + (result.usage?.totalTokens ?? 0) };
    return result;
  }
}
