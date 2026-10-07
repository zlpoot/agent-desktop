import type { DesktopSession } from '../contracts/desktop-environment.js';
import type { InputAuthority } from '../contracts/desktop-input-control.js';
import type { InputControl } from '../contracts/desktop-provider.js';
import type { TaskDesktopTarget } from '../contracts/task-desktop.js';
import type { PreparedDesktopScenario } from '../contracts/desktop-scenario.js';
import type { DesktopTaskExecutor } from '../app/task-desktop-sessions.js';
import { DesktopExecutionAdmission } from './execution-admission.js';
import { LocalWorkspaceDesktopProvider } from './local-workspace-provider.js';

interface Claim {
  taskId?: string;
  authority?: InputAuthority;
  preparing?: boolean;
  closed?: boolean;
  claiming?: boolean;
  prepared?: PreparedDesktopScenario;
  releasing?: Promise<boolean>;
}
/** Finite Task bridge only. Does not expose WorkerClient or a generic action dispatcher. */
export class LocalWorkspaceTaskExecutor implements DesktopTaskExecutor {
  private readonly claims = new WeakMap<DesktopSession, Claim>();
  constructor(private readonly provider: LocalWorkspaceDesktopProvider) {}
  assertAvailable(): never { throw new Error('desktop-task-executor-unavailable'); }
  connectRuntime(): never { throw new Error('desktop-task-executor-unavailable'); }
  scenario(target: TaskDesktopTarget, id: string) {
    if (target.providerId !== this.provider.id) throw new Error('desktop-target-binding-mismatch');
    return this.provider.scenario(target.environmentId, id);
  }
  taskControl(session: DesktopSession): InputControl {
    if (this.claims.has(session)) throw new Error('local-workspace-task-control-already-created');
    const claim: Claim = {}; this.claims.set(session, claim);
    return {
      workerEndpoint: () => '',
      assertTaskAllowed: taskId => {
        if (!taskId || taskId !== claim.taskId || !claim.authority || claim.releasing) throw new Error('local-workspace-task-input-not-owned');
        this.provider.inputControl.assertAuthority(session, claim.authority);
      },
      beginTask: async taskId => {
        if (!taskId || !claim.prepared || claim.closed || claim.claiming || claim.taskId || claim.releasing) throw new Error('local-workspace-task-not-prepared');
        claim.claiming = true;
        try {
          // Re-evaluate immediately before acquire; preparation does not cache authorization.
          await claim.prepared.preflight();
          if (claim.closed) throw new Error('local-workspace-task-not-prepared');
          claim.authority = await this.provider.inputControl.acquire(session, { kind: 'agent', clientId: taskId });
          claim.taskId = taskId;
        } finally { claim.claiming = false; }
      },
      finishTask: taskId => {
        if (claim.taskId !== taskId) throw new Error('foreign-task');
        return claim.releasing ??= (async () => {
          // Revoke first: in-flight work is fenced synchronously, then drained by P4.
          await this.provider.inputControl.revokeSession(session);
          await claim.prepared?.close();
          claim.authority = undefined; claim.taskId = undefined;
          return false;
        })();
      },
    };
  }
  async prepareScenario(session: DesktopSession, artifactDir: string, id: string): Promise<PreparedDesktopScenario> {
    this.scenario(session, id);
    const claim = this.claims.get(session);
    if (!claim || claim.closed || claim.prepared || claim.preparing || claim.claiming || claim.authority || claim.releasing) throw new Error('local-workspace-task-not-prepared');
    claim.preparing = true;
    const backend = this.provider.scenarioBackend(session, artifactDir);
    const gate = new DesktopExecutionAdmission(this.provider, session, this.provider.inputControl, backend);
    try {
      const target = await gate.bind(id);
      let observed: Awaited<ReturnType<typeof backend.observe>> | undefined;
      const authority = () => {
        if (!claim.authority || !claim.taskId || claim.releasing) throw new Error('local-workspace-task-input-not-owned');
        this.provider.inputControl.assertAuthority(session, claim.authority);
        return claim.authority;
      };
      const prepared: PreparedDesktopScenario = {
        preflight: () => gate.preflight(target, id),
        observe: async () => { observed = undefined; observed = await backend.observe(authority()); return observed.observation; },
        execute: async () => {
          const capture = observed; observed = undefined;
          if (!capture) throw new Error('fresh-observation-required');
          await gate.execute({ target, action: id, observation: capture.binding, authority: authority() });
        },
        verify: () => backend.verify(authority()),
        close: async () => { claim.closed = true; gate.invalidate(); observed = undefined; await backend.close(); },
      };
      claim.prepared = prepared;
      return prepared;
    } catch (error) {
      gate.invalidate();
      try { await backend.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'local-workspace-scenario-prepare-cleanup-failed'); }
      throw error;
    } finally { claim.preparing = false; }
  }
}
