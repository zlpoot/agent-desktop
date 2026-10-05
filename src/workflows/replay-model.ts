import type { ComputerAction } from "../actions/schema.js";
import type { DecisionMetadata, ModelAdapter, TokenUsage } from "../agent/model-adapter.js";
import type { ComputerState } from "../graph/state.js";
import { verifyGoal } from "../verifier/verifier.js";
import type { CompletionCriteria } from "../verifier/verifier.js";
import { preconditionsMet } from "./matcher.js";
import type { Workflow } from "./schema.js";
import { verifyWorkflowStep } from "./distill.js";

/** 优先回放语义动作；观察或验证偏离时立即交给 Explore 决策器。 */
export class WorkflowReplayModel implements ModelAdapter {
  readonly name: string;
  readonly kind = "rule" as const;
  private nextIndex = 0;
  private activeIndex?: number;
  private exploring = false;
  private lastMetadata?: DecisionMetadata;
  private fallbackReason?: string;

  constructor(readonly workflow: Workflow, private readonly explore: ModelAdapter,
    private readonly onFallback?: (reason: string, state: Readonly<ComputerState>,
      rejectedStep?: number) => void,
    private readonly requiredConditions?: CompletionCriteria,
    private readonly onSkip?: (step: number, state: Readonly<ComputerState>) => void,
    private readonly strict = false) {
    this.name = `Workflow ${workflow.id} v${workflow.version}`;
  }

  get mode(): "replay" | "explore" { return this.exploring ? "explore" : "replay"; }
  get reason(): string | undefined { return this.fallbackReason; }

  snapshotState() { return { nextIndex: this.nextIndex, activeIndex: this.activeIndex,
    exploring: this.exploring, fallbackReason: this.fallbackReason }; }

  restoreState(state: NonNullable<ComputerState["workflowReplayState"]>): void {
    if (this.strict && state.exploring) throw new Error('指定流程不允许恢复为自由探索模式');
    if (!Number.isInteger(state.nextIndex) || state.nextIndex < 0 ||
        state.nextIndex > this.workflow.steps.length) throw new Error("流程回放游标无效");
    this.nextIndex = state.nextIndex;
    this.activeIndex = state.activeIndex;
    this.exploring = state.exploring;
    this.fallbackReason = state.fallbackReason;
  }

  private fallback(reason: string, state: Readonly<ComputerState>, rejectedStep?: number): void {
    if (this.strict) throw new Error(`指定流程停止：${reason}；未转入自由探索`);
    if (this.exploring) return;
    this.exploring = true;
    this.fallbackReason = reason;
    this.onFallback?.(reason, state, rejectedStep);
  }

  async decide(state: Readonly<ComputerState>): Promise<ComputerAction> {
    if (!this.exploring) {
      if (!state.observation || (this.nextIndex === 0 &&
          !preconditionsMet(this.workflow, state.observation))) {
        this.fallback("流程前置条件不满足", state);
      } else if (this.activeIndex !== undefined) {
        const step = this.workflow.steps[this.activeIndex];
        if (state.lastResult?.ok === false || state.lastVerification?.ok !== true) {
          this.fallback(state.error ?? "回放动作失败", state);
        } else if (state.lastVerification?.ok && !verifyWorkflowStep(step,
          state.beforeObservation, state.observation)) {
          this.fallback(`第 ${this.activeIndex + 1} 步语义成功条件未满足`, state, state.step);
        }
        this.activeIndex = undefined;
      }
    }
    while (!this.exploring && this.nextIndex < this.workflow.steps.length &&
        this.workflow.steps[this.nextIndex].idempotent &&
        this.workflow.steps[this.nextIndex].successCondition.kind !== "state_changed" &&
        verifyWorkflowStep(this.workflow.steps[this.nextIndex], undefined, state.observation)) {
      this.onSkip?.(this.nextIndex + 1, state);
      this.nextIndex++;
    }
    if (!this.exploring && this.nextIndex < this.workflow.steps.length) {
      const index = this.nextIndex++;
      this.activeIndex = index;
      this.lastMetadata = { actor: "rule", operator: `${this.name} · 第 ${index + 1} 步` };
      const step=this.workflow.steps[index];
      const action=structuredClone(step.action);
      // The stored Workflow condition predates this dispatch. Only scoped URL evidence is strong enough here.
      if((action.kind==='click'||action.kind==='double_click'||action.kind==='keypress')&&
        !action.postcondition&&step.successCondition.kind==='url_includes')
        action.postcondition={kind:'url_includes',value:step.successCondition.value};
      return action;
    }
    // 完成判定以当次任务契约（requiredConditions）为权威；Workflow 自带成功条件
    // 只在无任务级契约时兜底（候选/阶段流程）。参数变体回放时，旧任务的验收快照
    // （如计算结果的固定值）不得否决当次任务的完成条件。
    const taskConditions = this.requiredConditions ?? this.workflow.successConditions;
    if (!this.exploring && (this.workflow.scope === "stage" ||
        verifyGoal(taskConditions, state.observation).ok)) {
      this.lastMetadata = { actor: "rule", operator: `${this.name} · 完成检查` };
      return { kind: "done", summary: "已按经验证的流程完成任务" };
    }
    if (!this.exploring) this.fallback("回放结束但任务完成条件未满足", state);
    this.lastMetadata = { actor: this.explore.kind === "rule" ? "rule" : "model",
      operator: this.explore.name ?? "Explore 决策器",
      ...(this.explore.kind !== "rule" ? { modelName: this.explore.name } : {}) };
    return this.explore.decide(state);
  }

  takeUsage(): TokenUsage | undefined { return this.exploring ? this.explore.takeUsage?.() : undefined; }

  takeDecisionMetadata(): DecisionMetadata | undefined {
    const result = this.lastMetadata;
    this.lastMetadata = undefined;
    return result;
  }
}
