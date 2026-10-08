import type { DesktopEnvironment, DesktopProvider, DesktopSession } from '../contracts/desktop-environment.js';
import type { RegisteredApp } from '../runtime/desktop/app-catalog.js';
import type { InputControl } from '../contracts/desktop-provider.js';
import type { WorkerClient } from '../contracts/worker-client.js';
import type { AppRuntimeTarget } from '../contracts/app-launch.js';
import type { EnvironmentAppBinding } from '../contracts/environment-apps.js';
import type { DesktopScenarioDefinition, DesktopScenarioOption, PreparedDesktopScenario } from '../contracts/desktop-scenario.js';
import type { TaskDesktopFields, TaskDesktopTarget } from '../contracts/task-desktop.js';
import { desktopTarget, desktopExecutionBinding, sameDesktopTarget, sameDesktopBinding,
  validateTaskDesktop } from '../contracts/task-desktop.js';

/** Private, live launch receipt; never serialized as Task/model input or input authority. */
export interface TaskAppRuntimeBinding {
  readonly profile: EnvironmentAppBinding;
  readonly target: AppRuntimeTarget;
}
/** Composition-owned executor; core never selects a backend from goal text or Provider kind. */
export interface DesktopTaskExecutor {
  /** Fail before opening a Session when this executor cannot admit a generic Task. */
  assertAvailable?(): void;
  scenario?(target: TaskDesktopTarget, id: string): DesktopScenarioDefinition;
  scenarios?(target: TaskDesktopTarget): readonly DesktopScenarioOption[];
  prepareScenario?(session: DesktopSession, artifactDir: string, id: string): Promise<PreparedDesktopScenario>;
  appCatalog?(): Promise<RegisteredApp[]>;
  taskControl(session: DesktopSession): InputControl;
  connectRuntime(session: DesktopSession, artifactDir: string): Promise<WorkerClient>;
  /** Resolve targetToken against the launch issuer's private live records, and prove
   * installation contents, argv/cwd, process/window lifetime and this Session's
   * Windows session/desktop. Return an already-bound, target-scoped Worker.
   * Every operation must revalidate; effects must fence identity atomically at
   * dispatch. PID/HWND/path equality alone is insufficient. attach/restore must
   * never substitute a target; ensureApp cannot launch one. close drains normally.
   * Missing proof/capability must throw, with no generic connectRuntime fallback.
   * Connection/binding is read-only (no focus/input). The existing Task control
   * remains mandatory before any effect; this receipt grants no input authority. */
  connectAppRuntime?(session: DesktopSession, artifactDir: string, binding: TaskAppRuntimeBinding): Promise<WorkerClient>;
  /** Infrastructure's lifecycle owner, separate from the per-Task control shim. */
  lifecycleOwner?(session: DesktopSession): object;
  /** Complete a manually reviewed outcome after input has already been released. */
  completeTask?(session: DesktopSession, taskId: string): Promise<void>;
}
export interface TaskDesktopOption extends DesktopEnvironment {
  /** Generic Task/Workflow compatibility only; not live Session/target readiness. */
  readonly executable: boolean;
  readonly blockedReason?: string;
  readonly scenarios?: readonly DesktopScenarioOption[];
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
    this.executors.get(target.providerId)!.assertAvailable?.();
    return target;
  }
  assertScenario(value: TaskDesktopTarget, id: string): DesktopScenarioDefinition {
    if (this.closed) throw new Error('task-desktop-sessions-closed');
    if (!value) throw new Error('invalid-desktop-target');
    const target = desktopTarget(value.providerId, value.environmentId);
    if (!this.providers.has(target.providerId)) throw new Error('unknown-desktop-provider');
    const executor = this.executors.get(target.providerId);
    if (!executor?.scenario || !executor.prepareScenario) throw new Error('desktop-scenario-unavailable');
    const definition = executor.scenario(target, id);
    if (!definition || definition.id !== id || typeof definition.goal !== 'string' || !definition.goal.trim()) {
      throw new Error('invalid-desktop-scenario-definition');
    }
    return Object.freeze({ id: definition.id, goal: definition.goal });
  }
  /** Discovery is read-only: it never opens Sessions, claims input or constructs runtimes. */
  async discover(): Promise<readonly TaskDesktopOption[]> {
    if (this.closed) throw new Error('task-desktop-sessions-closed');
    const options = await Promise.all([...this.providers.values()].map(async provider => {
      const environments = await provider.discover();
      return environments.map(environment => {
        if (environment.providerId !== provider.id || environment.kind !== provider.kind) {
          throw new Error('desktop-discovery-identity-mismatch');
        }
        const target = desktopTarget(environment.providerId, environment.environmentId);
        const catalog = this.executors.get(provider.id)?.scenarios?.(target);
        const seen = new Set<string>();
        const scenarios = catalog?.map(item => {
          if (!item.id || seen.has(item.id) || !item.label ||
              !['supported', 'unavailable', 'unsupported', 'not-proven'].includes(item.availability)) {
            throw new Error('invalid-desktop-scenario-catalog');
          }
          seen.add(item.id);
          if (item.availability === 'supported') {
            try { this.assertScenario(target, item.id); }
            catch { return Object.freeze({ ...item, availability: 'unavailable' as const, reason: 'desktop-scenario-unavailable' }); }
          }
          return Object.freeze({ ...item });
        });
        const catalogFields = scenarios ? { scenarios: Object.freeze(scenarios) } : {};
        try { this.assertTarget(target); return Object.freeze({ ...target, kind: environment.kind, executable: true, ...catalogFields }); }
        catch (error) { return Object.freeze({ ...target, kind: environment.kind, executable: false,
          blockedReason: error instanceof Error ? error.message : 'desktop-task-executor-unavailable', ...catalogFields }); }
      });
    }));
    if (this.closed) throw new Error('task-desktop-sessions-closed');
    const environments = options.flat();
    const keys = environments.map(item => JSON.stringify([item.providerId, item.environmentId]));
    if (new Set(keys).size !== keys.length) throw new Error('duplicate-desktop-environment');
    return Object.freeze(environments);
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
    if (fields.desktopScenario !== undefined) this.assertScenario(fields.desktopTarget, fields.desktopScenario);
    const target = fields.desktopScenario === undefined ? this.assertTarget(fields.desktopTarget) : fields.desktopTarget;
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
