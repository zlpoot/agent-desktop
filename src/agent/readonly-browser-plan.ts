import { createHash } from 'node:crypto';
import type { ComputerState } from '../graph/state.js';
import type { CompletionCriteria } from '../verifier/verifier.js';
import type { PlannedVerificationContract } from './task-planner.js';
import type { ComputerAction } from '../actions/schema.js';

type TaskContract = NonNullable<ComputerState['taskContract']>;
const prefix = 'readonly-browser/v1:';
const actions: ComputerAction['kind'][] = ['navigate', 'done', 'wait', 'ask_user'];

/** Trusted application input only: the source explicitly attests these requirements cover the whole goal. */
export interface ReadonlyBrowserTask {
  sourceId: string;
  goal: string;
  scope: 'complete-task';
  url: string;
  title: string;
  marker: string;
  allowedActions: readonly ComputerAction['kind'][];
}

function exactActions(value: readonly string[] | undefined): boolean {
  return Array.isArray(value) && value.length === actions.length && new Set(value).size === actions.length
    && actions.every(action => value.includes(action));
}
function validIdentity(url: unknown, title: unknown, marker: unknown): boolean {
  if (typeof url !== 'string' || url.length > 200 || typeof title !== 'string' || title.length < 2
    || title.trim().length < 2 || title.length > 185 || /[<>&]/.test(title) || typeof marker !== 'string'
    || marker.trim().length < 2 || marker.length > 200) return false;
  try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol)
    && parsed.href === url && !parsed.username && !parsed.password && !parsed.hash; } catch { return false; }
}
function identityId(sourceId: string, goal: string, url: string, title: string, marker: string): string {
  // Integrity descriptor, authored at the trusted Task boundary; not an authentication credential.
  return prefix + encodeURIComponent(sourceId) + ':' + createHash('sha256')
    .update(JSON.stringify({ sourceId, goal, scope: 'complete-task', url, title, marker, actions })).digest('hex');
}

/** Reuses existing Task/verification fields; no model-provided field may establish this opt-in. */
export function prepareReadonlyBrowserTask(goal: string, request: ReadonlyBrowserTask) {
  if (!request || Object.keys(request).some(key =>
    !['sourceId', 'goal', 'scope', 'url', 'title', 'marker', 'allowedActions'].includes(key))
    || typeof goal !== 'string' || !goal.trim() || goal.length > 4000 || request.goal !== goal
    || request.scope !== 'complete-task' || typeof request.sourceId !== 'string' || !request.sourceId.trim()
    || request.sourceId.length > 200 || !exactActions(request.allowedActions)
    || !validIdentity(request.url, request.title, request.marker)) throw Error('readonly-browser-invalid-opt-in');
  const verificationContract: PlannedVerificationContract = { goal,
    successConditions: { urlIncludes: request.url, domIncludes: `<title>${request.title}</title>`, pageTextIncludes: request.marker },
    evidenceSources: { urlIncludes: 'browser', domIncludes: 'dom', pageTextIncludes: 'dom' },
    verifierStrategy: 'rules_then_jev' };
  const taskContract: TaskContract = { target: goal, environment: 'browser', stageActionLimit: 24, taskActionLimit: 80,
    profileId: identityId(request.sourceId, goal, request.url, request.title, request.marker),
    constraint: '只读完整任务：仅导航到冻结 URL、读取观察或完成/等待/询问；禁止其他地址、输入、下载、登录、写入和 Native/VM 操作',
    allowedActions: [...actions] };
  return { environment: 'browser' as const, plan: ['只读打开指定网页并读取、报告标题及正文唯一标记'],
    completionCriteria: verificationContract.successConditions, verificationContract, taskContract };
}

function sameCriteria(actual: CompletionCriteria | undefined, expected: CompletionCriteria): boolean {
  return !!actual && Object.keys(actual).length === 3
    && (['urlIncludes', 'domIncludes', 'pageTextIncludes'] as const).every(key => actual[key] === expected[key]);
}

