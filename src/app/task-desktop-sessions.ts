import type { DesktopProvider, DesktopSession } from '../contracts/desktop-environment.js';
import type { InputControl } from '../contracts/desktop-provider.js';
import type { WorkerClient } from '../contracts/worker-client.js';
import type { TaskDesktopFields, TaskDesktopTarget } from '../contracts/task-desktop.js';
import { desktopTarget, desktopExecutionBinding, sameDesktopTarget, sameDesktopBinding,
  validateTaskDesktop } from '../contracts/task-desktop.js';

/** Composition port for the existing desktop executor. New executor routing is P5-B. */
export interface DesktopTaskExecutor {
  taskControl(session: DesktopSession): InputControl;
  connectRuntime(session: DesktopSession, artifactDir: string): Promise<WorkerClient>;
  /** Infrastructure's lifecycle owner, separate from the per-Task control shim. */
  lifecycleOwner?(session: DesktopSession): object;
  /** Complete a manually reviewed outcome after input has already been released. */
  completeTask?(session: DesktopSession, taskId: string): Promise<void>;
}
interface Entry { session: DesktopSession; executor: DesktopTaskExecutor; control: InputControl;
  binding: NonNullable<TaskDesktopFields['desktopExecutionBinding']>; lifecycleOwner?: object; }
export class TaskDesktopSessions {
  private readonly providers = new Map<string, DesktopProvider>();
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  private closing?: Promise<void>;
  private readonly executors: ReadonlyMap<string, DesktopTaskExecutor>;
  constructor(providers: readonly DesktopProvider[], executors: ReadonlyMap<string, DesktopTaskExecutor>) {
    this.executors = new Map(executors);
    for (const provider of providers) {
      if (this.providers.has(provider.id)) throw new Error('duplicate-desktop-provider');
      this.providers.set(provider.id, provider);
    }
  }
  assertTarget(value: TaskDesktopTarget): TaskDesktopTarget {
    if (this.closed) throw new Error('task-desktop-sessions-closed');
    if (!value) throw new Error('invalid-desktop-target');
    const target = desktopTarget(value.providerId, value.environmentId);
    if (!this.providers.has(target.providerId)) throw new Error('unknown-desktop-provider');
    if (!this.executors.has(target.providerId)) throw new Error('desktop-task-executor-unavailable');
    return target;
  }
  acquire(taskId: string, fields: TaskDesktopFields,
    persist: (binding: NonNullable<TaskDesktopFields['desktopExecutionBinding']>) => void): Promise<Entry> {
    const operation = this.acquireBody(taskId, fields, persist);
    this.pending.add(operation);
    return operation.finally(() => { this.pending.delete(operation); });
  }
  private async acquireBody(taskId: string, requested: TaskDesktopFields,
    persist: (binding: NonNullable<TaskDesktopFields['desktopExecutionBinding']>) => void): Promise<Entry> {
    validateTaskDesktop(requested);
    const fields: TaskDesktopFields = { ...requested,
      desktopTarget: requested.desktopTarget && desktopTarget(requested.desktopTarget.providerId, requested.desktopTarget.environmentId),
      desktopExecutionBinding: requested.desktopExecutionBinding && desktopExecutionBinding(requested.desktopExecutionBinding) };
    if (!fields.desktopTarget) throw new Error('desktop-target-required');
    const target = this.assertTarget(fields.desktopTarget);
    let entry = this.entries.get(taskId);
    if (fields.desktopExecutionBinding) {
      // Never open another Session to stand in for a durable execution binding.
      if (!entry || !sameDesktopBinding(fields.desktopExecutionBinding, entry.session)) {
        throw new Error('desktop-binding-unavailable: explicitly submit a new task');
      }
    } else if (!entry) {
      const provider = this.providers.get(target.providerId)!;
      const environments = await provider.discover();
      if (this.closed) throw new Error('task-desktop-sessions-closed');
      if (!environments.some(env => sameDesktopTarget(target, env))) throw new Error('unknown-desktop-environment');
      const session = await provider.open(target.environmentId);
      try {
        if (this.closed) throw new Error('task-desktop-sessions-closed');
        const binding = desktopExecutionBinding(session);
        if (!sameDesktopTarget(target, binding)) throw new Error('desktop-target-binding-mismatch');
        if ((await session.status()).state !== 'open') throw new Error('stale-desktop-binding');
        if (this.closed) throw new Error('task-desktop-sessions-closed');
        const executor = this.executors.get(target.providerId)!;
        entry = { session, executor, control: executor.taskControl(session), binding,
          lifecycleOwner: executor.lifecycleOwner?.(session) };
        persist(binding); // Before input ownership, planning, window discovery, or runtime construction.
        this.entries.set(taskId, entry);
      } catch (error) {
        try { await session.close(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'desktop-binding-cleanup-failed'); }
        throw error;
      }
    }
    if (!entry || !sameDesktopTarget(target, entry.session) || !sameDesktopBinding(entry.binding, entry.session) ||
        (await entry.session.status()).state !== 'open') throw new Error('stale-desktop-binding');
    if (!sameDesktopBinding(entry.binding, entry.session) ||
        fields.desktopExecutionBinding && !sameDesktopBinding(fields.desktopExecutionBinding, entry.session)) {
      throw new Error('desktop-binding-identity-changed');
    }
    if (this.closed) throw new Error('task-desktop-sessions-closed');
    return entry;
  }
  control(taskId: string, expected?: NonNullable<TaskDesktopFields['desktopExecutionBinding']>): InputControl {
    if (this.closed) throw new Error('task-desktop-sessions-closed');
    const entry = this.entries.get(taskId);
    if (!entry) throw new Error('desktop-binding-unavailable');
    if (!sameDesktopBinding(entry.binding, entry.session) || expected && !sameDesktopBinding(expected, entry.binding)) {
      throw new Error('desktop-binding-identity-changed');
    }
    return entry.control;
  }
  usesControl(taskId: string, owner: object): boolean {
    const entry = this.entries.get(taskId);
    return !!entry && (entry.control === owner || entry.lifecycleOwner === owner);
  }
  async completeTask(taskId: string, expected: NonNullable<TaskDesktopFields['desktopExecutionBinding']>): Promise<void> {
    this.control(taskId, expected);
    const entry = this.entries.get(taskId)!;
    if ((await entry.session.status()).state !== 'open') throw new Error('stale-desktop-binding');
    this.control(taskId, expected);
    if (!entry.executor.completeTask) throw new Error('desktop-task-completion-unavailable');
    await entry.executor.completeTask(entry.session, taskId);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    return this.closing = (async () => {
      // Late opens must finish their own close before lifecycle teardown acknowledges.
      const pending = await Promise.allSettled([...this.pending]);
      const results = await Promise.allSettled([...this.entries.values()].map(entry => entry.session.close()));
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      for (const result of pending) {
        if (result.status === 'rejected' && result.reason instanceof AggregateError) errors.push(result.reason);
      }
      if (errors.length) throw new AggregateError(errors, 'Task Desktop Session cleanup failed');
    })();
  }
}
