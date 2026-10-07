import type { DesktopSession } from '../contracts/desktop-environment.js';
import type { InputAuthority } from '../contracts/desktop-input-control.js';
import type { InputControl } from '../contracts/desktop-provider.js';
import type { WorkerClient } from '../contracts/worker-client.js';
import type { PhysicalInputPolicy } from '../runtime/desktop/desktop-runtime.js';
import type { DesktopTaskExecutor } from '../app/task-desktop-sessions.js';
import { PhysicalDesktopProvider, type PhysicalInputArbiter } from './physical-provider.js';

interface Claim { taskId?: string; lastTaskId?: string; authority?: InputAuthority; runtime?: WorkerClient;
  releasing?: Promise<boolean>; heartbeat?: NodeJS.Timeout; heartbeatFailure?: unknown; }

/** Bridges Tasks to the managed Physical runtime. Never uses legacy DesktopRuntime.attach. */
export class PhysicalTaskExecutor implements DesktopTaskExecutor {
  private readonly claims = new WeakMap<DesktopSession, Claim>();
  private readonly permitted: boolean;
  constructor(private readonly provider: PhysicalDesktopProvider, private readonly input: PhysicalInputArbiter,
    policy: PhysicalInputPolicy = { windowManagement: false, executors: [] }) {
    this.permitted = policy.windowManagement && policy.executors.length > 0;
  }
  assertAvailable(): void {
    if (!this.permitted) throw new Error('physical-task-policy-required');
  }
  appCatalog() { return Promise.resolve([]); } // No Guest catalog or arbitrary application launch on the host.
  taskControl(session: DesktopSession): InputControl {
    this.assertAvailable();
    if (this.claims.has(session)) throw new Error('physical-task-control-already-created');
    const claim: Claim = {}; this.claims.set(session, claim);
    return {
      workerEndpoint: () => '',
      assertTaskAllowed: taskId => {
        if (!taskId || claim.taskId !== taskId || !claim.authority || claim.releasing || claim.heartbeatFailure) throw new Error('physical-task-input-not-owned');
        this.input.assertAuthority(session, claim.authority);
      },
      beginTask: async taskId => {
        if (!taskId || claim.taskId || claim.releasing) throw new Error('physical-task-input-busy');
        claim.taskId = taskId;
        try {
          claim.authority = await this.input.acquire(session, { kind: 'agent', clientId: taskId });
          claim.lastTaskId = taskId; claim.heartbeatFailure = undefined;
        } catch (error) { claim.taskId = undefined; throw error; }
      },
      finishTask: (taskId) => {
        if (claim.taskId !== taskId) throw new Error('foreign-task');
        clearInterval(claim.heartbeat); claim.heartbeat = undefined;
        // revokeSession also handles expired authority; a lost revoke ACK remains resource-blocking.
        return claim.releasing ??= (async () => {
          await this.input.revokeSession(session);
          await claim.runtime?.close();
          claim.runtime = undefined; claim.authority = undefined; claim.taskId = undefined;
          claim.releasing = undefined;
          return false;
        })();
      },
    };
  }
  async connectRuntime(session: DesktopSession, artifactDir: string): Promise<WorkerClient> {
    const claim = this.claims.get(session);
    if (!claim?.authority || !claim.taskId || claim.releasing || claim.runtime) throw new Error('physical-task-input-not-owned');
    const authority = claim.authority;
    this.input.assertAuthority(session, authority);
    let boundClosing = false;
    const stopHeartbeat = () => { clearInterval(claim.heartbeat); claim.heartbeat = undefined; };
    const bound = await this.provider.connectRuntime(session, authority, artifactDir, () => { boundClosing = true; stopHeartbeat(); });
    try {
      if (claim.authority !== authority || claim.releasing) throw new Error('physical-task-input-not-owned');
      this.input.assertAuthority(session, authority);
      await bound.heartbeat(); // Reject older backends before planning or any input.
      if (boundClosing || claim.authority !== authority || claim.releasing) throw new Error('physical-task-input-not-owned');
      this.input.assertAuthority(session, authority);
      const runtime: WorkerClient = {
        listWindows: filter => bound.listWindows(filter),
        ensureApp: async () => { throw new Error('physical-task-app-launch-unavailable'); },
        attach: options => bound.attach(options), observe: capture => bound.observe(capture),
        probe: focus => bound.probe(focus), recoverFocus: () => bound.recoverFocus(),
        ground: action => bound.ground(action), resolveAction: action => bound.resolveAction(action),
        execute: (action, resolution) => bound.execute(action, resolution),
        restore: observation => bound.restore(observation), close: () => bound.close(),
      };
      claim.runtime = runtime;
      let pending = false;
      claim.heartbeat = setInterval(() => {
        if (pending || claim.authority !== authority || claim.releasing) return;
        pending = true;
        void bound.heartbeat().catch(async error => {
          claim.heartbeatFailure = error; stopHeartbeat();
          try { await bound.close(); }
          catch (cleanup) { claim.heartbeatFailure = new AggregateError([error, cleanup], 'physical-task-heartbeat-cleanup-failed'); }
        })
          .finally(() => { pending = false; });
      }, 1000);
      claim.heartbeat.unref();
      return runtime;
    } catch (error) {
      try { await bound.close(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'physical-task-setup-cleanup-failed'); }
      throw error;
    }
  }
  async completeTask(session: DesktopSession, taskId: string): Promise<void> {
    const claim = this.claims.get(session);
    if (!claim || claim.taskId || claim.authority || claim.releasing || claim.lastTaskId !== taskId) throw new Error('foreign-task');
    if ((await session.status()).state !== 'open') throw new Error('stale-desktop-binding');
    if (claim.taskId || claim.authority || claim.releasing || claim.lastTaskId !== taskId) throw new Error('foreign-task');
  }
}
