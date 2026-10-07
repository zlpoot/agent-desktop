import type { TaskDesktopFields } from '../contracts/task-desktop.js';
import type { ActionResult, ComputerAction, GroundingStrategy, Observation } from "../actions/schema.js";
import type { ActionResolution } from "../actions/action-resolution.js";
import type { TargetBinding } from "../actions/semantic-target.js";
import type { CompletionCriteria, VerificationResult } from "../verifier/verifier.js";

export interface ComputerState extends TaskDesktopFields {
  taskId: string;
  goal: string;
  plan?: string[];
  completionCriteria?: CompletionCriteria;
  /** Frozen before any action; legacy checkpoints may not contain this field. */
  verificationContract?: import('../agent/task-planner.js').PlannedVerificationContract;
  /** Original goal vs planned result proof, frozen before the first action. */
  contractCoverage?: import('../verification/task-contract-coverage.js').TaskContractCoverage;
  observation?: Observation;
  /** Frozen from the first task observation before any action. */
  baselineChecks?: import('../verifier/hybrid-verifier.js').AcceptanceReport['checks'];
  desktopBinding?: { windowHandle: number; windowClass: string; processPath?: string; processId: number };
  setupPaused?: boolean;
  desktopVmId?: string;
  recoveryRequired?: boolean;
  recoveryUncertain?: boolean;
  checkpointThreadId?: string;
  /** Durable links between execution threads created by process recovery. */
  checkpointLineage?: Array<{ from: string; to: string; at: string }>;
  inFlightAction?: ComputerAction;
  beforeObservation?: Observation;
  observationFailed?: boolean;
  verificationPending?: boolean;
  shadowContract?:import('../verification/host-shadow.js').FrozenShadowContract;
  beforeFile?:import('../verification/file-evidence.js').DesktopFileSnapshot;
  verifiedFiles?:import('../verification/file-evidence.js').VerifiedDesktopFile[];
  /** Desktop file results deterministically frozen from the original goal before any action. */
  taskRequiredFiles?:import('../verification/file-evidence.js').DesktopFileExpectation[];
  /** Pre-dispatch read-only snapshots of frozen files, keyed by lower-cased relative path. */
  taskBeforeFiles?:Record<string,import('../verification/file-evidence.js').DesktopFileSnapshot|undefined>;
  /** Frozen goal files created/changed by a task action but whose content contradicts the goal. */
  taskFileContradictions?:Array<{path:string;step:number;reason:string}>;
  /** 可编辑字段 rebind 持久化门的跨观察链状态，键为 structuredStates 下标。 */
  rebindState?:import('../verification/structured-rebind.js').RebindStateMap;
  /** 终态重投影值与期望矛盾（应用拒绝保存）：确定性 FAIL，区别于证据不足。 */
  structuredRebindContradiction?:boolean;
  stageEvidenceContract?:import('../verification/planner-contract.js').StageEvidenceContract;
  stageEvidenceBoundary?:Observation['capture'];
  lastAction?: ComputerAction;
  groundedAction?: ComputerAction;
  targetBinding?: TargetBinding;
  actionResolution?: ActionResolution;
  groundingStrategy?: GroundingStrategy;
  lastResult?: ActionResult;
  lastVerification?: VerificationResult;
  recentHistory?: Array<{ step: number; action: ComputerAction;
    result?: { ok: boolean; message: string }; verification?: VerificationResult }>;
  goalVerification?: VerificationResult;
  acceptanceReport?: import('../verifier/hybrid-verifier.js').AcceptanceReport;
  humanReview?: { approved: boolean; note: string; reviewedAt: string; observationId: string };
  executedImpactActions?: string[];
  approvedActionFingerprint?: string;
  approvalContextUrl?: string;
  approvalContextSignature?: string;
  resumePendingAction?: boolean;
  userAnswer?: string;
  step: number;
  retryCount: number;
  focusRecoveryCount?: number;
  status: "running" | "pause_requested" | "paused" | "waiting_user" | "done" | "failed" | "stopped";
  /** 滚动规划的当前阶段与已完成阶段，随 LangGraph checkpoint 持久化。 */
  stage?: { id: string; goal: string; successCondition: string; startedAtStep: number;
    actionCount: number; planVersion: number; isFinal: boolean };
  completedStages?: Array<{ id: string; goal: string; successCondition: string;
    startStep: number; endStep: number; evidence: string; source: "uia" | "dom" | "visual_model" | "jev" | "manual";
    workflowId?: string; workflowVersion?: number }>;
  stagePlanVersion?: number;
  stageReplans?: number;
  diagnosisCount?: number;
  diagnosisAtActionCount?: number;
  diagnosis?: { reason: string; remedy: string; decision: "continue" | "replan"; step: number };
  taskContract?: { target: string; stageActionLimit: number; taskActionLimit: number;
    constraint: string;
    profileId?: string; environment?: "browser" | "windows";
    allowedActions?: ComputerAction["kind"][]; requireTargetedScroll?: boolean;
    windowIdentity?: { title: string; windowClass: string; processPath?: string } };
  finalReviewPending?: boolean;
  lastStageVerification?: { ok: boolean; confidence: number; evidence: string;
    source: "uia" | "dom" | "visual_model" | "jev" };
  stageVisualCandidate?: { stageId: string; evidence: string; screenshotHash?: string };
  stageCheckNeedsObserve?: boolean;
  resumeReconcile?: boolean;
  workflowRef?: { id: string; version: number; values: Record<string, string | number | boolean>; stageId?: string; definitionHash?: string; explicit?: boolean; trial?: boolean;
    requiredFiles?:import('../verification/file-evidence.js').DesktopFileExpectation[] };
  workflowReplayState?: { nextIndex: number; activeIndex?: number; exploring: boolean;
    fallbackReason?: string };
  /** 专用任务的执行器身份（capability.id）；恢复时按身份路由，不按目标文本重新匹配。 */
  executorId?: string;
  summary?: string;
  error?: string;
}

export function initialState(
  taskId: string, goal: string, plan?: string[], completionCriteria?: CompletionCriteria,
): ComputerState {
  return { taskId, goal, plan, completionCriteria, executedImpactActions: [], recentHistory: [],
    step: 0, retryCount: 0, status: "running" };
}
