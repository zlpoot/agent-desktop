import { Annotation, Command, END, START, StateGraph, interrupt, type BaseCheckpointSaver } from "@langchain/langgraph";
import { createHash } from "node:crypto";
import type { ComputerAction, Observation, Target } from "../actions/schema.js";
import { singleProvider } from "../actions/action-resolution.js";
import { bindTarget } from "../actions/semantic-target.js";
import type { ModelAdapter } from "../agent/model-adapter.js";
import type { TraceStore } from "../contracts/stores.js";
import type { NodeMetric } from "../trace/sqlite-trace.js";
import type { RuntimeAdapter } from "../runtime/runtime-adapter.js";
import { applyAcceptance, deterministicChecks, type AcceptanceVerifier } from "../verifier/hybrid-verifier.js";
import { isReadonlyBrowserContract, readonlyBrowserAcceptance } from '../verifier/readonly-browser-verifier.js';
import { verifyAction, verifyGoal } from "../verifier/verifier.js";
import type { ObservationFacetProvider } from "../contracts/facets.js";
import type { DomainEvaluator } from "../verification/domain-evaluator.js";
import { collectFacets } from "../verification/facet-binding.js";
import {freezeShadowContract,shadowObservation,type HostShadowRecord} from '../verification/host-shadow.js';
import {actionEvidenceInput} from '../verification/action-evidence.js';
import {fileEvidenceInput,currentFileEvidence,type DesktopFileSnapshot,
  type VerifiedDesktopFile} from '../verification/file-evidence.js';
import {taskEvidenceInput,type TaskFileEvidence} from '../verification/task-evidence.js';
import {auditGoalFileCoverage} from '../verification/goal-file-coverage.js';
import {desktopFileExpectationsFromGoal} from '../verification/goal-file-coverage.js';
import {freezeStageEvidence,stageEvidenceInput} from '../verification/planner-contract.js';
import {VerificationEngine} from '../verification/engine.js';
import {captureRebindBaseline,ingestRebindObservation,evaluateRebindTask,
  hasRebindCondition,rebindConditionIndexes,type RebindStateMap} from '../verification/structured-rebind.js';
import type {VerificationInput,VerificationReport} from '../verification/contracts.js';
import type { ComputerState } from "./state.js";
import { TargetWindowLostError, WorkerConnectionError } from "../contracts/worker-error.js";
import { WorkflowRecoveryError, type WorkflowRecoveryDecision } from "../workflows/recovery.js";
import { currentBudgetStopReason, isBudgetExceeded } from '../runtime/model-budget.js';
import { remapTarget, type MatchedBy, type RemapAlternative } from "../workflows/target-remap.js";

/**
 * P9-A4｜通用语义目标重映射（replay 语义漂移，纯函数，0 模型调用）。
 * 有 workflow 参数值上下文且动作为点击时，用「本次参数值 + 最近观察的 structured items」
 * 尝试把冻结的 target name 重映射到唯一高置信候选；无参数上下文/拒绝/非点击 → undefined
 * （走原 runtime.ground）。多候选或置信不足一律拒绝，禁止 silent fuzzy click。
 */
function trySemanticRemap(state: ComputerState, action: ComputerAction):
  { target: Target; matchedBy: MatchedBy;
    score: number; alternatives: RemapAlternative[] } | undefined {
  const values = state.workflowRef?.values;
  if (!values || !Object.keys(values).length) return undefined; // 探索/无参数上下文不启用
  if (action.kind !== "click" && action.kind !== "double_click") return undefined;
  const spec = action.target;
  if (!spec || spec.kind === "candidates" || spec.kind === "selector" ||
      spec.kind === "vision" || spec.kind === "coordinate") return undefined;
  const items = state.observation?.structured?.items ?? state.beforeObservation?.structured?.items;
  if (!items?.length) return undefined;
  const inputTokens = Object.values(values)
    .filter((value): value is string => typeof value === "string" && value.trim().length >= 1);
  if (!inputTokens.length) return undefined;
  const verdict = remapTarget({ spec, inputTokens, candidates: items, hrefFeatures: [] });
  if (!verdict.matched || !verdict.target) return undefined;
  return { target: verdict.target, matchedBy: verdict.matchedBy!, score: verdict.score!,
    alternatives: verdict.alternatives };
}

/** Frozen goal-file expectations this task has not yet produced deterministic proof for. */
function unprovenGoalFileExpectations(state: ComputerState) {
  const frozen = state.taskRequiredFiles ?? desktopFileExpectationsFromGoal(state.goal);
  const proven = new Set((state.verifiedFiles ?? []).map(item => item.expected.path.toLowerCase()));
  return frozen.filter(expected => !proven.has(expected.path.toLowerCase()));
}

const State = Annotation.Root({
  taskId: Annotation<string>(),
  appOnboarding: Annotation<ComputerState['appOnboarding']>(),
  desktopScenario: Annotation<ComputerState['desktopScenario']>({ reducer: (previous, next) => {
    if (previous !== undefined && previous !== next) throw new Error('immutable-task-desktopScenario');
    return next;
  } }),
  taskBindingVersion: Annotation<ComputerState["taskBindingVersion"]>({ reducer: (previous, next) => {
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(next)) {
      throw new Error('immutable-task-taskBindingVersion');
    }
    return next;
  } }),
  desktopTarget: Annotation<ComputerState["desktopTarget"]>({ reducer: (previous, next) => {
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(next)) {
      throw new Error('immutable-task-desktopTarget');
    }
    return next;
  } }),
  desktopExecutionBinding: Annotation<ComputerState["desktopExecutionBinding"]>({ reducer: (previous, next) => {
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(next)) {
      throw new Error('immutable-task-desktopExecutionBinding');
    }
    return next;
  } }),
  desktopCompatibility: Annotation<ComputerState["desktopCompatibility"]>({ reducer: (previous, next) => {
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(next)) {
      throw new Error('immutable-task-desktopCompatibility');
    }
    return next;
  } }),
  desktopVmId: Annotation<ComputerState["desktopVmId"]>(),
  recoveryRequired: Annotation<ComputerState["recoveryRequired"]>(),
  recoveryUncertain: Annotation<ComputerState["recoveryUncertain"]>(),
  checkpointThreadId: Annotation<ComputerState["checkpointThreadId"]>(),
  checkpointLineage: Annotation<ComputerState["checkpointLineage"]>(),
  inFlightAction: Annotation<ComputerState["inFlightAction"]>(),
  goal: Annotation<string>(),
  plan: Annotation<ComputerState["plan"]>(),
  completionCriteria: Annotation<ComputerState["completionCriteria"]>(),
  verificationContract: Annotation<ComputerState["verificationContract"]>(),
  contractCoverage: Annotation<ComputerState["contractCoverage"]>(),
  observation: Annotation<ComputerState["observation"]>(),
  baselineChecks: Annotation<ComputerState["baselineChecks"]>(),
  beforeObservation: Annotation<ComputerState["beforeObservation"]>(),
  observationFailed: Annotation<ComputerState["observationFailed"]>(),
  verificationPending: Annotation<ComputerState["verificationPending"]>(),
  shadowContract: Annotation<ComputerState['shadowContract']>(),
  beforeFile: Annotation<ComputerState['beforeFile']>(),
  verifiedFiles: Annotation<ComputerState['verifiedFiles']>(),
  taskRequiredFiles: Annotation<ComputerState['taskRequiredFiles']>(),
  taskBeforeFiles: Annotation<ComputerState['taskBeforeFiles']>(),
  taskFileContradictions: Annotation<ComputerState['taskFileContradictions']>(),
  rebindState: Annotation<ComputerState['rebindState']>(),
  structuredRebindContradiction: Annotation<ComputerState['structuredRebindContradiction']>(),
  stageEvidenceContract: Annotation<ComputerState['stageEvidenceContract']>(),
  stageEvidenceBoundary: Annotation<ComputerState['stageEvidenceBoundary']>(),
  lastAction: Annotation<ComputerState["lastAction"]>(),
  groundedAction: Annotation<ComputerState["groundedAction"]>(),
  targetBinding: Annotation<ComputerState["targetBinding"]>(),
  actionResolution: Annotation<ComputerState["actionResolution"]>(),
  groundingStrategy: Annotation<ComputerState["groundingStrategy"]>(),
  lastResult: Annotation<ComputerState["lastResult"]>(),
  lastVerification: Annotation<ComputerState["lastVerification"]>(),
  recentHistory: Annotation<ComputerState["recentHistory"]>(),
  acceptanceReport: Annotation<ComputerState["acceptanceReport"]>(),
  goalVerification: Annotation<ComputerState["goalVerification"]>(),
  humanReview: Annotation<ComputerState["humanReview"]>(),
  executedImpactActions: Annotation<ComputerState["executedImpactActions"]>(),
  approvedActionFingerprint: Annotation<ComputerState["approvedActionFingerprint"]>(),
  approvalContextUrl: Annotation<ComputerState["approvalContextUrl"]>(),
  approvalContextSignature: Annotation<ComputerState["approvalContextSignature"]>(),
  resumePendingAction: Annotation<ComputerState["resumePendingAction"]>(),
  userAnswer: Annotation<ComputerState["userAnswer"]>(),
  step: Annotation<number>(),
  retryCount: Annotation<number>(),
  status: Annotation<ComputerState["status"]>(),
  summary: Annotation<string | undefined>(),
  error: Annotation<string | undefined>(),
  stage: Annotation<ComputerState["stage"]>(),
  completedStages: Annotation<ComputerState["completedStages"]>(),
  stagePlanVersion: Annotation<ComputerState["stagePlanVersion"]>(),
  stageReplans: Annotation<ComputerState["stageReplans"]>(),
  diagnosisCount: Annotation<ComputerState["diagnosisCount"]>(),
  diagnosisAtActionCount: Annotation<ComputerState["diagnosisAtActionCount"]>(),
  diagnosis: Annotation<ComputerState["diagnosis"]>(),
  taskContract: Annotation<ComputerState["taskContract"]>(),
  finalReviewPending: Annotation<ComputerState["finalReviewPending"]>(),
  lastStageVerification: Annotation<ComputerState["lastStageVerification"]>(),
  stageVisualCandidate: Annotation<ComputerState["stageVisualCandidate"]>(),
  stageCheckNeedsObserve: Annotation<ComputerState["stageCheckNeedsObserve"]>(),
  resumeReconcile: Annotation<ComputerState["resumeReconcile"]>(),
  desktopBinding: Annotation<ComputerState["desktopBinding"]>(),
  workflowRef: Annotation<ComputerState["workflowRef"]>(),
  workflowReplayState: Annotation<ComputerState["workflowReplayState"]>(),
  executorId: Annotation<ComputerState["executorId"]>(),
  focusRecoveryCount: Annotation<ComputerState["focusRecoveryCount"]>(),
});

