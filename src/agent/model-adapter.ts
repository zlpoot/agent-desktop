import type { ComputerAction, Observation } from "../actions/schema.js";
import type { ComputerState } from "../graph/state.js";
import type { Workflow, WorkflowMatch } from "../workflows/schema.js";

/** Only decisions come from the model. Observation and execution stay in this runtime. */
export interface TokenUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number }
export interface DecisionMetadata {
  actor: "model" | "rule";
  operator: string;
  modelName?: string;
}

export interface ModelAdapter {
  readonly name?: string;
  readonly kind?: "model" | "rule";
  decide(state: Readonly<ComputerState>): Promise<ComputerAction>;
  takeUsage?(): TokenUsage | undefined;
  takeDecisionMetadata?(): DecisionMetadata | undefined;
  matchWorkflows?(goal: string, workflows: readonly Workflow[]): Promise<{
    match?: WorkflowMatch; usage?: TokenUsage;
  }>;
  snapshotState?(): ComputerState["workflowReplayState"];
  restoreState?(state: NonNullable<ComputerState["workflowReplayState"]>): void;
  currentWorkflowRef?(): ComputerState["workflowRef"];
  planStage?(state: Readonly<ComputerState>): Promise<{
    goal: string; successCondition: string; isFinal: boolean; usage?: TokenUsage;
    verification?:import('../verification/planner-contract.js').EvidencePlan }>;
  verifyStage?(stage: NonNullable<ComputerState["stage"]>, observation: Observation): Promise<{
    ok: boolean; confidence: number; evidence: string;
    source: "uia" | "dom" | "visual_model"; usage?: TokenUsage }>;
  reconcileStage?(state: Readonly<ComputerState>): Promise<{
    decision: "continue" | "skip" | "replan"; evidence: string; usage?: TokenUsage }>;
  diagnoseStage?(state: Readonly<ComputerState>): Promise<{
    decision: "continue" | "replan"; reason: string; remedy: string; usage?: TokenUsage }>;
}

export class FakeModel implements ModelAdapter {
  readonly name = "脚本决策";
  readonly kind = "rule";
  private index = 0;
  constructor(private readonly actions: readonly ComputerAction[]) {}

  async decide(): Promise<ComputerAction> {
    const action = this.actions[this.index++];
    if (!action) throw new Error("FakeModel action script exhausted");
    return action;
  }
}
