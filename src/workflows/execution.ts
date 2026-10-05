import type { Workflow, WorkflowInputValue } from './schema.js';
import { instantiateWorkflow } from './matcher.js';
import { workflowDigest } from './recovery.js';
import { applyWorkflowInputs } from './parameterization.js';
import { validateDurableContract } from './durable-contract.js';
import type { ComputerState } from '../graph/state.js';
import { verifyGoal } from '../verifier/verifier.js';
import type { WindowInfo } from '../runtime/desktop/desktop-runtime.js';
import {auditGoalFileCoverage} from '../verification/goal-file-coverage.js';
import { verifyWorkflowStep } from './distill.js';

/** A stage verdict is not proof that every replay step finished. */
export function stageReplaySucceeded(state: ComputerState, workflow: Workflow): boolean {
  const replay = state.workflowReplayState;
  if (workflow.scope !== 'stage' || state.lastStageVerification?.ok !== true ||
      state.humanReview?.approved || !replay || replay.exploring ||
      replay.nextIndex !== workflow.steps.length || !state.workflowRef ||
      state.workflowRef.id !== workflow.id || state.workflowRef.version !== workflow.version) return false;
  if (replay.activeIndex === undefined) return true;
  const step = instantiateWorkflow({ workflow, values: state.workflowRef.values, score: 1 })
    .steps[replay.activeIndex];
  return !!step && state.lastResult?.ok === true && state.lastVerification?.ok === true &&
    verifyWorkflowStep(step, state.beforeObservation, state.observation);
}

/** An explicit Workflow can select a single visible window without asking a planner. */
export function explicitWorkflowWindow(workflow: Workflow, windows: readonly WindowInfo[]): WindowInfo | undefined {
  const identity = workflow.preconditions.filter(condition =>
    condition.kind === 'window_title' || condition.kind === 'window_class');
  if (!identity.length) return undefined;
  const matches = windows.filter(window => window.visible && !window.minimized && identity.every(condition =>
    'value' in condition && (condition.kind === 'window_title' ? window.title === condition.value :
      window.windowClass === condition.value)));
  if (matches.length !== 1) throw new Error(`指定流程窗口身份匹配 ${matches.length} 个，必须唯一且可见`);
  return matches[0];
}

/** A fixed sequence with structured targets does not need screenshot model grounding. */
export function explicitWorkflowUsesStructuredTargets(workflow: Workflow): boolean {
  return workflow.steps.every(step => {
    const action = step.action;
    if (action.kind === 'drag') return [action.source, action.destination].every(target =>
      target.kind !== 'vision' && target.kind !== 'coordinate');
    const targets = action.kind === 'click' || action.kind === 'double_click' ||
      action.kind === 'type' || action.kind === 'paste_text' ||
      action.kind === 'scroll' && action.target ? action.target : undefined;
    if (!targets) return true;
    const options = targets.kind === 'candidates' ? targets.options : [targets];
    return options.every(target => target.kind !== 'vision' && target.kind !== 'coordinate');
  });
}

export function explicitReplaySucceeded(state: ComputerState, workflow: Workflow): boolean {
  const replay = state.workflowReplayState;
  return state.status === 'done' && !state.humanReview?.approved && !!replay && !replay.exploring && replay.nextIndex === workflow.steps.length
    && state.lastResult?.ok !== false && state.lastVerification?.ok !== false
    && state.goalVerification?.ok === true
    && verifyGoal(workflow.successConditions, state.observation).ok;
}

export interface WorkflowExecutionRequest {
  id: string;
  version: number;
  definitionHash: string;
  values: Record<string, WorkflowInputValue>;
  /** 目标执行环境；必须与 workflow.environment 一致，不一致在第一步动作前 fail closed。 */
  destination: 'windows' | 'browser';
  trial?: boolean;
}

