/** Task selection is separate from runtime-owned window/observation targets. */
export interface TaskDesktopTarget {
  readonly providerId: string;
  readonly environmentId: string;
}
export interface TaskDesktopExecutionBinding extends TaskDesktopTarget {
  readonly sessionId: string;
  readonly instanceId: string;
}
export interface TaskDesktopFields {
  readonly taskBindingVersion?: 1;
  readonly desktopTarget?: TaskDesktopTarget;
  readonly desktopExecutionBinding?: TaskDesktopExecutionBinding;
  readonly desktopCompatibility?: {
    readonly source: 'legacy-route';
    readonly environment: 'windows' | 'agent_desktop';
    readonly desktopVmId?: string;
  };
}
const keys = ['providerId', 'environmentId', 'sessionId', 'instanceId'] as const;
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}
export function desktopTarget(providerId: string, environmentId: string): TaskDesktopTarget {
  if (!identifier(providerId) || !identifier(environmentId)) throw new Error('invalid-desktop-target');
  return Object.freeze({ providerId, environmentId });
}
export function desktopExecutionBinding(value: TaskDesktopExecutionBinding): TaskDesktopExecutionBinding {
  if (!value || keys.some(key => !identifier(value[key]))) throw new Error('invalid-desktop-binding');
  return Object.freeze({ ...desktopTarget(value.providerId, value.environmentId),
    sessionId: value.sessionId, instanceId: value.instanceId });
}
export function sameDesktopTarget(a: TaskDesktopTarget, b: TaskDesktopTarget): boolean {
  return a.providerId === b.providerId && a.environmentId === b.environmentId;
}
export function sameDesktopBinding(a: TaskDesktopExecutionBinding, b: TaskDesktopExecutionBinding): boolean {
  return keys.every(key => a[key] === b[key]);
}
export function validateTaskDesktop(fields: TaskDesktopFields): void {
  if (fields.taskBindingVersion !== undefined && fields.taskBindingVersion !== 1) throw new Error('invalid-task-binding-version');
  if (fields.desktopTarget !== undefined) {
    if (!fields.desktopTarget) throw new Error("invalid-desktop-target");
    desktopTarget(fields.desktopTarget.providerId, fields.desktopTarget.environmentId);
  }
  if (fields.desktopExecutionBinding !== undefined) {
    desktopExecutionBinding(fields.desktopExecutionBinding);
    if (!fields.desktopTarget || !sameDesktopTarget(fields.desktopTarget, fields.desktopExecutionBinding)) {
      throw new Error('desktop-target-binding-mismatch');
    }
  }
  if (fields.desktopCompatibility !== undefined) {
    const value = fields.desktopCompatibility;
    if (!value || value.source !== 'legacy-route' || !['windows', 'agent_desktop'].includes(value.environment) ||
        value.desktopVmId !== undefined && !identifier(value.desktopVmId) ||
        !fields.desktopTarget || fields.taskBindingVersion !== 1) throw new Error('invalid-desktop-compatibility');
  }
  if (fields.desktopTarget && fields.taskBindingVersion !== 1) throw new Error('missing-task-binding-version');
}
/** Durable writes and checkpoint reducers must never erase or replace selection/binding. */
export function assertTaskDesktopUnchanged(previous: TaskDesktopFields, next: TaskDesktopFields): void {
  validateTaskDesktop(next);
  for (const key of ['taskBindingVersion', 'desktopTarget', 'desktopExecutionBinding', 'desktopCompatibility'] as const) {
    if (previous[key] !== undefined && JSON.stringify(previous[key]) !== JSON.stringify(next[key])) {
      throw new Error(`immutable-task-${key}`);
    }
  }
  if (previous.taskBindingVersion === undefined && !previous.desktopTarget && next.desktopTarget &&
      !next.desktopCompatibility) throw new Error('explicit-desktop-compatibility-required');
  if (previous.taskBindingVersion === 1 && !previous.desktopCompatibility && next.desktopCompatibility) {
    throw new Error('immutable-task-desktopCompatibility');
  }
  if (previous.taskBindingVersion === 1 && !previous.desktopTarget && next.desktopTarget) {
    throw new Error('immutable-task-desktopTarget');
  }
}
export function taskDesktopFields(fields: TaskDesktopFields): TaskDesktopFields {
  return { taskBindingVersion: fields.taskBindingVersion, desktopTarget: fields.desktopTarget,
    desktopExecutionBinding: fields.desktopExecutionBinding, desktopCompatibility: fields.desktopCompatibility };
}
