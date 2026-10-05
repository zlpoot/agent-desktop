import type { ActionResolution } from "../actions/action-resolution.js";
import type { GroundingAttempt } from "../actions/schema.js";
import type { CapabilityFacts, CapabilityResolution } from "../capabilities/registry.js";
import type { ComputerState } from "../graph/state.js";
import type { NodeMetric } from "../trace/sqlite-trace.js";
import type { Workflow } from "../workflows/schema.js";

/**
 * 核心所需的最小轨迹存储面。SqliteTrace 结构性满足该接口；
 * 契约只固化核心实际消费的方法，避免绑定具体数据库。
 */
export interface TraceStore {
  save(node: string, state: ComputerState): void;
  load(taskId: string): ComputerState | undefined;
  requestPause(taskId: string): void;
  pauseRequested(taskId: string): boolean;
  clearPause(taskId: string): void;
  recordNodeMetric(taskId: string, metric: NodeMetric): void;
  recordGrounding(taskId: string, step: number, attempts: readonly GroundingAttempt[]): void;
  recordGroundingExecution(taskId: string, step: number, ok: boolean): void;
  recordCapabilityResolution(taskId: string, step: number, phase: string,
    resolution: CapabilityResolution, facts: CapabilityFacts): void;
  recordActionResolution(taskId: string, step: number, resolution: ActionResolution): void;
  recordActionExecution(taskId: string, step: number, actual: string | undefined,
    ok: boolean, note: string): void;
  recordProviderAttempt(taskId: string, step: number, provider: string, ok: boolean,
    effect: "none" | "uncertain" | "dispatched", message: string): void;
  events(taskId: string): Array<{ step: number; node: string; state: ComputerState }>;
  metrics(taskId: string): NodeMetric[];
  unfinishedDesktopTasks(): ComputerState[];
  close(): void;
}

/** 核心所需的 Workflow 存储面；WorkflowStore 结构性满足。 */
export interface WorkflowStore {
  list(environment?: Workflow["environment"]): Workflow[];
  get(id: string, version: number): Workflow | undefined;
  addCandidate(proposed: Workflow): Workflow;
  recordReplay(id: string, version: number, taskId: string, success: boolean,
    reason?: string, expectedDefinitionHash?: string,
    promotion?: "automatic" | "record_only", stageId?: string): Workflow;
  publish(id: string, version: number, expectedDefinitionHash: string,
    expectedSuccessCount: number, expectedFailureCount: number): Workflow;
  migrateSemanticTargets(): { scanned: number; updated: number; steps: number };
  close(): void;
}
