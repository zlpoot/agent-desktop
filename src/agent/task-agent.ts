import { randomUUID } from "node:crypto";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { CapabilityEnvironment } from "../capabilities/registry.js";
import type { TraceStore, WorkflowStore } from "../contracts/stores.js";
import { createAgentLoop } from "../graph/graph.js";
import { initialState, type ComputerState } from "../graph/state.js";
import type { RuntimeAdapter } from "../runtime/runtime-adapter.js";
import type { CompletionCriteria } from "../verifier/verifier.js";
import { distillWorkflowV2 } from "../workflows/distill.js";
import { instantiateWorkflow, selectWorkflow } from "../workflows/matcher.js";
import { WorkflowReplayModel } from "../workflows/replay-model.js";
import type { Workflow } from "../workflows/schema.js";
import { workflowDigest } from "../workflows/recovery.js";
import type { ModelAdapter } from "./model-adapter.js";
import { isBudgetExceeded } from '../runtime/model-budget.js';
import { auditTaskContractCoverage } from '../verification/task-contract-coverage.js';

export interface TaskAgentRequest {
  taskId?: string;
  goal: string;
  environment: CapabilityEnvironment;
  completionCriteria: CompletionCriteria;
  verificationContract?: import('./task-planner.js').PlannedVerificationContract;
  contractCoverage?: import('../verification/task-contract-coverage.js').TaskContractCoverage;
  plan?: string[];
}

export interface TaskAgentResult {
  state: ComputerState;
  workflowUsed?: { id: string; version: number; statusAtSelection: Workflow["status"] };
  workflowCreated?: { id: string; version: number };
  mode: "explore" | "replay" | "replay_fallback";
}

/** 单一入口：查找流程，必要时探索；成功后生成候选，回放成功后升级为 verified。 */
export async function runTaskAgent(request: TaskAgentRequest, dependencies: {
  acceptanceVerifier?: import("../verifier/hybrid-verifier.js").AcceptanceVerifier;
  runtime: RuntimeAdapter;
  exploreModel: ModelAdapter;
  trace: TraceStore;
  tracePath: string;
  workflowStore: WorkflowStore;
  checkpointer?: BaseCheckpointSaver;
  maxSteps?: number;
  pauseRequested?: (taskId: string) => boolean;
}): Promise<TaskAgentResult> {
  const taskId = request.taskId ?? randomUUID();
  const matches = dependencies.workflowStore.list(request.environment)
    .filter((item) => item.scope !== "stage");
  const verified = selectWorkflow(matches, request.goal);
  const candidate = selectWorkflow(matches.filter((item) => item.status === "candidate"),
    request.goal, true);
  let matched = candidate && candidate.workflow.failureCount === 0 &&
    (!verified || candidate.workflow.id === verified.workflow.id &&
    candidate.workflow.version > verified.workflow.version && verified.workflow.failureCount > 0)
    ? candidate : verified;
  if (!matched && matches.length && dependencies.exploreModel.matchWorkflows) {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    let usage;
    try {
      const semantic = await dependencies.exploreModel.matchWorkflows(request.goal, matches);
      usage = semantic.usage;
      if (semantic.match?.workflow.status === "verified" ||
          semantic.match?.workflow.status === "candidate" && semantic.match.workflow.failureCount === 0) {
        matched = semantic.match;
      }
    } catch (error) {
      if (isBudgetExceeded(error)) throw error;
      dependencies.trace.save("workflow_search_error", { ...initialState(taskId, request.goal),
        summary: `语义检索不可用，转入探索：${String(error)}` });
    } finally {
      dependencies.trace.recordNodeMetric(taskId, { step: 0, node: "workflow_search",
        startedAt, durationMs: performance.now() - started, actor: "model",
        operator: "Workflow 语义检索", modelName: dependencies.exploreModel.name ?? "模型",
        ...usage });
    }
  }
  const workflow = matched ? instantiateWorkflow(matched) : undefined;
  let replay: WorkflowReplayModel | undefined;
  const model = workflow ? (replay = new WorkflowReplayModel(workflow, dependencies.exploreModel,
    (reason, state, rejectedStep) => {
      dependencies.trace.save("workflow_fallback", {
        ...state, summary: `流程 ${workflow.id} v${workflow.version} 回退探索：${reason}`,
      });
      if (rejectedStep !== undefined) dependencies.trace.save("workflow_step_rejected", {
        ...state, step: rejectedStep,
        summary: `流程 ${workflow.id} v${workflow.version} 的任务动作 ${rejectedStep} 未达到语义条件`,
      });
    }, request.completionCriteria,
    (step, state) => dependencies.trace.save("workflow_skip", { ...state,
      summary: `流程 ${workflow.id} v${workflow.version} 第 ${step} 步已满足，跳过幂等动作` })))
    : dependencies.exploreModel;
  const state = initialState(taskId, request.goal,
    workflow?.steps.map((step) => step.goal) ?? request.plan,
    request.completionCriteria);
  state.verificationContract = request.verificationContract;
  // Workflow selection happens here, after the window planner. Freeze its declared
  // file results before replay starts so a reusable file workflow keeps its proof.
  const declaredFiles=workflow?.steps.flatMap(step=>
    'postcondition' in step.action && step.action.postcondition?.kind==='desktop_file'
      ?[step.action.postcondition.path]:[])??[];
  state.contractCoverage=workflow
    ?auditTaskContractCoverage(request.goal,request.completionCriteria,declaredFiles)
    :request.contractCoverage??auditTaskContractCoverage(request.goal,request.completionCriteria);
  dependencies.trace.save('contract_preflight',{...state,
    summary:state.contractCoverage.covered?'选定流程后的完成契约覆盖审计通过':
      `选定流程后的完成契约需人工结果验收：${state.contractCoverage.reason}`});
  if (matched) state.workflowRef = { id: matched.workflow.id,
    version: matched.workflow.version, values: matched.values, definitionHash: workflowDigest(matched.workflow) };
  dependencies.trace.save("workflow_search", { ...state, summary: workflow
    ? `找到流程 ${workflow.id} v${workflow.version}，准备回放` : "没有匹配流程，进入探索" });
  const result = await createAgentLoop({ acceptanceVerifier: dependencies.acceptanceVerifier, model, runtime: dependencies.runtime,
    trace: dependencies.trace, checkpointer: dependencies.checkpointer,
    maxSteps: dependencies.maxSteps ?? 24, maxRetries: 2,
    pauseRequested: dependencies.pauseRequested })
    .invoke(state, { configurable: { thread_id: taskId } }) as ComputerState;
  if (workflow && (result.status === "done" || result.status === "failed")) {
    dependencies.workflowStore.recordReplay(workflow.id, workflow.version, taskId,
      result.status === "done" && replay?.mode === "replay", replay?.reason ?? result.error);
  }
  let created: Workflow | undefined;
  if (result.status === "done" && (!workflow || replay?.mode === "explore")) {
    const proposed = distillWorkflowV2(dependencies.trace, taskId, dependencies.tracePath, request.environment);
    if (proposed) created = dependencies.workflowStore.addCandidate(proposed);
  }
  return { state: result,
    ...(workflow ? { workflowUsed: { id: workflow.id, version: workflow.version,
      statusAtSelection: workflow.status } } : {}),
    ...(created ? { workflowCreated: { id: created.id, version: created.version } } : {}),
    mode: workflow ? replay?.mode === "explore" ? "replay_fallback" : "replay" : "explore" };
}