export interface AgentLoopOptions {
  shadowSink?: (record:HostShadowRecord)=>void;
  shadowVerify?: (input:VerificationInput)=>Promise<VerificationReport>;
  acceptanceVerifier?: AcceptanceVerifier;
  model: ModelAdapter;
  runtime: RuntimeAdapter;
  trace: TraceStore;
  maxSteps?: number;
  maxRetries?: number;
  recoveryJournal?: boolean;
  workflowRecovery?: (state: Readonly<ComputerState>) => WorkflowRecoveryDecision;
  checkpointer?: BaseCheckpointSaver;
  pauseRequested?: (taskId: string) => boolean;
  /** 扩展注册的 facet provider；观察后由核心统一采集并盖章到 observation.facets。 */
  facetProviders?: ObservationFacetProvider[];
  /** 域条件求值器；verifyGoal/deterministicChecks 处理 domainChecks 时使用。 */
  domainEvaluator?: DomainEvaluator;
  onStageCompleted?: (state: ComputerState,
    stage: NonNullable<ComputerState["completedStages"]>[number]) => Promise<{
      workflowId?: string; workflowVersion?: number } | void>;
}

const risky = /\b(pay|purchase|buy|delete|remove|send|submit|checkout|transfer)\b|支付|购买|下单|删除|发送|提交|转账/i;

function actionIsRisky(action: ComputerAction): boolean {
  if (action.kind === "click" || action.kind === "double_click") {
    // 导航语义：点击 link 仅打开新页面，无状态修改副作用（购买/删除等交易动作
    // 必然发生在 button/checkbox/form 控件上）。真实站点商品链接文本常含
    // 销量描述（如「下单100+人」「800+人付款」），按文本判风险会误伤只读导航。
    const target = action.target;
    if (target.kind === "role" && target.role === "link") return false;
    return risky.test(JSON.stringify(action.target));
  }
  if (action.kind === "drag") return risky.test(JSON.stringify(action.destination));
  return false;
}

function impactFingerprint(action: ComputerAction): string | undefined {
  return action.kind === "click" || action.kind === "double_click" ||
    action.kind === "drag" ||
    (action.kind === "keypress" && /^(enter|return)$/i.test(action.keys))
    ? JSON.stringify(action) : undefined;
}

function observationSignature(observation: ComputerState["observation"]): string | undefined {
  if (!observation) return undefined;
  return createHash("sha256").update(JSON.stringify({ url: observation.url,
    dom: observation.dom, accessibility: observation.accessibility })).digest("hex");
}

function focusLost(state: ComputerState): boolean {
  return /目标窗口.*前台|目标窗口前台|window.*foreground/i.test(state.error ?? "");
}