/** Workflow.environment → 执行路由：仅支持 windows/browser，其余环境拒绝。 */
export function routeWorkflowDestination(workflow: Workflow): 'windows' | 'browser' {
  if (workflow.environment !== 'windows' && workflow.environment !== 'browser') {
    throw new Error(`流程环境 ${workflow.environment} 不受支持`);
  }
  return workflow.environment;
}

/** Explicit execution never selects a different version or falls back to exploration. */
export function prepareWorkflowExecution(original: Workflow | undefined, request: WorkflowExecutionRequest) {
  if (!original || original.id !== request.id || original.version !== request.version) throw new Error('流程版本不存在');
  if (request.destination !== 'windows' && request.destination !== 'browser') throw new Error('指定流程目标环境无效');
  if (request.destination !== original.environment) {
    throw new Error(`流程环境 ${original.environment} 与目标环境 ${request.destination} 不匹配，已在第一步动作前拒绝`);
  }
  if (request.trial !== undefined && typeof request.trial !== 'boolean') throw new Error('试运行标记必须为布尔值');
  if (!(original.status === 'verified' || request.trial && original.status === 'candidate') || original.scope === 'stage' ||
      original.environment !== 'windows' && original.environment !== 'browser') {
    throw new Error('仅支持整任务 Windows/浏览器流程；候选版本须使用试运行，阶段流程需阶段上下文');
  }
  if (workflowDigest(original) !== request.definitionHash) throw new Error('流程定义已变化，请重新预览');
  const names = new Set(original.inputs.map(input => input.name));
  if (!request.values || typeof request.values !== 'object' || Array.isArray(request.values)) throw new Error('参数必须为对象');
  let values: Record<string, WorkflowInputValue>;
  let workflow: Workflow;
  if (original.workflowSchemaVersion === 2) {
    // v2：typed 参数校验（缺参/非有限数/非法布尔/choice 不符/bound stepId 缺失）与
    // boundTo 注入统一在 applyWorkflowInputs 内完成，任何失败都在第一步动作之前拒绝。
    values = structuredClone(request.values);
    workflow = applyWorkflowInputs(original, values);
    // B3-5：持久化契约必须与冻结完成条件对齐；悬空/臆造契约在第一步动作前拒绝。
    const contractViolation = validateDurableContract(workflow);
    if (contractViolation) throw new Error(`持久化契约校验失败：${contractViolation.reason}`);
  } else {
    if (Object.entries(request.values).some(([name, value]) => !names.has(name) ||
        typeof value !== 'string' || !value.trim() || value.length > 300)
      || [...names].some(name => !Object.hasOwn(request.values, name))) throw new Error('请填写全部已声明参数，每项最多 300 字');
    values = structuredClone(request.values);
    workflow = instantiateWorkflow({ workflow: original, values: values as Record<string, string>, score: 1 });
  }
  const declaredFiles=workflow.steps.flatMap(step=>{
    const action=step.action;
    return 'postcondition' in action && action.postcondition?.kind==='desktop_file'
      ?[structuredClone(action.postcondition)]:[];
  });
  // The task-level contract concerns the final state of each Desktop path.
  const requiredFiles=[...new Map(declaredFiles.map(file=>
    [file.path.toLowerCase(),file])).values()];
  const goal = original.taskPattern.replace(/\{\{([a-z][a-z0-9]*)\}\}/gi, (_, name: string) => String(values[name]));
  if (!goal.trim() || goal.length > 3996) throw new Error('流程任务目标为空或过长');
  const coverage=auditGoalFileCoverage(goal,requiredFiles.map(file=>file.path));
  if(!coverage.covered)throw new Error(`原始任务的文件目标未被流程后置条件覆盖：${coverage.reason}`);
  return { workflow, goal: `VM: ${goal}`, ref: { id: original.id, version: original.version,
    values, definitionHash: request.definitionHash, explicit: true as const,
    ...(requiredFiles.length?{requiredFiles}:{}), ...(request.trial ? { trial: true } : {}) } };
}
