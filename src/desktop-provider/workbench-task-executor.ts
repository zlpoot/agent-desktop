import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ComputerAction, Observation, ActionResult } from '../actions/schema.js';
import type { DesktopCapabilities, DesktopSession, DesktopSessionIdentity, DesktopReadiness } from '../contracts/desktop-environment.js';
import type { TargetBinding, DesktopExecutionBackend } from '../contracts/desktop-execution.js';
import type { InputAuthority } from '../contracts/desktop-input-control.js';
import type { WorkerClient } from '../contracts/worker-client.js';
import type { EnvironmentAppServices } from '../contracts/environment-apps.js';
import type { DesktopTaskExecutor, TaskAppDispatchBinding } from '../app/task-desktop-sessions.js';
import type { WorkbenchApps } from './workbench-apps.js';
import { ResourceInputControl } from './resource-input-control.js';
import { DesktopExecutionAdmission } from './execution-admission.js';
import { sameSession } from './admission.js';
import { ControlledAppLauncher } from '../environment-apps/launcher.js';

const actions = ['click', 'double_click', 'type', 'paste_text', 'keypress', 'scroll', 'wait', 'screenshot'];
export const WORKBENCH_TASK_PROVIDER = 'hidden-desktop-targeted';
/** Mechanism-scoped implementation support, never universal application compatibility. */
export function workbenchTaskCapabilities(): DesktopCapabilities {
  const scope = { providerId: ['workbench-apps'], environmentKind: ['local-workspace'] } as const;
  const evidence = [{ source: 'src/desktop-provider/workbench_task_runtime.py',
    description: 'Owned launch receipt, registry transaction at effect, bounded UIA/window messages; live compatibility is checked per target.' }];
  const supported = { state: 'supported' as const, scope, evidence };
  return {
    'observation.pixels': [supported], 'observation.accessibility': [supported],
    'control.leaseProtected': [supported],
    'input.targetedWindow': [{ ...supported, scope: { ...scope, action: ['click', 'double_click', 'keypress', 'scroll'], mechanism: ['window-message'] } }],
    'input.semantic': [{ ...supported, scope: { ...scope, action: ['type', 'paste_text'], mechanism: ['uia-value'] } }],
    'input.globalInput': [{ state: 'forbidden', scope }],
    'input.rawIsolated': [{ state: 'forbidden', scope }],
    'control.humanTakeover': [{ state: 'unsupported', scope }],
  };
}
const readiness = (): DesktopReadiness => Object.fromEntries(
  ['observation.pixels', 'observation.accessibility', 'control.leaseProtected', 'input.targetedWindow', 'input.semantic']
    .map(key => [key, { state: 'ready' as const }]));
const identity = (session: DesktopSessionIdentity): DesktopSessionIdentity => ({ providerId: session.providerId,
  environmentId: session.environmentId, sessionId: session.sessionId, instanceId: session.instanceId, inputResourceId: session.inputResourceId });

/** Session handshake is read-only: opening a task binding does not launch an APP. */
export class WorkbenchTaskSession implements DesktopSession {
  readonly providerId: string; readonly environmentId: string; readonly sessionId: string;
  readonly instanceId: string; readonly inputResourceId: string;
  closed = false;
  private closing?: Promise<void>;
  constructor(readonly provider: WorkbenchApps, value: DesktopSessionIdentity) {
    if (value.providerId !== provider.id || value.environmentId !== provider.scope.environmentId ||
        ![value.sessionId, value.instanceId, value.inputResourceId].every(item => typeof item === 'string' && item.length > 0)) {
      throw new Error('workbench-task-session-unconfirmed');
    }
    this.providerId = value.providerId; this.environmentId = value.environmentId; this.sessionId = value.sessionId;
    this.instanceId = value.instanceId; this.inputResourceId = value.inputResourceId!;
  }
  async capabilities() { return workbenchTaskCapabilities(); }
  async status() {
    if (this.closed) return { state: 'closed' as const, readiness: {} };
    return this.provider.client.call<Awaited<ReturnType<DesktopSession['status']>>>('task_status', { session: identity(this) });
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      await this.provider.inputControl.revokeSession(this);
      await this.provider.client.call('task_session_close', { session: identity(this) });
      this.closed = true;
    })();
  }
}
interface Claim {
  taskId?: string; lastTaskId?: string; authority?: InputAuthority; runtime?: WorkerClient;
  heartbeat?: NodeJS.Timeout; heartbeatFailure?: unknown; starting?: boolean; releasing?: Promise<boolean>;
  binding?: TaskAppDispatchBinding; handoff?: object; issuer?: ControlledAppLauncher;
}