/** Reads only structured frozen fields and their host-bound identity, never the wording of goal. */
export function readonlyBrowserIdentity(goal: string, frozen?: PlannedVerificationContract, task?: TaskContract) {
  if (!frozen || !task || task.environment !== 'browser' || task.target !== goal || frozen.goal !== goal
    || !exactActions(task.allowedActions) || frozen.verifierStrategy !== 'rules_then_jev') return;
  const url = frozen.successConditions?.urlIncludes, marker = frozen.successConditions?.pageTextIncludes;
  const title = frozen.successConditions?.domIncludes?.match(/^<title>([^<>]+)<\/title>$/)?.[1];
  if (!validIdentity(url, title, marker)) return;
  const source = typeof task.profileId === 'string' && task.profileId.startsWith(prefix)
    ? task.profileId.slice(prefix.length).split(':') : [];
  if (source.length !== 2) return;
  let sourceId: string;
  try { sourceId = decodeURIComponent(source[0]); } catch { return; }
  if (!sourceId.trim() || sourceId.length > 200 ||
    task.profileId !== identityId(sourceId, goal, url!, title!, marker!)) return;
  return { url: url!, title: title!, marker: marker! };
}

export function matchesReadonlyBrowserContract(goal: string, frozen: PlannedVerificationContract | undefined,
  criteria: CompletionCriteria | undefined, task?: TaskContract): boolean {
  const identity = readonlyBrowserIdentity(goal, frozen, task);
  const expected = identity && { urlIncludes: identity.url, domIncludes: `<title>${identity.title}</title>`, pageTextIncludes: identity.marker };
  return !!expected && !!frozen && sameCriteria(criteria, expected) && sameCriteria(frozen.successConditions, expected)
    && Object.keys(frozen.evidenceSources ?? {}).length === 3
    && frozen.evidenceSources.urlIncludes === 'browser' && frozen.evidenceSources.domIncludes === 'dom'
    && frozen.evidenceSources.pageTextIncludes === 'dom';
}

/** Restriction recognition is independent of shortcut eligibility: corruption must never unlock input. */
export function isReadonlyBrowserRestricted(task?: TaskContract): boolean {
  return (typeof task?.profileId === 'string' && task.profileId.startsWith(prefix)) || exactActions(task?.allowedActions);
}

/** Candidate shape only: the controller must check trusted creation records before declaring it legacy. */
export function isLegacyReadonlyBrowserContract(state: Readonly<ComputerState>): boolean {
  const frozen = state.verificationContract;
  return !state.workflowRef?.explicit && !isReadonlyBrowserRestricted(state.taskContract)
    && state.taskContract?.environment !== 'windows' && frozen?.evidenceSources.urlIncludes === 'browser'
    && !!frozen && sameCriteria(state.completionCriteria, frozen.successConditions)
    && Object.keys(frozen.successConditions).length === 3
    && typeof frozen.successConditions.urlIncludes === 'string'
    && /^<title>[^<>]+<\/title>$/.test(frozen.successConditions.domIncludes ?? '')
    && typeof frozen.successConditions.pageTextIncludes === 'string';
}

export function assertReadonlyBrowserAction(state: Readonly<ComputerState>, action: ComputerAction): void {
  // Ambiguous legacy checkpoints are rejected by the controller using creation provenance.
  // Their criteria shape alone cannot establish a restriction on a new generic task.
  if (!isReadonlyBrowserRestricted(state.taskContract)) return;
  if (['done', 'ask_user', 'wait'].includes(action.kind)) return;
  if (matchesReadonlyBrowserContract(state.goal, state.verificationContract, state.completionCriteria, state.taskContract)
    && action.kind === 'navigate' && action.url === state.completionCriteria!.urlIncludes) return;
  throw Error('冻结的单页只读任务只允许导航到指定 URL 或读取报告，禁止其他地址和输入；契约失配需重新显式提交');
}

export function readonlyBrowserStagePlan(state: Readonly<ComputerState>) {
  if (state.step !== 0 || (state.stagePlanVersion ?? 0) !== 0 || state.stage || state.completedStages?.length
    || state.workflowRef || state.workflowReplayState || state.resumeReconcile || state.recoveryRequired
    || state.taskContract?.environment !== 'browser' || state.taskContract.target !== state.goal
    || state.contractCoverage?.covered !== true
    || !matchesReadonlyBrowserContract(state.goal, state.verificationContract, state.completionCriteria, state.taskContract)) return;
  return { goal: '只读打开指定网页，读取并报告网页标题及正文唯一标记',
    successCondition: '最终 URL、DOM title 和正文唯一标记均精确满足冻结的完整任务契约', isFinal: true,
    verification: { requirements: [{ id: 'stage-result', field: 'pageText' as const, source: 'dom' as const }] } };
}