export function createAgentLoop({ shadowSink, shadowVerify, acceptanceVerifier, model, runtime, trace, maxSteps = 20, maxRetries = 2,
  checkpointer, pauseRequested, onStageCompleted, workflowRecovery, recoveryJournal = false,
  facetProviders, domainEvaluator }: AgentLoopOptions) {
  /**
   * 观察后统一采集扩展 facet：核心负责证据信封盖章，provider 只能在当次页面/窗口读取。
   * 无 provider 或无 readDom 时退化为原始观察；桌面 provider 直接消费当次 UIA/窗口通用证据。
   */
  async function observeWithFacets(): Promise<Observation> {
    const observation = await runtime.observe();
    if (!facetProviders?.length) return observation;
    return collectFacets(observation, facetProviders,
      runtime.readDom ? (request) => runtime.readDom!(request) : undefined);
  }

  function shadow(record:HostShadowRecord) {try {shadowSink?.(structuredClone(record));} catch { /* Shadow storage cannot change task decisions. */ }}
  function history(state: ComputerState, verification?: ComputerState["lastVerification"]) {
    if (!state.lastAction || state.lastAction.kind === "done" || state.lastAction.kind === "ask_user") {
      return state.recentHistory ?? [];
    }
    const prior = state.recentHistory ?? [];
    if (prior.at(-1)?.step === state.step) return prior;
    return [...prior, { step: state.step, action: state.lastAction,
      ...(state.lastResult ? { result: { ok: state.lastResult.ok, message: state.lastResult.message } } : {}),
      ...(verification ? { verification } : {}) }].slice(-8);
  }
  function save(node: string, state: ComputerState, update: Partial<ComputerState>): Partial<ComputerState> {
    trace.save(node, { ...state, ...update });
    return update;
  }

  function timed<T>(node: string, actor: NodeMetric["actor"], operator: string,
    handler: (state: ComputerState) => Promise<T>): (state: ComputerState) => Promise<T> {
    return async (state) => {
      const startedAt = new Date().toISOString();
      const start = performance.now();
      let outcome: T | undefined;
      try { outcome = await handler(state); return outcome; }
      finally {
        const usage = ["decide", "stage_plan", "stage_check"].includes(node)
          ? model.takeUsage?.() : undefined;
        const decision = node === "decide" ? model.takeDecisionMetadata?.() : undefined;
        const runtimeMetric = node === "observe" || node === "ground"
          ? runtime.takeOperationMetric?.() : undefined;
        const actualActor = decision?.actor ?? runtimeMetric?.actor ?? actor;
        const executed = node === "execute" && outcome && typeof outcome === "object"
          ? (outcome as Partial<ComputerState>).lastResult : undefined;
        trace.recordNodeMetric(state.taskId, { step: node === "decide" ? state.step + 1 : state.step,
          node, startedAt, durationMs: Math.max(0, performance.now() - start),
          actor: actualActor, operator: executed?.provider ?? decision?.operator ?? runtimeMetric?.operator ?? operator,
          ...(actualActor === "model" ? { modelName: decision?.modelName ?? runtimeMetric?.modelName ?? model.name } : {}),
          ...usage, ...runtimeMetric });
      }
    };
  }

  async function acceptance(state: ComputerState, scope: 'task' | 'stage') {
    const readonlyBrowser = !acceptanceVerifier && scope==='task'
      && isReadonlyBrowserContract(state.goal,state.verificationContract);
    if (!acceptanceVerifier && !readonlyBrowser) return undefined;
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const goal = scope === 'stage' ? `${state.stage!.goal}\n成功条件：${state.stage!.successCondition}` : state.goal;
    const report = readonlyBrowser
      ? readonlyBrowserAcceptance(goal,state.completionCriteria,state.observation,state.verificationContract!)
      : await acceptanceVerifier!.evaluate(goal, state.completionCriteria, state.observation,
      scope,scope==='task'?state.verificationContract:undefined,
      scope==='task'?state.baselineChecks:undefined);
    trace.save(`acceptance_${scope}`, {...state, acceptanceReport: report});
    trace.recordNodeMetric(state.taskId, {step:state.step, node:`acceptance_${scope}`, startedAt,
      durationMs:performance.now()-start, actor:report.auxiliary ? 'model' : 'system',
      operator:'规范化证据验收', ...(report.auxiliary ? {modelName:'jev', ...report.auxiliary.usage} : {})});
    return report;
  }
  async function complete(state: ComputerState) {
    const frozenCoverage=state.contractCoverage;
    if(frozenCoverage && !frozenCoverage.covered) {
      const message=`执行前完成契约缺少原始目标所需的结果证明：${frozenCoverage.reason}`;
      const report:import('../verifier/hybrid-verifier.js').AcceptanceReport={mode:'assist',verdict:'unknown',
        observationId:observationSignature(state.observation)??'',
        checks:[{criterion:'frozen_goal_coverage',verdict:'unknown',reason:'unsupported_condition',message}],
        reason:'unsupported_condition',message};
      trace.save('acceptance_task',{...state,acceptanceReport:report});
      return {result:{ok:false,message},report};
    }
    // Deterministic file results are accepted for both an explicitly pinned
    // Workflow and a generic (exploratory) task whose original goal freezes
    // concrete Desktop file names/content. Missing proof blocks as unknown; it
    // never lets window-only evidence pass.
    const exactFileContract=state.workflowRef?.explicit===true&&
      state.workflowReplayState?.exploring===false&&
      !!state.workflowRef.requiredFiles?.length;
    const genericFileRequirements=exactFileContract?[]:
      (state.taskRequiredFiles??desktopFileExpectationsFromGoal(state.goal));
    const deterministicFileRequirements=exactFileContract
      ?(state.workflowRef?.requiredFiles??[]):genericFileRequirements;
    const useFileGate=exactFileContract||genericFileRequirements.length>0;
    // Frozen goal files are themselves declared verifiable contracts (values come
    // from the original goal); union any action-level proved file (model-declared
    // desktop_file postcondition) so that evidence channel still declares coverage.
    // Missing PROOF is handled downstream (unknown), an attributable contradiction
    // becomes fail.
    const coverage=auditGoalFileCoverage(state.goal,
      [...new Set([...deterministicFileRequirements.map(file=>file.path),
        ...(state.verifiedFiles??[]).map(file=>file.expected.path)])]);
    if(!coverage.covered) {
      const message=`原始任务的文件目标缺少独立文件契约：${coverage.reason}`;
      const report:import('../verifier/hybrid-verifier.js').AcceptanceReport={mode:'assist',verdict:'unknown',
        observationId:observationSignature(state.observation)??'',checks:[],
        reason:'unsupported_condition',message};
      trace.save('acceptance_task',{...state,acceptanceReport:report});
      return {result:{ok:false,message},report};
    }
    const provenPaths=new Set((state.verifiedFiles??[])
      .map(item=>item.expected.path.toLowerCase()));
    // A frozen file that THIS task's dispatched action created/changed with wrong
    // content (and never subsequently proved correct) is an attributable FAIL,
    // not an UNKNOWN. This covers the wrong-body negative without replaying save.
    const liveContradiction=(state.taskFileContradictions??[])
      .some(item=>!provenPaths.has(item.path.toLowerCase())&&
        deterministicFileRequirements.some(req=>req.path.toLowerCase()===item.path.toLowerCase()));
    const files:TaskFileEvidence[]=[];
    let fileBoundaryError:string|undefined;
    // The end-of-task current-file re-read (anti-replay) anchors "now". Window/page
    // criteria therefore need a CONTEMPORANEOUS capture: after Save there can be a
    // tens-of-seconds stage-diagnosis/done gap, so the last pre-done observation is
    // already older than the freshness window by the time we re-read the file. Take
    // one read-only observation at completion and read the file right after it. If
    // re-observation fails, fall back to the stored observation and stay unknown.
    let terminalObservation=state.observation;
    if(useFileGate){
      try { terminalObservation=(await observeWithFacets())??state.observation; }
      catch { terminalObservation=state.observation; }
    }
    for(const expected of deterministicFileRequirements) {
      const proof=state.verifiedFiles?.find(item=>item.taskId===state.taskId&&
        JSON.stringify(item.expected)===JSON.stringify(expected));
      if(!proof) {fileBoundaryError='missing_declared_file_proof';break;}
      let current:DesktopFileSnapshot|undefined;
      try {current=await runtime.inspectFile?.(proof.expected.path);} catch { /* Unknown, never pass. */ }
      const checked=currentFileEvidence(proof,current);
      if(checked.reason||!checked.current) {fileBoundaryError=checked.reason??'missing_current_file_capture';break;}
      files.push({proof,current:checked.current});
    }
    const normalized=fileBoundaryError?{reason:fileBoundaryError}:
      taskEvidenceInput(state.taskId,state.goal,state.completionCriteria,terminalObservation,
        useFileGate?{files,exactContract:true}:{planned:state.verificationContract});
    let taskReport:VerificationReport|undefined;
    let shadowFailed=false;
    try {if(normalized.input)taskReport=useFileGate
      ?await new VerificationEngine().verify(normalized.input)
      :shadowSink?(shadowVerify?await shadowVerify(structuredClone(normalized.input)):
        await new VerificationEngine().verify(normalized.input)):undefined;
    } catch {shadowFailed=true;}
    shadow({kind:'task-verification',taskId:state.taskId,step:state.step,input:normalized.input,
      report:taskReport,status:shadowFailed||!normalized.input?'blocked':'ready_for_normalization',
      reasons:shadowFailed?['shadow_pipeline_error']:normalized.reason?[normalized.reason]:[]});
    const original = verifyGoal(state.completionCriteria, terminalObservation, domainEvaluator);
    if(useFileGate) {
      const fileFail=liveContradiction||taskReport?.checks
        .some(check=>check.id.startsWith('verified-file:')&&check.verdict==='fail')===true;
      const verdict=fileFail?'fail':taskReport?.verdict==='pass'&&original.ok?'pass':'unknown';
      const gateLabel=exactFileContract?'固定流程':'原始目标';
      const message=verdict==='pass'?`${gateLabel}的当前窗口与文件证据均已通过确定性验收`:
        `${gateLabel}完成证据未通过：${normalized.reason??taskReport?.checks
          .filter(check=>check.verdict!=='pass').map(check=>`${check.id}:${check.reason}`).join(',')??original.message}`;
      const report:import('../verifier/hybrid-verifier.js').AcceptanceReport={mode:'assist',verdict,
        observationId:observationSignature(state.observation)??'',
        checks:taskReport?.checks.map(check=>({criterion:check.id,verdict:check.verdict,
          message:check.reason}))??[],
        ...(verdict==='unknown'?{reason:normalized.reason==='capture_identity_changed'?'target_ambiguous' as const:
          normalized.reason==='capture_order_unconfirmed'?'observation_stale' as const:
          shadowFailed?'verification_error' as const:'evidence_unavailable' as const}:{}),message};
      trace.save('acceptance_task',{...state,acceptanceReport:report});
      trace.recordNodeMetric(state.taskId,{step:state.step,node:'acceptance_task',
        startedAt:new Date().toISOString(),durationMs:taskReport?.metrics.durationMs??0,
        actor:'system',operator:exactFileContract?'固定流程文件契约验收':'原始目标文件契约验收'});
      return {result:{...original,ok:verdict==='pass',message},report};
    }
    if(hasRebindCondition(state.completionCriteria)) {
      // 可编辑持久字段：终态再取一次只读观察锚定「现在」，把链推进到最新后裁决，避免陈旧重投影放行。
      let terminal=state.observation;
      let terminalChain:RebindStateMap|undefined=state.rebindState;
      try {
        const fresh=await observeWithFacets();
        if(fresh){
          terminal=fresh;
          const effect=state.lastResult?.effect??(state.lastResult?.ok?'dispatched':'uncertain');
          const chain:RebindStateMap={...(state.rebindState??{})};
          for(const index of rebindConditionIndexes(state.completionCriteria))
            chain[index]=ingestRebindObservation(chain[index],fresh,
              state.completionCriteria!.structuredStates![index],effect==='dispatched');
          terminalChain=chain;
        }
      } catch { /* 取不到新鲜观察就用已存观察与链，fail-closed 不额外放行。 */ }
      const source=state.verificationContract?.evidenceSources.structuredStates==='dom'?'dom':'uia';
      const rb=evaluateRebindTask(state.completionCriteria!,terminalChain,terminal,source);
      const report:import('../verifier/hybrid-verifier.js').AcceptanceReport={mode:'assist',
        verdict:rb.verdict,observationId:observationSignature(terminal)??'',
        checks:rb.checks.map(check=>({criterion:check.criterion,verdict:check.verdict,
          message:check.message,...(check.evidence?{evidence:check.evidence}:{})})),
        ...(rb.verdict==='unknown'?{reason:'evidence_unavailable' as const}:{}),
        message:rb.message};
      trace.save('acceptance_task',{...state,acceptanceReport:report});
      return {result:{...original,ok:rb.verdict==='pass',message:rb.message},report};
    }
    const report = await acceptance(state, 'task');
    return {result:report ? applyAcceptance(original, report) : original, report};
  }
  function hasStructuredTaskProof(checked?: Awaited<ReturnType<typeof complete>>) {
    const report = checked?.report;
    return checked?.result.ok === true && report?.mode === 'assist' &&
      report.verdict === 'pass' && !report.auxiliary && report.checks.length > 0 &&
      report.checks.every(check => check.verdict === 'pass') &&
      report.checks.some(check => check.criterion.startsWith('structuredStates:') &&
        (check.evidence?.source === 'dom' || check.evidence?.source === 'uia'));
  }
  const blockedAcceptance = (report: ComputerState['acceptanceReport'],
    state?: ComputerState): Partial<ComputerState> => {
    if (report?.mode !== 'assist' || report.verdict === 'pass') return {};
    // A fresh, complete Guest file read that contradicts a previously verified
    // file (or a frozen goal file a task action itself wrote with wrong content)
    // is a terminal task failure. Missing reads remain recoverable unknowns.
    const pinnedFileFail = state?.workflowRef?.explicit === true &&
      state.workflowReplayState?.exploring === false &&
      !!state.workflowRef.requiredFiles?.length && report.verdict === 'fail' &&
      report.checks.some(check => check.criterion.startsWith('verified-file:') &&
        check.verdict === 'fail');
    const genericFileFail = state?.workflowRef?.explicit !== true && report.verdict === 'fail' &&
      ((state?.taskFileContradictions?.length ?? 0) > 0 ||
        report.checks.some(check => check.criterion.startsWith('verified-file:') &&
          check.verdict === 'fail'));
    // 可编辑字段在完整「保存→离开→重开→新身份重投影」后，应用回填值仍与期望矛盾：
    // 这是可归因的应用拒绝保存，确定性终态 FAIL（忽略任何提示横幅仍成立），不是证据不足。
    const structuredRebindFail = report.verdict === 'fail' &&
      hasRebindCondition(state?.completionCriteria) &&
      report.checks.some(check => check.criterion.startsWith('structuredStates:') &&
        check.verdict === 'fail');
    const fileContradiction = pinnedFileFail || genericFileFail;
    const terminalFail = fileContradiction || structuredRebindFail;
    return {status:terminalFail ? 'failed' : checkpointer ? 'paused' : 'waiting_user',
      acceptanceReport:report, error:report.message,
      summary:fileContradiction ? '当前桌面文件与已验收结果矛盾，任务失败；未重复执行保存'
        : structuredRebindFail ? '保存后离开并重开，应用重投影的持久值与目标矛盾，任务失败；未重复执行保存'
        : '验收未通过；请补充证据后继续，未重复执行动作'};
  };

  const graph = new StateGraph(State)
    .addNode("observe", timed("observe", "runtime", runtime.name ?? "运行时", async (state) => {
      try {
        const observation = await observeWithFacets();
        return save("observe", state, { observation, observationFailed: false,
          ...(state.step === 0 ? {
            taskRequiredFiles: state.workflowRef?.explicit === true ? [] :
              (state.taskRequiredFiles ?? desktopFileExpectationsFromGoal(state.goal)) } : {}),
          ...(state.step === 0 && !state.baselineChecks && state.completionCriteria
            ? {baselineChecks:deterministicChecks(state.completionCriteria, observation,
              state.verificationContract, domainEvaluator)} : {}) });
      } catch (error) {
        if (isBudgetExceeded(error)) return save('budget_pause', state, { status: 'paused', error: error.message, summary: error.message });
        if (error instanceof TargetWindowLostError) return save("observe", state, {
          observationFailed: true, status: "paused", recoveryRequired: true,
          recoveryUncertain: state.recoveryUncertain || state.verificationPending || !!state.inFlightAction,
          summary: "原目标窗口已关闭；先核对当前桌面与动作结果，不能盲目重发",
          error: String(error) });
        if (error instanceof WorkerConnectionError) return save("observe", state, {
          observationFailed: true, status: "paused", recoveryRequired: true,
          summary: "Worker 连接中断，继续前需要重新观察", error: String(error) });
        return save("observe", state, { observationFailed: true, error: String(error) });
      }
    }))
    .addNode("focus_recover", timed("focus_recover", "runtime", "恢复目标窗口焦点", async (state) => {
      const attempts = (state.focusRecoveryCount ?? 0) + 1;
      if (!runtime.recoverFocus || attempts > 2) {
        return save("focus_recover", state, { focusRecoveryCount: attempts,
          status: checkpointer ? "paused" : "failed",
          error: "目标窗口持续不在前台；请将目标应用切到前台后继续",
          summary: "窗口焦点无法恢复，已安全停下" });
      }
      try {
        await runtime.recoverFocus();
        // 失焦前的定位可能已过期；未发出的动作必须重新观察并决策。
        const replayState = !state.verificationPending &&
          state.workflowReplayState?.activeIndex !== undefined
          ? { ...state.workflowReplayState,
            nextIndex: state.workflowReplayState.activeIndex, activeIndex: undefined }
          : state.workflowReplayState;
        if (replayState) model.restoreState?.(replayState);
        return save("focus_recover", state, { focusRecoveryCount: attempts,
          observationFailed: false, lastResult: state.verificationPending ? state.lastResult : undefined,
          lastAction: state.verificationPending ? state.lastAction : undefined,
          groundedAction: undefined, targetBinding: undefined, actionResolution: undefined,
          workflowReplayState: replayState, resumePendingAction: false, error: undefined,
          summary: "窗口已重新置于前台，重新观察当前画面" });
      } catch (error) {
        return save("focus_recover", state, { focusRecoveryCount: attempts,
          status: checkpointer ? "paused" : "failed",
          error: `无法恢复目标窗口焦点：${String(error)}。请将目标应用切到前台后继续`,
          summary: "窗口焦点无法恢复，已安全停下" });
      }
    }))
    .addNode("decide", timed("decide", model.kind ?? "model", model.name ?? "未标识决策器", async (state) => {
      // 可归因终态 FAIL（rebind 矛盾 / desktop_file 矛盾）必须在动作级立即终止：
      // 不得被下一次 decide 重置为 running 而触发回退探索或重复保存。
      if (state.status === "failed") return save("decide", state, {});
      if (state.step >= maxSteps) return save("decide", state, { status: "failed", error: "已达到整任务动作上限" });
      if (state.stage && state.stage.actionCount >= (state.taskContract?.stageActionLimit ?? 24)) {
        return save("decide", state, { status: "failed", error: "已达到当前阶段动作上限" });
      }
      try {
        const action = await model.decide(state);
        return save("decide", state, { lastAction: action, groundedAction: undefined,
          targetBinding: undefined,
          actionResolution: undefined,
          groundingStrategy: undefined, step: state.step + 1, lastResult: undefined,
          lastVerification: undefined, goalVerification: undefined,
          workflowReplayState: model.snapshotState?.(),
          ...(model.currentWorkflowRef ? { workflowRef: model.currentWorkflowRef() } : {}),
          ...(state.stage ? { stage: { ...state.stage, actionCount: state.stage.actionCount + 1 } } : {}),
          status: action.kind === "ask_user" ? "waiting_user" : "running",
          error: action.kind === "ask_user" ? action.question : undefined });
      } catch (error) {
        if (isBudgetExceeded(error)) return save('budget_pause', state, { status: 'paused', error: error.message, summary: error.message });
        if (error instanceof WorkflowRecoveryError) return save("workflow_blocked", state, {
          status: "paused", recoveryRequired: true, error: error.message, summary: error.message });
        return save("decide", state, { lastResult: { ok: false, message: String(error) }, error: String(error) });
      }
    }))
    .addNode("ground", timed("ground", "runtime", runtime.name ?? "运行时", async (state) => {
      const action = state.lastAction;
      if (!action) return save("ground", state, { lastResult: { ok: false, message: "缺少动作" } });
      if (action.kind !== "click" && action.kind !== "double_click" && action.kind !== "type" &&
          action.kind !== "paste_text" && !(action.kind === "scroll" && action.target)) {
        return save("ground", state, { groundedAction: action });
      }
      try {
        const target = action.target!;
        // P9-A4：语义目标重映射优先（replay 语义漂移，纯函数 0 模型调用）。
        // 命中 → 采用唯一高置信目标并记录定位证据；拒绝/非 replay → 走原 runtime.ground。
        const remapped = trySemanticRemap(state, action);
        if (remapped) {
          const attempt = { strategy: "semantic_remap" as const, matched: true, selected: true,
            detail: `matchedBy=${remapped.matchedBy} score=${remapped.score} alternatives=${remapped.alternatives.length}` };
          trace.recordGrounding(state.taskId, state.step, [attempt]);
          return save("ground", state, {
            groundedAction: { ...action, target: remapped.target },
            targetBinding: bindTarget(action, remapped.target, [attempt], state.observation),
            groundingStrategy: "semantic_remap",
          });
        }
        if (!runtime.ground) {
          if (target.kind === "candidates") throw new Error("运行时不支持候选目标定位");
          return save("ground", state, { groundedAction: action });
        }
        const result = await runtime.ground(action);
        trace.recordGrounding(state.taskId, state.step, result.attempts);
        if (!result.target) return save("ground", state, {
          lastResult: { ok: false, message: "所有目标定位策略均失败" },
        });
        return save("ground", state, {
          groundedAction: { ...action, target: result.target },
          targetBinding: bindTarget(action, result.target, result.attempts, state.observation),
          groundingStrategy: result.attempts.find((attempt) => attempt.selected)?.strategy ?? result.target.kind,
        });
      } catch (error) {
        if (isBudgetExceeded(error)) throw error;
        return save("ground", state, { lastResult: { ok: false, message: String(error) },
          error: String(error) });
      }
    }))
    .addNode("resolve_action", timed("resolve_action", "runtime", "逐动作提供者解析", async (state) => {
      const action = state.groundedAction ?? state.lastAction;
      if (!action) return save("resolve_action", state, {
        lastResult: { ok: false, message: "缺少已定位动作" } });
      try {
        const resolution = runtime.resolveAction
          ? await runtime.resolveAction(action)
          : singleProvider(runtime.name ?? "runtime.default", "运行时未提供逐动作解析，沿用默认执行器");
        if (!resolution.selected || !resolution.candidates.some((candidate) =>
          candidate.provider === resolution.selected && candidate.available)) {
          throw new Error("逐动作解析未选中可用提供者");
        }
        trace.recordActionResolution(state.taskId, state.step, resolution);
        return save("resolve_action", state, { actionResolution: resolution });
      } catch (error) {
        return save("resolve_action", state, { lastResult: { ok: false, message: String(error) },
          error: String(error) });
      }
    }))
    .addNode("risk_check", timed("risk_check", "system", "风险规则", async (state) => {
      const action = state.lastAction;
      const fingerprint = action && impactFingerprint(action);
      const previousImpact = [...(state.recentHistory ?? [])].reverse()
        .find((item) => impactFingerprint(item.action));
      const resetByNavigation = previousImpact &&
        impactFingerprint(previousImpact.action) !== fingerprint && previousImpact.verification?.ok;
      const duplicate = !!fingerprint && !!state.executedImpactActions?.includes(fingerprint) &&
        !resetByNavigation;
      const approved = action && state.approvedActionFingerprint === JSON.stringify(action) &&
          state.approvalContextUrl === state.observation?.url &&
          state.approvalContextSignature === observationSignature(state.observation);
      if (duplicate && !approved) {
        return save("risk_check", state, { status: "waiting_user",
          approvalContextUrl: state.observation?.url,
          approvalContextSignature: observationSignature(state.observation),
          error: "重复执行可能产生副作用，需人工处理" });
      }
      if (action && (actionIsRisky(action) || duplicate) && approved) {
        return save("risk_check", state, { status: "running", approvedActionFingerprint: undefined,
          resumePendingAction: false, error: undefined });
      }
      return save("risk_check", state, action && actionIsRisky(action)
        ? { status: "waiting_user", approvalContextUrl: state.observation?.url,
          approvalContextSignature: observationSignature(state.observation),
          approvedActionFingerprint: undefined, resumePendingAction: false,
          error: "高风险动作需要人工确认" }
        : { resumePendingAction: false });
    }))
    .addNode("execute", timed("execute", "runtime", runtime.name ?? "运行时", async (state) => {
      const shadowContract=freezeShadowContract(state);
      shadow({kind:'contract',taskId:state.taskId,step:state.step,contract:shadowContract});
      const action = state.groundedAction ?? state.lastAction!;
      const fingerprint = impactFingerprint(state.lastAction!);
      const updates: Partial<ComputerState> = {
        shadowContract,
        beforeObservation: state.observation,
        verificationPending: true,
      };
      // 可编辑持久字段：在动作发出前用「新鲜」的当前观察冻结基线身份 R0 与旧值 A。
      // 仅冻结一次（首个能唯一读到目标的完整枚举），之后不再移动基线。
      if(hasRebindCondition(state.completionCriteria)){
        const prevRebind:RebindStateMap={...(state.rebindState??{})};
        for(const index of rebindConditionIndexes(state.completionCriteria)){
          prevRebind[index]=captureRebindBaseline(prevRebind[index],state.observation,
            state.completionCriteria!.structuredStates![index]);
        }
        updates.rebindState=prevRebind;
      }
      const condition=shadowContract.action.intent &&
        'postcondition' in shadowContract.action.intent ? shadowContract.action.intent.postcondition : undefined;
      if(condition?.kind==='desktop_file') {
        try { updates.beforeFile=await runtime.inspectFile?.(condition.path); }
        catch { updates.beforeFile=undefined; }
      } else updates.beforeFile=undefined;
      // Generic (non-pinned) tasks: bound EACH dispatched action with a FRESH
      // read-only pre-dispatch snapshot of every frozen goal file not yet
      // deterministically proven. A per-action tight before/after window is what
      // attributes creation to the actual Save action; pinning the very first
      // action's snapshot would make any GUI task slower than the evidence time
      // window unable to prove a later, correctly-flushed save. Expected values
      // come from the original goal, not the model/Oracle.
      const goalBeforeFiles: Record<string, DesktopFileSnapshot | undefined> = {};
      for (const expected of unprovenGoalFileExpectations(state)) {
        const key = expected.path.toLowerCase();
        try { goalBeforeFiles[key] = await runtime.inspectFile?.(expected.path); }
        catch { goalBeforeFiles[key] = undefined; }
      }
      updates.taskBeforeFiles = goalBeforeFiles;
      const resolution = state.actionResolution;
      const candidates = resolution
        ? [resolution.selected, ...resolution.candidates.filter((item) =>
          item.available && item.provider !== resolution.selected).map((item) => item.provider)]
        : [runtime.name ?? "runtime.default"];
      let result: ComputerState["lastResult"];
      const notes: string[] = [];
      for (const provider of candidates) {
        if (recoveryJournal) trace.save("dispatch_pending", { ...state, inFlightAction: state.lastAction });
        try {
          // Stable across a retried dispatch, distinct for each provider fallback.
          result = await runtime.execute(action, singleProvider(provider, "本次尝试只授权该执行器"),
            createHash('sha256').update(`${state.taskId}:${state.step}:${provider}`).digest('hex'));
        } catch (error) {
          result = { ok: false, message: String(error), effect: "uncertain" };
        }
        const effect = result.effect ?? (result.ok ? "dispatched" : "uncertain");
        notes.push(`${provider}：${result.message}（${effect}）`);
        trace.recordProviderAttempt(state.taskId, state.step, result.provider ?? provider,
          result.ok, effect, result.message);
        if (result.ok || effect !== "none") break;
      }
      result ??= { ok: false, message: "没有可用的执行器", effect: "none" };
      const effect = result.effect ?? (result.ok ? "dispatched" : "uncertain");
      const impactActions = fingerprint && effect !== "none"
        ? [...(state.executedImpactActions ?? []), fingerprint] : state.executedImpactActions;
      trace.recordActionExecution(state.taskId, state.step, result.provider, result.ok, notes.join("；"));
      if (state.groundingStrategy) trace.recordGroundingExecution(state.taskId, state.step, result.ok);
      return save("execute", state, { ...updates, inFlightAction: undefined, executedImpactActions: impactActions,
        ...(recoveryJournal && effect === "uncertain" ? { status: "paused" as const,
          recoveryRequired: true, recoveryUncertain: true, summary: "动作结果未确认，已暂停；继续前重新观察" } : {}),
        lastResult: result, error: result.ok ? undefined : result.message });
    }))
    .addNode("verify", timed("verify", "system", "动作验证器", async (state) => {
      shadow(shadowObservation(state));
      const intent=state.shadowContract?.action.intent;
      const condition=intent&&'postcondition' in intent?intent.postcondition:undefined;
      let fileResult: {report?:VerificationReport;reason?:string}|undefined;
      let afterFile:DesktopFileSnapshot|undefined;
      if(condition?.kind==='desktop_file') {
        try { afterFile=await runtime.inspectFile?.(condition.path); } catch { /* Missing evidence fails closed. */ }
        const effect=state.lastResult?.effect??(state.lastResult?.ok?'dispatched':'uncertain');
        const normalized=fileEvidenceInput(state.taskId,state.step,condition,state.beforeFile,afterFile,effect);
        fileResult={reason:normalized.reason,
          ...(normalized.input?{report:await new VerificationEngine().verify(normalized.input)}:{})};
        shadow({kind:'action-verification',taskId:state.taskId,step:state.step,input:normalized.input,
          report:fileResult.report,status:normalized.input?'ready_for_normalization':'blocked',
          reasons:normalized.reason?[normalized.reason]:[]});
      }
      if(shadowSink) {
        try {
          if(condition?.kind!=='desktop_file') {
            const effect=state.lastResult?.effect??(state.lastResult?.ok?'dispatched':'uncertain');
            const normalized=actionEvidenceInput(state.taskId,state.step,intent,
              state.beforeObservation,state.observation,effect,state.targetBinding);
            const report=normalized.input
              ?shadowVerify?await shadowVerify(structuredClone(normalized.input)):
                await new VerificationEngine().verify(normalized.input):undefined;
            shadow({kind:'action-verification',taskId:state.taskId,step:state.step,input:normalized.input,report,
              status:normalized.input?'ready_for_normalization':'blocked',
              reasons:normalized.reason?[normalized.reason]:[]});
          }
        } catch {shadow({kind:'action-verification',taskId:state.taskId,step:state.step,
          status:'blocked',reasons:['shadow_pipeline_error']});}
      }
      const result = condition?.kind==='desktop_file'
        ? {ok:fileResult?.report?.verdict==='pass',message:fileResult?.report?.verdict==='pass'
          ? '桌面文件已通过独立内容验收'
          : `桌面文件未通过独立验收：${fileResult?.reason??fileResult?.report?.checks
            .filter(check=>check.verdict!=='pass').map(check=>`${check.id}:${check.reason}`).join(',')??'missing_evidence'}`}
        : verifyAction(state.lastAction!, state.lastResult, state.beforeObservation, state.observation);
      // A failed or unprovable save must not be retried as though it were a harmless click.
      const fileFailed=condition?.kind==='desktop_file'&&!result.ok;
      const verifiedFile:VerifiedDesktopFile|undefined=condition?.kind==='desktop_file'&&
        result.ok&&state.beforeFile&&afterFile
        ?{taskId:state.taskId,step:state.step,expected:structuredClone(condition),
          before:state.beforeFile,after:afterFile}:undefined;
      // Generic tasks: any frozen goal file created/changed by THIS dispatched
      // action (read-only boundary, exact frozen content) earns deterministic
      // proof. Purely additive — a mismatch on an unrelated step never fails the
      // step or replays the save; the task gate decides at completion.
      const goalVerifiedFiles:VerifiedDesktopFile[]=[];
      const goalContradictions:NonNullable<ComputerState['taskFileContradictions']>=[];
      const genericEffect=state.lastResult?.effect??(state.lastResult?.ok?'dispatched':'uncertain');
      if(genericEffect==='dispatched')for(const expected of unprovenGoalFileExpectations(state)) {
        const before=state.taskBeforeFiles?.[expected.path.toLowerCase()];
        let after:DesktopFileSnapshot|undefined;
        try{after=await runtime.inspectFile?.(expected.path);}catch{continue;}
        // Generic attribution only concerns an action that actually creates or
        // changes the frozen file. A pre-Save step (opening the dialog, typing
        // the name) leaves the file absent on both sides: irrelevant, not a
        // contradiction. The action-level explicit desktop_file postcondition
        // keeps its own stricter "still absent after the save = fail" semantics.
        if(before&&after&&before.complete&&after.complete&&!before.exists&&!after.exists)continue;
        const normalized=fileEvidenceInput(state.taskId,state.step,expected,before,after,genericEffect);
        if(!normalized.input)continue;
        const report=await new VerificationEngine().verify(normalized.input);
        if(report.verdict==='pass'&&before&&after)
          goalVerifiedFiles.push({taskId:state.taskId,step:state.step,
            expected:structuredClone(expected),before,after});
        else if(report.verdict==='fail'){
          // Boundary already proves THIS action created/changed the file, yet its
          // content/hash contradicts the frozen goal: attributable wrong result.
          const reason=report.checks.filter(c=>c.verdict!=='pass')
            .map(c=>`${c.id}:${c.reason}`).join(',')||'desktop_file_content_mismatch';
          goalContradictions.push({path:expected.path,step:state.step,reason});
        }
      }
      const prevContradictions=(state.taskFileContradictions??[])
        .filter(item=>!goalContradictions.some(add=>add.path.toLowerCase()===item.path.toLowerCase()));
      const mergedContradictions=goalContradictions.length
        ?[...prevContradictions,...goalContradictions]:undefined;
      // The frozen goal proof carries the authoritative exact-body contract; a
      // model action-level desktop_file postcondition on the SAME underlying
      // file must not replace it with a thinner (path-only) expectation that the
      // task gate cannot match back to the frozen requirement.
      let mergedFiles:VerifiedDesktopFile[]|undefined;
      if(goalVerifiedFiles.length)
        mergedFiles=[...(state.verifiedFiles??[]).filter(existing=>
          !goalVerifiedFiles.some(add=>add.expected.path.toLowerCase()===existing.expected.path.toLowerCase())),
          ...goalVerifiedFiles];
      if(verifiedFile){
        const base=mergedFiles??state.verifiedFiles??[];
        if(!base.some(item=>item.after.path.toLowerCase()===verifiedFile.after.path.toLowerCase()))
          mergedFiles=[...base,verifiedFile];
      }
      // 可编辑持久字段：用本次动作后的新鲜观察推进 rebind 链（编辑→提交→缺席→重投影）。
      let rebindNext:RebindStateMap|undefined;
      let rebindFailReport:import('../verifier/hybrid-verifier.js').AcceptanceReport|undefined;
      if(hasRebindCondition(state.completionCriteria)){
        rebindNext={...(state.rebindState??{})};
        for(const index of rebindConditionIndexes(state.completionCriteria))
          rebindNext[index]=ingestRebindObservation(rebindNext[index],state.observation,
            state.completionCriteria!.structuredStates![index],genericEffect==='dispatched');
        // 一旦「提交→离开→新身份重投影」已闭合且应用回填旧值/矛盾值，这是可归因的应用拒绝
        // 保存，必须在动作级立即终态 FAIL（与 desktop_file contradiction 同构），不能等 Agent
        // 自觉 done，更不能让它把保存当成无害点击反复重试。PASS 不在此提前终止，UNKNOWN 放行。
        const source=state.verificationContract?.evidenceSources.structuredStates==='dom'?'dom':'uia';
        const rb=evaluateRebindTask(state.completionCriteria!,rebindNext,state.observation,source);
        if(rb.verdict==='fail'){
          rebindFailReport={mode:'assist',verdict:'fail',
            observationId:observationSignature(state.observation)??'',
            checks:rb.checks.map(check=>({criterion:check.criterion,verdict:check.verdict,
              message:check.message,...(check.evidence?{evidence:check.evidence}:{})})),
            message:rb.message};
          trace.save('acceptance_task',{...state,acceptanceReport:rebindFailReport,
            structuredRebindContradiction:true});
        }
      }
      const rebindFailed=!!rebindFailReport;
      return save("verify", state, { lastVerification: result, verificationPending: false,
        ...(mergedFiles?{verifiedFiles:mergedFiles}:{}),
        ...(rebindNext?{rebindState:rebindNext}:{}),
        recentHistory: history(state, result),
        ...(mergedContradictions?{taskFileContradictions:mergedContradictions}:{}),
        ...(result.ok ? { focusRecoveryCount: 0 } : {}),
        retryCount: result.ok ? 0 : state.retryCount,
        ...(fileFailed||rebindFailed?{status:'failed' as const}:{}),
        ...(rebindFailed?{structuredRebindContradiction:true,acceptanceReport:rebindFailReport,
          summary:'保存后离开并重开，应用以新控件身份回填的持久值与目标矛盾，任务失败；未重复执行保存'}:{}),
        error: fileFailed||rebindFailed
          ? (rebindFailReport?.message ?? result.message)
          : (result.ok ? undefined : result.message) });
    }))
    .addNode("verify_task", timed("verify_task", "system", "完成验证器", async (state) => {
      const {result, report} = await complete(state);
      return save("verify_task", state, { goalVerification: result, acceptanceReport:report, ...blockedAcceptance(report,state),
        error: result.ok ? undefined : result.message });
    }))
    .addNode("pause_check", timed("pause_check", "system", "暂停检查", async (state) => {
      const budgetReason = currentBudgetStopReason();
      return budgetReason || pauseRequested?.(state.taskId)
        ? save("pause_check", state, { status: "paused", summary: budgetReason ?? "已在安全边界暂停",
          ...(budgetReason ? { error: budgetReason } : {}) }) : {};
    }))
    .addNode("resume_reconcile", timed("resume_reconcile", "system", "恢复状态对齐", async (state) => {
      if (state.workflowRef && workflowRecovery) {
        const decision = workflowRecovery(state);
        if (decision.decision === "blocked") return save("workflow_recovery", state, {
          status: "paused", recoveryRequired: true, summary: decision.reason, error: decision.reason });
        if (decision.replay) model.restoreState?.(decision.replay);
        return save("workflow_recovery", state, { resumeReconcile: false, recoveryUncertain: false,
          inFlightAction: undefined,
          workflowReplayState: decision.replay, summary: decision.reason,
          lastAction: undefined, lastResult: undefined, lastVerification: undefined });
      }
      const {result, report} = await complete(state);
      if (report?.mode === 'assist' && report.verdict !== 'pass' && verifyGoal(state.completionCriteria, state.observation, domainEvaluator).ok)
        return save('resume_reconcile', state, {...blockedAcceptance(report,state), goalVerification:result, resumeReconcile:false});
      if (!result.ok && state.recoveryUncertain) return save("resume_reconcile", state, {
        recoveryUncertain: true, resumeReconcile: false, status: "waiting_user",
        lastAction: { kind: "ask_user", question: "Host 中断时有动作可能已发出，无法确认结果。请核对当前现场并说明已完成的操作，避免重复执行。" },
        error: "崩溃前动作结果不确定，需要人工核对" });
      return save("resume_reconcile", state, { resumeReconcile: false,
        recoveryUncertain: false, inFlightAction: undefined,
        acceptanceReport:report, goalVerification: result, status: result.ok ? "done" : "running",
        lastAction: undefined, lastResult: undefined, groundedAction: undefined,
        targetBinding: undefined, actionResolution: undefined,
        summary: result.ok ? "人工操作后的新观察已满足目标，跳过剩余动作" : "已重新观察；依据当前状态重新决策" });
    }))
    .addNode("pause_before_execute", timed("pause_before_execute", "system", "执行前暂停检查", async (state) => {
      const budgetReason = currentBudgetStopReason();
      return budgetReason || pauseRequested?.(state.taskId)
        ? save("pause_before_execute", state, { status: "paused", summary: budgetReason ?? "动作尚未发出，已暂停",
          ...(budgetReason ? { error: budgetReason } : {}) }) : {};
    }))
    .addNode("pause_interrupt", timed("pause_interrupt", "human", "等待继续", async (state) => {
      interrupt({ kind: "pause", taskId: state.taskId, question: "任务已暂停，可手动操作后继续" });
      const replayState = state.workflowReplayState?.activeIndex !== undefined &&
          state.lastResult === undefined
        ? { ...state.workflowReplayState, nextIndex: state.workflowReplayState.activeIndex,
          activeIndex: undefined }
        : state.workflowReplayState;
      if (replayState) model.restoreState?.(replayState);
      return new Command({ update: save("continue", state, { status: "running",
        lastAction: undefined, groundedAction: undefined, actionResolution: undefined,
        resumePendingAction: false, verificationPending: false,
        workflowReplayState: replayState,
        resumeReconcile: true, focusRecoveryCount: 0,
        summary: "继续前重新观察当前状态" }), goto: "observe" });
    }), { ends: ["observe"] })
    .addNode("stage_plan", timed("stage_plan", "model", "阶段规划", async (state) => {
      if (pauseRequested?.(state.taskId)) return save("stage_plan", state, {
        status: "paused", summary: "已在阶段边界暂停" });
      if (!model.planStage || !state.taskContract) {
        return save("stage_plan", state, { status: "failed", error: "当前模型不支持阶段规划" });
      }
      const version = (state.stagePlanVersion ?? 0) + 1;
      if (version > 12) return save("stage_plan", state,
        { status: "failed", error: "阶段规划次数已达到上限" });
      try {
        const next = await model.planStage(state);
        const stageEvidenceContract=freezeStageEvidence(`${state.taskId}:${version}`,next.goal,next.successCondition,
          state.taskContract.target,next.verification);
        shadow({kind:'stage-contract',taskId:state.taskId,step:state.step,stageContract:stageEvidenceContract});
        return save("stage_plan", state, { stagePlanVersion: version,
          stageEvidenceContract,stageEvidenceBoundary:structuredClone(state.observation?.capture),
          stage: { id: `${state.taskId}:${version}`, goal: next.goal,
            successCondition: next.successCondition, startedAtStep: state.step,
            actionCount: 0, planVersion: version, isFinal: next.isFinal },
          retryCount: 0, error: undefined, lastAction: undefined,
          stageVisualCandidate: undefined, stageCheckNeedsObserve: false,
          diagnosisCount: 0, diagnosisAtActionCount: 0, diagnosis: undefined,
          workflowRef: undefined, workflowReplayState: undefined,
          summary: `当前阶段：${next.goal}` });
      } catch (error) {
        if (isBudgetExceeded(error)) return save('budget_pause', state, { status: 'paused', error: error.message, summary: error.message });
        return save("stage_plan", state, { status: checkpointer ? "paused" : "failed",
          ...(checkpointer ? { recoveryRequired: true, summary: "阶段规划不可用，现场保留；继续时重新观察" } : {}),
          error: `阶段规划失败：${String(error)}` });
      }
    }))
    .addNode("stage_check", timed("stage_check", "model", "阶段验收", async (state) => {
      if (!state.stage) return {};
      if(shadowSink) {
        try {
          const normalized=state.stageEvidenceContract?.stageId===state.stage.id
            ?stageEvidenceInput(state.stageEvidenceContract,state.observation,state.stageEvidenceBoundary)
            :{reason:'missing_frozen_stage_contract'};
          const report=normalized.input
            ?shadowVerify?await shadowVerify(structuredClone(normalized.input))
              :await new VerificationEngine().verify(normalized.input):undefined;
          shadow({kind:'stage-verification',taskId:state.taskId,step:state.step,input:normalized.input,report,
            status:normalized.input?'ready_for_normalization':'blocked',reasons:normalized.reason?[normalized.reason]:[]});
        } catch {shadow({kind:'stage-verification',taskId:state.taskId,step:state.step,status:'blocked',reasons:['shadow_pipeline_error']});}
      }
      if (!model.verifyStage || !state.observation) return save("stage_check", state,
        { status: "failed", error: "缺少阶段验收能力或当前观察" });
      try {
        // A final done action can use the frozen, source-bound task contract
        // directly. Do not make a decisive deterministic result depend on JEV.
        const readonlyBrowserFinal = !acceptanceVerifier && state.lastAction?.kind==='done'
          && isReadonlyBrowserContract(state.goal,state.verificationContract);
        const frozenFinal = state.stage.isFinal && !!state.verificationContract
          && (!!acceptanceVerifier || readonlyBrowserFinal);
        const precheckedFinal = frozenFinal || (state.stage.isFinal && state.lastAction?.kind === 'done' &&
          !!state.verificationContract?.successConditions.structuredStates?.length)
          ? await complete(state) : undefined;
        const structuredFinal = hasStructuredTaskProof(precheckedFinal);
        const blockedFinal = state.lastAction?.kind === 'done' && precheckedFinal?.report?.mode === 'assist' &&
          precheckedFinal.report.verdict !== 'pass' && (frozenFinal || !precheckedFinal.report.auxiliary);
        if (blockedFinal) return save('stage_check', state,
          {...blockedAcceptance(precheckedFinal.report, state), stageCheckNeedsObserve:false});
        // A frozen final result contract is stronger than a visual stage guess.
        // Use one task check at this boundary: UNKNOWN means continue toward the result, and a
        // later `done` still pauses rather than reissuing an uncertain action.
        const report = structuredFinal || frozenFinal ? undefined : await acceptance(state, 'stage');
        if (report?.mode === 'assist' && report.verdict !== 'pass' &&
            state.lastAction?.kind === 'done' && state.stage.isFinal)
          return save('stage_check', state, {...blockedAcceptance(report), stageCheckNeedsObserve:false});
        const result = structuredFinal
          ? {ok:true, confidence:1, evidence:'冻结的任务完成条件已由当前结构化状态验证',
            source:precheckedFinal?.report?.checks.some(check => check.criterion.startsWith('structuredStates:') &&
              check.evidence?.source === 'uia') ? 'uia' as const : 'dom' as const}
          : report?.mode === 'assist' && report.verdict === 'pass'
          ? {ok:true, confidence:report.auxiliary?.confidence ?? 0, evidence:report.message, source:'jev' as const}
          : report?.mode === 'assist' && report.verdict === 'fail'
          ? {ok:false, confidence:report.auxiliary?.confidence ?? 0, evidence:report.message, source:'jev' as const}
          : frozenFinal && precheckedFinal?.report
          ? {ok:precheckedFinal.result.ok, confidence:precheckedFinal.result.ok ? 1 : 0,
            evidence:precheckedFinal.result.message,
            source:precheckedFinal.report.auxiliary ? 'jev' as const : readonlyBrowserFinal ? 'dom' as const : 'uia' as const}
          : await model.verifyStage(state.stage, state.observation);
        const lastStageVerification = { ok: result.ok, confidence: result.confidence,
          evidence: result.evidence, source: result.source };
        if (!result.ok && state.resumeReconcile && model.reconcileStage) {
          const reconciled = await model.reconcileStage(state);
          if (reconciled.decision === "skip") {
            const skipped = { id: state.stage.id, goal: state.stage.goal,
              successCondition: state.stage.successCondition, startStep: state.stage.startedAtStep,
              endStep: state.step, evidence: reconciled.evidence, source: "manual" as const };
            return save("stage_reconciled", state, { stage: undefined,
              completedStages: [...(state.completedStages ?? []), skipped], resumeReconcile: false,
              stageCheckNeedsObserve: false,
              summary: `人工操作已越过阶段：${skipped.goal}` });
          }
          if (reconciled.decision === "replan") {
            return save("stage_reconciled", state, { stage: undefined,
              resumeReconcile: false, stageCheckNeedsObserve: false,
              error: `当前画面需要重规划：${reconciled.evidence}` });
          }
        }
        if (!result.ok && model.diagnoseStage && state.stage.actionCount >= 3 &&
            state.stage.actionCount - (state.diagnosisAtActionCount ?? 0) >= 3) {
          const attempts = state.diagnosisCount ?? 0;
          if (attempts >= 2) {
            const replans = (state.stageReplans ?? 0) + 1;
            return save("stage_diagnosis_limit", state, replans > 3
              ? { status: checkpointer ? "paused" : "failed",
                error: "多次调整策略后仍未到达阶段目标，请检查当前画面",
                summary: "阶段无进展，已安全停下" }
              : { stage: undefined, stageReplans: replans,
                diagnosis: undefined, lastStageVerification,
                summary: "连续尝试没有到达阶段目标，重新规划" });
          }
          try {
            const diagnosis = await model.diagnoseStage({ ...state, lastStageVerification });
            const entry = { reason: diagnosis.reason, remedy: diagnosis.remedy,
              decision: diagnosis.decision, step: state.step };
            if (diagnosis.decision === "replan") {
              const replans = (state.stageReplans ?? 0) + 1;
              return save("stage_diagnosis", state, replans > 3
                ? { status: checkpointer ? "paused" : "failed", diagnosis: entry,
                  error: `重新规划次数已达上限：${entry.reason}`,
                  summary: "诊断后需要人工检查" }
                : { stage: undefined, stageReplans: replans, diagnosis: entry,
                  lastStageVerification, summary: `诊断后重新规划：${entry.reason}` });
            }
            return save("stage_diagnosis", state, { diagnosis: entry,
              diagnosisCount: attempts + 1,
              diagnosisAtActionCount: state.stage.actionCount,
              lastStageVerification, summary: `调整执行策略：${entry.reason}` });
          } catch (error) {
            if (isBudgetExceeded(error)) throw error;
            return save("stage_diagnosis", state, { diagnosisAtActionCount: state.stage.actionCount,
              error: `诊断模型暂不可用：${String(error)}` });
          }
        }
        if (!result.ok) {
          const repeatedDone = state.lastAction?.kind === "done";
          return save("stage_check", state, { lastStageVerification,
            stageVisualCandidate: undefined, stageCheckNeedsObserve: false,
            resumeReconcile: false,
            ...(repeatedDone ? { status: checkpointer ? 'paused' as const : 'waiting_user' as const,
              error: `阶段尚未达成：${result.evidence}`,
              summary: '当前阶段缺少完成证据，已停下等待核对' } : {}) });
        }
        if (result.source === "visual_model" &&
            state.stageVisualCandidate?.stageId !== state.stage.id) {
          return save("stage_check", state, { lastStageVerification,
            stageVisualCandidate: { stageId: state.stage.id, evidence: result.evidence,
              screenshotHash: state.observation.screenshotHash },
            stageCheckNeedsObserve: true });
        }
        const finalAcceptance = precheckedFinal ?? (state.stage.isFinal && (state.completionCriteria || acceptanceVerifier)
          ? await complete(state) : undefined);
        const independent = finalAcceptance?.result;
        if (state.stage.isFinal && independent && !independent.ok) {
          return save("stage_check", state, { ...blockedAcceptance(finalAcceptance?.report), lastStageVerification: { ...lastStageVerification,
            ok: false, evidence: `阶段标记已出现，但总目标尚未验收：${independent.message}` },
            stageCheckNeedsObserve: false, error: independent.message });
        }
        const completed = { id: state.stage.id, goal: state.stage.goal,
          successCondition: state.stage.successCondition,
          startStep: state.stage.startedAtStep, endStep: state.step,
          evidence: result.evidence, source: state.resumeReconcile ? "manual" as const : result.source };
        const update: Partial<ComputerState> = { acceptanceReport:finalAcceptance?.report, lastStageVerification,
          completedStages: [...(state.completedStages ?? []), completed], stage: undefined,
          stageVisualCandidate: undefined, stageCheckNeedsObserve: false,
          resumeReconcile: false,
          retryCount: 0, summary: `阶段完成：${completed.goal}` };
        if (state.stage.isFinal) {
          // A weak stage description does not override a stronger, current,
          // source-bound task result. JEV-only PASS still requires review.
          const structuredTaskProof = hasStructuredTaskProof(finalAcceptance);
          const needsReview = completed.source !== "uia" && completed.source !== "dom" && !structuredTaskProof;
          update.goalVerification = needsReview ? { ok: false,
            message: `阶段画面显示目标，但仍需人工核对：${result.evidence}`,
            evidence: [{ criterion: state.taskContract?.target ?? "目标", source: completed.source,
              strength: "weak" }] } : independent ?? { ok: true,
            message: `目标已显示：${result.evidence}`,
            evidence: [{ criterion: state.taskContract?.target ?? "目标", source: completed.source,
              strength: completed.source === "uia" || completed.source === "dom" ? "strong" : "weak" }] };
          update.finalReviewPending = needsReview;
          update.status = needsReview ? "waiting_user" : "running";
          if (needsReview) update.error = `请确认当前画面确已完成目标：${state.taskContract?.target ?? state.goal}`;
          if (!needsReview && onStageCompleted) {
            const learned = await onStageCompleted({ ...state, ...update }, completed);
            if (learned) Object.assign(completed, learned);
          }
        } else if (onStageCompleted && completed.source !== "manual") {
          const learned = await onStageCompleted({ ...state, ...update }, completed);
          if (learned) Object.assign(completed, learned);
        }
        return save("stage_completed", state, update);
      } catch (error) {
        if (isBudgetExceeded(error)) return save('budget_pause', state, { status: 'paused', error: error.message, summary: error.message });
        if (checkpointer && error instanceof Error &&
            (error.name === 'TimeoutError' || (error.name === 'AbortError' && /timeout/i.test(error.message)))) {
          return save('stage_check_timeout', state, { status: 'paused', recoveryRequired: true,
            stageCheckNeedsObserve: true,
            error: `阶段验收超时：${error.message}`,
            summary: '阶段验收超时，现场已保留；继续时重新观察，不重复执行上一步动作' });
        }
        return save("stage_check", state, { status: "failed", error: `阶段验收失败：${String(error)}` });
      }
    }))
    .addNode("recover", timed("recover", "system", "重试规则", async (state) => {
      const retryCount = state.retryCount + 1;
      if (retryCount > maxRetries && state.taskContract && state.stage &&
          (state.stageReplans ?? 0) < 3) {
        return save("recover", state, { retryCount: 0, stage: undefined,
          stageReplans: (state.stageReplans ?? 0) + 1,
          stageVisualCandidate: undefined, stageCheckNeedsObserve: false,
          verificationPending: false, recentHistory: history(state, state.lastVerification),
          approvedActionFingerprint: undefined, resumePendingAction: false,
          error: `当前阶段动作多次失败，重新观察并规划：${state.error ?? "原因未知"}` });
      }
      return save("recover", state, retryCount > maxRetries
        ? { retryCount, status: "failed", verificationPending: false,
          recentHistory: history(state, state.lastVerification),
          approvedActionFingerprint: undefined, resumePendingAction: false,
          error: state.error ?? "已达到重试上限" }
        : { retryCount, verificationPending: false,
          recentHistory: history(state, state.lastVerification),
          approvedActionFingerprint: undefined, resumePendingAction: false });
    }))
    .addNode("human_interrupt", timed("human_interrupt", "human", "人工确认", async (state: ComputerState) => {
      if (!checkpointer) return new Command({
        update: save("human_interrupt", state, { status: "waiting_user",
          error: state.lastAction?.kind === "ask_user" ? state.lastAction.question : state.error }),
        goto: END,
      });
      if (state.finalReviewPending) {
        const response = interrupt({ kind: "final_review", taskId: state.taskId,
          question: `请确认当前画面确已完成目标：${state.taskContract?.target ?? state.goal}` }) as { approved?: boolean };
        if (response?.approved === true) {
          return new Command({ update: save("final_review", state, {
            status: "done", finalReviewPending: false, error: undefined,
            humanReview: { approved: true, note: '用户确认当前目标画面',
              reviewedAt: new Date().toISOString(),
              observationId: observationSignature(state.observation) ?? '' },
            summary: '人工确认完成；自动验证结果保持原样' }), goto: END });
        }
        return new Command({ update: save("final_review", state, {
          status: "running", finalReviewPending: false, goalVerification: undefined,
          completedStages: state.completedStages?.slice(0, -1),
          error: "人工未确认目标画面，重新规划" }), goto: "observe" });
      }
      const action = state.lastAction!;
      const response = interrupt(action.kind === "ask_user"
        ? { kind: "question", taskId: state.taskId, question: action.question }
        : { kind: "approval", taskId: state.taskId, action,
          question: "是否批准执行此动作？" }) as { approved?: boolean; answer?: string };
      if (action.kind === "ask_user") {
        const answer = response?.answer?.trim();
        return answer ? new Command({
          update: save("human_interrupt", state, { status: "running", userAnswer: answer, recoveryUncertain: false, inFlightAction: undefined, error: undefined }),
          goto: "observe",
        }) : new Command({
          update: save("human_interrupt", state, { status: "failed", error: "未收到有效回答" }),
          goto: "finish",
        });
      }
      return response?.approved === true ? new Command({
        update: save("human_interrupt", state, { status: "running",
          approvedActionFingerprint: JSON.stringify(action), resumePendingAction: true,
          error: undefined }),
        goto: "observe",
      }) : new Command({
        update: save("human_interrupt", state, { status: "failed", error: "用户拒绝执行高风险动作" }),
        goto: "finish",
      });
    }), { ends: ["observe", "finish", END] })
    .addNode("finish", timed("finish", "system", "结束规则", async (state) => {
      // Legacy/manual checkpoints may predate the acceptance chain; never trust their old ok flag alone.
      if (acceptanceVerifier && state.status !== 'failed' && state.goalVerification?.ok && !state.acceptanceReport) {
        const {result, report} = await complete(state);
        if (!result.ok) return save('finish', state, {...blockedAcceptance(report,state), goalVerification:result});
      }
      const action = state.lastAction;
      const update: Partial<ComputerState> = state.status === "failed" ? {} : state.goalVerification?.ok ? {
        status: "done", summary: action?.kind === "done" ? action.summary : state.summary,
      } : { status: "failed", error: "任务尚未通过独立完成验证" };
      return save("finish", state, update);
    }))
    .addEdge(START, "observe")
    .addConditionalEdges("observe", (state) => state.status === "paused" ? "pause_interrupt" : state.observationFailed
      ? focusLost(state) && runtime.recoverFocus ? "focus_recover" : "recover"
      : state.verificationPending ? "verify"
      : state.resumePendingAction ? "ground" : "pause_check")
    .addConditionalEdges("focus_recover", (state) => state.status === "paused" ? "pause_interrupt"
      : state.status === "failed" ? "finish" : "observe")
    .addConditionalEdges("pause_check", (state) => state.status === "paused" ? "pause_interrupt"
      : state.resumeReconcile && (state.recoveryUncertain || state.workflowRef || !state.taskContract)
        ? "resume_reconcile" : state.taskContract ? "stage_check" : "decide")
    .addConditionalEdges("resume_reconcile", (state) => state.status === "waiting_user" ? "human_interrupt"
      : state.status === "paused" ? "pause_interrupt"
      : state.status === "failed" ? "finish"
      : state.goalVerification?.ok ? "finish" : state.taskContract ? "stage_check" : "decide")
    .addConditionalEdges("stage_check", (state) => state.status === "waiting_user" && !state.finalReviewPending ? END : state.status === "paused" ? "pause_interrupt"
      : state.status === "failed" ? "finish"
      : state.finalReviewPending ? "human_interrupt"
      : state.goalVerification?.ok ? "finish"
      : state.stageCheckNeedsObserve ? "observe"
      : state.stage ? "decide" : "stage_plan")
    .addConditionalEdges("stage_plan", (state) => state.status === "paused" ? "pause_interrupt"
      : state.status === "failed" ? "finish" : "stage_check")
    .addConditionalEdges("pause_before_execute", (state) => state.status === "paused" ? "pause_interrupt" : "risk_check")
    .addConditionalEdges("decide", (state) => {
      if (state.status === "paused") return "pause_interrupt";
      if (state.status === "failed") return "finish";
      if (state.lastResult?.ok === false) return "recover";
      if (state.lastAction?.kind === "done") return state.taskContract ? "stage_check" : "verify_task";
      if (state.lastAction?.kind === "ask_user") return "human_interrupt";
      return "ground";
    })
    .addConditionalEdges("ground", (state) => state.lastResult?.ok === false
      ? focusLost(state) && runtime.recoverFocus ? "focus_recover" : "recover" : "resolve_action")
    .addConditionalEdges("resolve_action", (state) => state.lastResult?.ok === false
      ? focusLost(state) && runtime.recoverFocus ? "focus_recover" : "recover" : "pause_before_execute")
    .addConditionalEdges("risk_check", (state) => state.status === "waiting_user" ? "human_interrupt" : "execute")
    .addConditionalEdges("execute", (state) => state.status === "paused" ? "pause_interrupt" : "observe")
    .addConditionalEdges("verify", (state) => state.lastVerification?.ok ? "pause_check" : "recover")
    .addConditionalEdges("verify_task", (state) => state.status === "paused" ? "pause_interrupt" : state.status === "waiting_user" ? END : state.status === "failed" ? "finish" : state.goalVerification?.ok ? "finish" : "recover")
    .addConditionalEdges("recover", (state) => state.status === "failed" ? "finish" : "observe")
    .addConditionalEdges("finish", (state) => state.status === 'paused' ? 'pause_interrupt' : END);

  // 每个动作跨越多个节点，默认的 25 次图迭代不足以覆盖多步网页任务。
  return graph.compile(checkpointer ? { checkpointer } : {}).withConfig({
    recursionLimit: Math.max(25, maxSteps * 12 + 12),
  });
}