/** Uses the production launch issuer and registry; never starts a replacement target. */
export class WorkbenchTaskExecutor implements DesktopTaskExecutor {
  readonly appTrustFence = 'registry-at-effect' as const;
  private readonly claims = new WeakMap<DesktopSession, Claim>();
  constructor(private readonly provider: WorkbenchApps, private readonly apps: EnvironmentAppServices,
    private readonly recordCleanup?: (taskId: string, outcome: 'done' | 'error' | 'retained') => void) {}
  private async cleanup(session: WorkbenchTaskSession, taskId: string) {
    try {
      const receipt = await this.provider.client.call<{ cleaned: boolean }>('task_cleanup', { session: identity(session) });
      if (receipt?.cleaned !== true) throw new Error('workbench-task-cleanup-unconfirmed');
    } catch (error) { this.recordCleanup?.(taskId, 'error'); throw error; }
    this.recordCleanup?.(taskId, 'done');
  }
  assertAvailable() { if (!this.provider.taskAvailable()) throw new Error('workbench-task-runtime-unavailable'); }
  private session(value: DesktopSession): WorkbenchTaskSession {
    if (!(value instanceof WorkbenchTaskSession) || value.provider !== this.provider || !this.provider.ownsSession(value) || value.closed) {
      throw new Error('workbench-task-session-mismatch');
    }
    return value;
  }
  appCatalog() { return Promise.resolve([]); }
  taskControl(value: DesktopSession) {
    const session = this.session(value);
    if (this.claims.has(session)) throw new Error('workbench-task-control-already-created');
    const claim: Claim = {}; this.claims.set(session, claim);
    return {
      workerEndpoint: () => '',
      assertTaskAllowed: (taskId?: string) => {
        this.session(session);
        if (!taskId || claim.releasing || claim.heartbeatFailure || taskId !== (claim.taskId ?? claim.lastTaskId)) {
          throw new Error('workbench-task-input-not-owned');
        }
        if (claim.authority) this.provider.inputControl.assertAuthority(session, claim.authority);
      },
      beginTask: async (taskId: string) => {
        if (!taskId || !claim.runtime || !claim.binding || claim.taskId || claim.starting || claim.releasing) {
          throw new Error('workbench-task-not-bound');
        }
        claim.starting = true;
        try {
          claim.binding.assertCurrentTrust();
          claim.authority = await this.provider.inputControl.acquire(session, { kind: 'agent', clientId: taskId });
          claim.taskId = claim.lastTaskId = taskId; claim.heartbeatFailure = undefined;
          let pending = false;
          claim.heartbeat = setInterval(() => {
            if (pending || !claim.authority || claim.releasing) return;
            pending = true;
            const authority = claim.authority;
            try {
              this.provider.inputControl.renewAuthority(authority);
              void this.provider.client.call('task_heartbeat', { session: identity(session), authority })
                .catch(error => { claim.heartbeatFailure = error; clearInterval(claim.heartbeat); })
                .finally(() => { pending = false; });
            } catch (error) { claim.heartbeatFailure = error; clearInterval(claim.heartbeat); pending = false; }
          }, 1000);
          claim.heartbeat.unref();
        } finally { claim.starting = false; }
      },
      finishTask: (taskId: string, status?: string) => {
        if (claim.taskId !== taskId) throw new Error('foreign-task');
        clearInterval(claim.heartbeat);
        return claim.releasing ??= (async () => {
          await this.provider.inputControl.revokeSession(session);
          if (!['paused', 'waiting_user'].includes(status ?? '')) {
            await this.cleanup(session, taskId);
          } else this.recordCleanup?.(taskId, 'retained');
          claim.authority = undefined; claim.taskId = undefined; claim.runtime = undefined; claim.releasing = undefined;
          return false;
        })();
      },
    };
  }
  async connectRuntime(): Promise<WorkerClient> { throw new Error('workbench-task-app-binding-required'); }
  async connectAppRuntime(value: DesktopSession, artifactDir: string, dispatch: TaskAppDispatchBinding): Promise<WorkerClient> {
    const session = this.session(value), claim = this.claims.get(session);
    if (!claim || claim.runtime || claim.releasing || claim.authority) throw new Error('workbench-task-binding-busy');
    const service = this.apps.forEnvironment(session);
    if (!(service.launcher instanceof ControlledAppLauncher)) throw new Error('workbench-task-issuer-unavailable');
    const issuer = service.launcher;
    dispatch.assertCurrentTrust();
    if (!claim.handoff) {
      claim.handoff = await issuer.handoffIssuedTarget(service.registry, dispatch.profile, dispatch.target, session);
      claim.issuer = issuer; claim.binding = { ...structuredClone({ profile: dispatch.profile, target: dispatch.target }), assertCurrentTrust: dispatch.assertCurrentTrust };
    } else if (claim.issuer !== issuer || JSON.stringify(claim.binding?.target) !== JSON.stringify(dispatch.target) ||
        claim.binding?.profile.profileDigest !== dispatch.profile.profileDigest) throw new Error('workbench-task-original-target-required');
    const assertTrust = () => {
      this.session(session); dispatch.assertCurrentTrust(); issuer.assertIssuedTargetHandoff(claim.handoff!, session);
    };
    assertTrust();
    try {
      const target = await this.provider.client.call<TargetBinding>('task_bind', {
        session: identity(session), profile: dispatch.profile, target: dispatch.target });
      assertTrust();
      if (!sameSession(target, session) || target.application !== dispatch.profile.applicationId ||
          target.applicationVersion !== dispatch.profile.identity?.version) throw new Error('workbench-task-native-target-unconfirmed');
      let closed = false;
      const authority = () => {
        assertTrust();
        if (closed || !claim.authority || claim.heartbeatFailure || claim.releasing) throw new Error('workbench-task-input-not-owned');
        this.provider.inputControl.assertAuthority(session, claim.authority); return claim.authority;
      };
      const call = async <T>(method: string, fields: object = {}): Promise<T> => {
        if (closed) throw new Error('workbench-task-runtime-closed');
        assertTrust();
        const result = await this.provider.client.call<T>(method, { ...fields, session: identity(session) });
        assertTrust(); return result;
      };
      const operation = (action: ComputerAction) => {
        if (!actions.includes(action.kind)) throw new Error('workbench-task-action-unavailable');
        const semantic = action.kind === 'type' || action.kind === 'paste_text';
        const read = action.kind === 'wait' || action.kind === 'screenshot';
        return { action: action.kind, mechanism: read ? 'read-only' : semantic ? 'uia-value' : 'window-message',
          required: read ? ['observation.pixels' as const] : ['control.leaseProtected' as const,
            semantic ? 'input.semantic' as const : 'input.targetedWindow' as const] };
      };
      const backend: DesktopExecutionBackend<{ action: ComputerAction; actionId: string }, ActionResult> = {
        bind: async selector => { if (selector !== target.targetId) throw new Error('workbench-task-target-mismatch'); return target; },
        targetStatus: async binding => {
          if (!sameSession(binding, target) || binding.targetId !== target.targetId) throw new Error('workbench-task-target-mismatch');
          await call('task_probe');
          return { binding: target, state: 'bound', capabilities: workbenchTaskCapabilities(), readiness: readiness() };
        },
        requirements: async (_binding, request) => operation(request.action),
        execute: request => {
          authority(); assertTrust();
          return call<ActionResult>('task_execute', { action: request.action.action, actionId: request.action.actionId,
            observation: request.observation, target: request.target, authority: request.authority });
        },
      };
      const gate = new DesktopExecutionAdmission(this.provider, session, this.provider.inputControl, backend);
      await gate.bind(target.targetId);
      const runtime: WorkerClient = {
        listWindows: filter => call('task_windows', { filter }),
        ensureApp: async () => { throw new Error('workbench-task-relaunch-forbidden'); },
        attach: options => call<void>('task_attach', { options }),
        probe: () => call('task_probe'),
        recoverFocus: () => call<void>('task_attach', { options: {} }),
        restore: observation => call<void>('task_restore', { observation }),
        observe: async (screenCapture = true) => {
          const result = await call<{ observation: Observation; preview?: { png: string; sha256: string } }>('task_observe', { screenCapture });
          if (result.preview) {
            const png = Buffer.from(result.preview.png, 'base64');
            if (png.length > 4 * 1024 * 1024 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
                createHash('sha256').update(png).digest('hex') !== result.preview.sha256) throw new Error('workbench-task-preview-unconfirmed');
            await mkdir(artifactDir, { recursive: true });
            const path = resolve(artifactDir, `${randomUUID()}.png`); await writeFile(path, png, { flag: 'wx' });
            result.observation.screenshot = path; result.observation.screenshotHash = result.preview.sha256;
          }
          return result.observation;
        },
        ground: action => call('task_ground', { action }),
        resolveAction: async action => {
          try { operation(action); await call('task_probe'); return { selected: WORKBENCH_TASK_PROVIDER,
            reason: '原启动目标上的 UIA 与定向窗口消息', candidates: [{ provider: WORKBENCH_TASK_PROVIDER, available: true, reason: '按动作重新检查目标与输入权' }] }; }
          catch (error) { return { selected: WORKBENCH_TASK_PROVIDER, reason: String(error),
            candidates: [{ provider: WORKBENCH_TASK_PROVIDER, available: false, reason: String(error) }] }; }
        },
        execute: async (action, resolution, actionId) => {
          if (resolution && resolution.selected !== WORKBENCH_TASK_PROVIDER) return { ok: false, effect: 'none', message: 'workbench-task-provider-mismatch' };
          authority(); operation(action);
          // Re-resolve after Graph's independent before-observation, never use an old UIA index.
          const prepared = await call<{ observation: import('../contracts/desktop-environment.js').DesktopObservationBinding }>('task_prepare', { action });
          return gate.execute({ target, observation: prepared.observation, authority: authority(),
            action: { action, actionId: actionId ?? randomUUID() } });
        },
        close: async () => {
          if (closed) return; closed = true; gate.invalidate();
          await this.provider.client.call('task_reset', { session: identity(session) });
        },
      };
      claim.runtime = runtime;
      return runtime;
    } catch (error) {
      // Connection is read-only but may already hold the issued APP lifetime.
      // Close this exact Session, never leave its resources until service teardown.
      try { await session.close(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'workbench-task-binding-cleanup-unconfirmed'); }
      throw error;
    }
  }
  async completeTask(value: DesktopSession, taskId: string) {
    const session = this.session(value), claim = this.claims.get(session);
    if (claim?.lastTaskId !== taskId || claim.authority || claim.releasing) throw new Error('foreign-task');
    await this.cleanup(session, taskId);
  }
}

/** Backends ACK activation/revocation; the private pipe never exposes grant credentials to the UI. */
export function registerWorkbenchInput(provider: WorkbenchApps, input: ResourceInputControl) {
  input.registerBackend(binding => provider.hasSessionIdentity(binding),
    authority => provider.hasSessionIdentity(authority) ? provider.client.call<void>('task_revoke', { session: identity(authority), authority }) : Promise.resolve(),
    authority => provider.client.call<void>('task_activate', { session: identity(authority), authority }));
}
