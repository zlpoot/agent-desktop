import { hostname, userInfo } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, win32 } from 'node:path';
import type { ComputerAction, Observation, Target } from '../actions/schema.js';
import type { DesktopProvider, DesktopSession, DesktopCapabilities } from '../contracts/desktop-environment.js';
import type { DesktopInputArbiter, InputAuthority } from '../contracts/desktop-input-control.js';
import type { InputControl } from '../contracts/desktop-provider.js';
import type { WorkerClient } from '../contracts/worker-client.js';
import type { DesktopTaskExecutor, TaskAppDispatchBinding } from '../app/task-desktop-sessions.js';
import type { AppInstallationCheck, AppRuntimeContext, AppInstanceEvidence, ManagedAppLaunchBackend } from '../contracts/app-launch.js';
import type { AppLaunchSpec, EnvironmentAppService, EnvironmentAppScope } from '../contracts/environment-apps.js';
import { ControlledAppLauncher } from '../environment-apps/launcher.js';
import { ScopedAppDiscovery } from '../environment-apps/discovery.js';
import { assertDesktopCapabilities, sameSession } from './admission.js';

export interface TestBenchWorkspaceConfig { path: string; sha256: string; }
export function validateTestBenchWorkspace(value: TestBenchWorkspaceConfig): TestBenchWorkspaceConfig {
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['path', 'sha256'].includes(key)) ||
      typeof value.path !== 'string' || !/^[a-z]:[\\/]/i.test(value.path) ||
      win32.basename(value.path).toLowerCase() !== 'windowsagenttestbench.exe' ||
      /[<>"|?*\u0000-\u001f]/.test(value.path) || value.path.slice(2).includes(':') ||
      typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('invalid-testbench-workspace-config');
  return Object.freeze({ path: win32.normalize(value.path), sha256: value.sha256 });
}
export interface BenchCapture {
  hwnd: number; pid: number; incarnation: string; observation: string; sequence: number;
  elevated: boolean; targetElevated: boolean; permissionsCompatible: boolean;
  title: string; windowClass: string; startedAt: number; finishedAt: number; rect: { left: number; top: number; width: number; height: number };
  text: string; items: NonNullable<Observation['structured']>['items'];
}
/** Composition-only transport; it is not a model tool or Guest protocol extension. */
export interface TestBenchBackend {
  call<T>(method: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}
export type TestBenchBackendFactory = () => TestBenchBackend;
export class NativeTestBenchBackend implements TestBenchBackend {
  private readonly child: ChildProcessWithoutNullStreams;
  private next = 0;
  private instance?: string;
  private closed = false;
  private acknowledgedClose = false;
  private closing?: Promise<void>;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  constructor(project: string) {
    this.child = spawn('python', [resolve(project, 'src/desktop-provider/testbench_worker.py')], {
      cwd: project, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    createInterface({ input: this.child.stdout }).on('line', line => {
      try {
        const response = JSON.parse(line), pending = this.pending.get(response.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(response.id);
        if (response.error) {
          if (response.diagnostic) console.error('TestBench native failure:', JSON.stringify(response.diagnostic));
          pending.reject(new Error(response.error));
        }
        else pending.resolve(response.result);
      } catch { this.fail(); }
    });
    this.child.stderr.resume(); // Never return environment secrets or raw native output.
    this.child.on('error', () => this.fail()); this.child.on('exit', () => this.fail());
  }
  private fail(): void {
    const terminate = !this.closed;
    this.closed = true;
    if (terminate && !this.acknowledgedClose) this.child.kill();
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error('testbench-transport-unconfirmed')); }
    this.pending.clear();
  }
  async call<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) throw new Error('testbench-backend-closed');
    const id = ++this.next;
    const result = await new Promise<T>((resolveResult, reject) => {
      const timer = setTimeout(() => { this.fail(); this.child.kill(); }, 15000);
      this.pending.set(id, { resolve: resolveResult, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, args, instance: this.instance }) + '\n', error => {
        if (error) { this.fail(); this.child.kill(); }
      });
    });
    if (method === 'init') this.instance = (result as AppRuntimeContext).instanceId;
    return result;
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      if (this.closed) {
        if (!this.acknowledgedClose) throw new Error('testbench-native-cleanup-unconfirmed');
        return;
      }
      try { await this.call('close'); this.acknowledgedClose = true; }
      finally { this.closed = true; this.child.kill(); }
    })();
  }
}
const buttons = new Set(['工作台', '客户管理', '订单管理', '系统设置', '查询客户', '打开李四资料', '打开张三资料', '查看客户订单', '查询订单', '打开 O2026-1003', '打开 O2026-1004']);
export function testBenchActionAllowed(action: ComputerAction): boolean {
  if (action.kind !== 'click' && action.kind !== 'type' || action.target.kind !== 'role') return false;
  return action.kind === 'click' ? action.target.role === 'button' && buttons.has(action.target.name ?? '') :
    action.target.role === 'edit' && ['客户姓名', '订单客户姓名'].includes(action.target.name ?? '') && action.text.length <= 80 && !/[\u0000-\u001f\u007f]/.test(action.text);
}
function boundedWait(action: ComputerAction): boolean {
  return action.kind === 'wait' && Number.isInteger(action.ms) && action.ms >= 0 && action.ms <= 2000;
}
interface RecordBinding {
  session: DesktopSession; backend: TestBenchBackend; context: AppRuntimeContext;
  state: 'open' | 'closed' | 'stale'; app?: TaskAppDispatchBinding; handoff?: object;
  authority?: InputAuthority; heartbeat?: NodeJS.Timeout; taskId?: string;
  current?: BenchCapture; closing?: Promise<void>; workerClosed?: boolean; starting?: boolean; controlCreated?: boolean; drained?: boolean;
}
/** Same Local Workspace provider kind, explicitly bounded to the repository-owned Bench.
 * Reserves an EMPTY Desktop/Job. P7 launches once inside this very resource.
 * D0/NetEase fixed-scenario executors are untouched and remain generic-unavailable.
 */
export class TestBenchWorkspace implements DesktopProvider, DesktopTaskExecutor {
  readonly id = 'windows-local-workspace';
  readonly kind = 'local-workspace' as const;
  readonly appTrustFence = 'registry-at-effect' as const;
  readonly scope: EnvironmentAppScope;
  readonly launchBackend: ManagedAppLaunchBackend;
  readonly discovery: ScopedAppDiscovery;
  private readonly records = new Map<DesktopSession, RecordBinding>();
  private service?: EnvironmentAppService;
  private closed = false;
  private opening = false;
  private pendingOpen?: Promise<DesktopSession>;
  private closing?: Promise<void>;
  private blocked = false;
  readonly config: TestBenchWorkspaceConfig;
  constructor(config: TestBenchWorkspaceConfig, private readonly input: DesktopInputArbiter,
    private readonly registryPath: string, project: string,
    private readonly factory: TestBenchBackendFactory = () => new NativeTestBenchBackend(project),
    private readonly inspectBinary: () => Promise<string> = async () => createHash('sha256').update(await readFile(config.path)).digest('hex'),
    private readonly available = process.platform === 'win32') {
    this.config = validateTestBenchWorkspace(config); config = this.config;
    this.scope = Object.freeze({ providerId: this.id, environmentId: 'local-workspace:testbench', installationScopeId: 'testbench:' + createHash('sha256').update(JSON.stringify([hostname(), userInfo().username, userInfo().homedir, config.path.toLowerCase(), config.sha256])).digest('hex') });
    const spec: AppLaunchSpec = { kind: 'exe', executable: config.path, args: ['--task-channel'] };
    const inspect = async (launchSpec: AppLaunchSpec, signal: AbortSignal): Promise<AppInstallationCheck> => {
      if (this.closed || signal.aborted || JSON.stringify(launchSpec) !== JSON.stringify(spec) || await this.inspectBinary() !== config.sha256 || signal.aborted)
        throw new Error('testbench-installation-unavailable');
      return { scope: this.scope, launchSpec: spec, identity: { productId: 'WindowsAgentTestBench', version: 'task-channel-v1', fingerprint: config.sha256 } };
    };
    const collect = async (_limits: import('../contracts/app-discovery.js').AppScanLimits, signal: AbortSignal) => {
        const checked = await inspect(spec, signal);
        return { scope: this.scope, entries: [{ displayName: 'WindowsAgentTestBench', aliases: ['Windows Agent TestBench'],
          launchSpec: spec, source: 'explicit-testbench-config', version: checked.identity.version,
          publisher: 'repository-testbench', contentFingerprint: checked.identity.fingerprint }],
          coverage: [{ source: 'explicit-testbench-config', status: 'complete' as const, inspected: 1, rejected: 0 }] };
      };
    this.discovery = new ScopedAppDiscovery(this.scope, { scope: this.scope, collect, inspectPath: async (path, limits, signal) => {
        if (win32.normalize(path).toLowerCase() !== win32.normalize(config.path).toLowerCase()) throw new Error('testbench-only');
        return collect(limits, signal);
      } });
    this.launchBackend = { scope: this.scope, inspect, open: async signal => {
      // Exactly one active Task Session; no P7 helper launching on Default Desktop.
      const record = this.reservation();
      const check = async () => { this.record(record.session); if (signal.aborted) throw new Error('testbench-launch-cancelled'); await record.backend.call('current'); this.record(record.session); if (signal.aborted) throw new Error('testbench-launch-cancelled'); };
      await check();
      let reserved = true, owned: string | undefined;
      const assertReserved = () => { if (!reserved) throw new Error('testbench-launch-reservation-closed'); };
      return { context: record.context, assertCurrent: check,
        inspect: async value => { assertReserved(); await check(); return inspect(value, signal); },
        instances: async profile => { assertReserved(); await check(); return record.backend.call<AppInstanceEvidence[]>('instances', { profile }); },
        start: async profile => { assertReserved(); await check(); owned = await record.backend.call<string>('start', { profile }); return owned; },
        observe: async (profile, token) => { assertReserved(); await check(); const values = await record.backend.call<AppInstanceEvidence[]>('instances', { profile });
          if (token && values.some(value => value.targetToken !== token)) throw new Error('testbench-original-target-mismatch'); return values; },
        cleanupOwned: async token => { assertReserved();
          if (!owned || token !== owned) throw new Error('testbench-cleanup-token-mismatch');
          await record.session.close(); },
        close: async keep => { reserved = false; if (!keep) await record.session.close(); },
      };
    }, close: () => this.close() };
    input.registerBackend(identity => [...this.records.values()].some(record => record.state === 'open' && sameSession(identity, record.session)),
      async authority => {
        const record = [...this.records.values()].find(value => sameSession(value.session, authority));
        if (!record) throw new Error('testbench-input-session-unavailable');
        clearInterval(record.heartbeat); record.heartbeat = undefined; record.authority = undefined;
        await record.backend.call('revoke', { authority });
      }, async authority => {
        const record = [...this.records.values()].find(value => sameSession(value.session, authority));
        if (!record || record.state !== 'open' || !record.app || !record.handoff) throw new Error('testbench-task-bridge-required');
        record.app.assertCurrentTrust();
        await record.backend.call('activate', { authority });
        record.authority = authority;
        record.heartbeat = setInterval(() => {
          try { this.record(record.session); record.app!.assertCurrentTrust(); this.input.renewAuthority!(authority); }
          catch { this.input.blockResource(record.session); clearInterval(record.heartbeat); void record.session.close().catch(() => {}); return; }
          void record.backend.call('ping', { authority }).catch(() => {
            this.input.blockResource(record.session); clearInterval(record.heartbeat); void record.session.close().catch(() => {});
          });
        }, 750);
      });
  }
  bindService(service: EnvironmentAppService): void {
    if (this.service || !(service.launcher instanceof ControlledAppLauncher) || JSON.stringify(service.registry.scope) !== JSON.stringify(this.scope)) throw new Error('testbench-original-service-required');
    this.service = service;
  }
  assertAvailable(): void { if (!this.available || this.closed || this.blocked || !this.service) throw new Error('testbench-workspace-unavailable'); }
  connectRuntime(): never { throw new Error('testbench-p7-original-target-required'); }
  async capabilities(): Promise<DesktopCapabilities> {
    const scope = { providerId: [this.id], environmentKind: [this.kind], application: ['WindowsAgentTestBench'],
      applicationVersion: ['task-channel-v1'], targetRole: ['owned-main-window'], mechanism: ['testbench-owned-peer'] };
    const evidence = [{ source: 'docs/r0-testbench-task-bridge.md', description: 'Implementation and synthetic tests only; real Windows UAT pending independent review and authorization' }];
    return { 'observation.accessibility': [{ state: 'supported', scope: { ...scope, action: ['observe'] }, evidence }],
      'input.semantic': [{ state: 'supported', scope: { ...scope, action: ['click', 'type'] }, evidence }],
      'input.globalInput': [{ state: 'forbidden', scope: {} }], 'input.rawIsolated': [{ state: 'forbidden', scope: {} }],
      'observation.pixels': [{ state: 'unsupported', scope: {} }], 'control.humanTakeover': [{ state: 'unsupported', scope: {} }],
      'control.resumable': [{ state: 'unsupported', scope: {} }] };
  }
  async discover() { return this.available && !this.closed ? [{ ...this.scope, kind: this.kind }] : []; }
  open(environmentId: string): Promise<DesktopSession> {
    try { this.assertAvailable(); } catch (error) { return Promise.reject(error); }
    if (this.opening) return Promise.reject(new Error('testbench-resource-busy-or-mismatch'));
    const pending = this.openBody(environmentId); this.pendingOpen = pending;
    return pending;
  }
  private async openBody(environmentId: string): Promise<DesktopSession> {
    this.assertAvailable();
    if (environmentId !== this.scope.environmentId || this.opening || [...this.records.values()].some(record => !record.drained)) throw new Error('testbench-resource-busy-or-mismatch');
    this.opening = true;
    const backend = this.factory(), sessionId = randomUUID();
    try {
      const context = await backend.call<AppRuntimeContext>('init', { config: this.config, registry: this.registryPath, scope: this.scope, sessionId });
      if (this.closed || context.sessionId !== sessionId || JSON.stringify(context.scope) !== JSON.stringify(this.scope) ||
          !context.instanceId || !context.desktop.startsWith('AgentD0_Bench_') || !Number.isSafeInteger(context.windowsSessionId) || context.windowsSessionId < 0) throw new Error('testbench-handshake-unconfirmed');
      const session: DesktopSession = Object.freeze({ providerId: this.id, environmentId, sessionId, instanceId: context.instanceId, inputResourceId: context.instanceId,
        capabilities: () => this.capabilities(), status: async () => {
          const record = this.records.get(session)!;
          if (record.state === 'open') try { await backend.call('current'); } catch { record.state = 'stale'; }
          return { state: record.state, readiness: { 'observation.accessibility': { state: record.state === 'open' ? 'ready' as const : 'not-ready' as const },
            'input.semantic': { state: record.state === 'open' && !!record.app ? 'ready' as const : 'not-ready' as const } } };
        }, close: () => this.closeSession(session) });
      this.records.set(session, { session, backend, context, state: 'open' });
      return session;
    } catch (error) {
      try { await backend.close(); }
      catch (cleanup) { this.blocked = true; throw new AggregateError([error, cleanup], 'testbench-open-cleanup-unconfirmed'); }
      throw error;
    }
    finally { this.opening = false; }
  }
  private reservation(): RecordBinding {
    const records = [...this.records.values()].filter(record => record.state === 'open');
    if (records.length !== 1) throw new Error('testbench-selected-task-session-required');
    return records[0];
  }
  private record(session: DesktopSession): RecordBinding {
    const record = this.records.get(session);
    if (!record || record.state !== 'open' || this.closed) throw new Error('testbench-original-session-unavailable');
    return record;
  }
  private closeSession(session: DesktopSession): Promise<void> {
    const record = this.records.get(session);
    if (!record) return Promise.reject(new Error('testbench-foreign-session'));
    return record.closing ??= (async () => {
      clearInterval(record.heartbeat); record.heartbeat = undefined;
      try { await this.input.revokeSession(session); } finally {
        record.state = 'closed'; record.current = undefined;
        try { await record.backend.close(); record.drained = true; } catch (error) { this.blocked = true; throw error; }
      }
    })();
  }
  taskControl(session: DesktopSession): InputControl {
    const record = this.record(session);
    if (record.controlCreated) throw new Error('testbench-task-control-already-created');
    record.controlCreated = true;
    let created = false;
    return { workerEndpoint: () => '', assertTaskAllowed: taskId => {
      if (!record.authority || record.taskId !== taskId) throw new Error('testbench-task-input-not-owned');
      this.input.assertAuthority(session, record.authority);
    }, beginTask: async taskId => {
      if (!record.app || !record.handoff) { await this.closeSession(session); throw new Error('testbench-task-bridge-required'); }
      if (created || record.starting || !taskId || record.workerClosed) throw new Error('testbench-task-bridge-required');
      record.starting = true;
      try { record.app.assertCurrentTrust(); record.authority = await this.input.acquire(session, { kind: 'agent', clientId: taskId }); record.taskId = taskId; created = true; }
      catch (error) {
        try { await this.closeSession(session); } catch (cleanup) { throw new AggregateError([error, cleanup], 'testbench-input-cleanup-unconfirmed'); }
        throw error;
      }
      finally { record.starting = false; }
    }, finishTask: async taskId => {
      if (!taskId || record.taskId && record.taskId !== taskId) throw new Error('foreign-task');
      await this.closeSession(session); record.taskId = undefined; return false;
    } };
  }
  async connectAppRuntime(session: DesktopSession, _artifactDir: string, binding: TaskAppDispatchBinding): Promise<WorkerClient> {
    const record = this.record(session), launcher = this.service!.launcher as ControlledAppLauncher;
    try {
      if (record.app || binding.target.sessionId !== session.sessionId || binding.target.instanceId !== session.instanceId ||
          binding.target.desktop !== record.context.desktop || binding.target.windowsSessionId !== record.context.windowsSessionId) throw new Error('testbench-original-task-instance-required');
      binding.assertCurrentTrust();
      const handoff = await launcher.handoffIssuedTarget(this.service!.registry, binding.profile, binding.target, session);
      binding.assertCurrentTrust(); launcher.assertIssuedTargetHandoff(handoff, session);
      await record.backend.call('bind', { profile: binding.profile, target: binding.target });
      binding.assertCurrentTrust(); this.record(session); launcher.assertIssuedTargetHandoff(handoff, session);
      record.app = binding; record.handoff = handoff;
      const check = () => { this.record(session); if (record.workerClosed) throw new Error('testbench-task-worker-closed'); binding.assertCurrentTrust(); launcher.assertIssuedTargetHandoff(handoff, session); };
      const capture = async () => {
        check(); record.current = undefined;
        const result = await record.backend.call<BenchCapture>('observe'); check();
        if (!result.observation || !result.incarnation || !Number.isSafeInteger(result.hwnd) || result.hwnd <= 0 || !Number.isSafeInteger(result.pid) ||
            !Array.isArray(result.items) || result.items.length > 512) throw new Error('testbench-observation-unconfirmed');
        record.current = result; return result;
      };
      const window = async () => {
        const result = await capture();
        return { handle: result.hwnd, title: result.title, windowClass: result.windowClass,
          processId: result.pid, processPath: this.config.path, targetElevated: result.targetElevated, elevated: result.elevated, permissionsCompatible: result.permissionsCompatible, visible: true, minimized: false, foreground: false, rect: result.rect };
      };
      const targetOf = (action: ComputerAction): Target | undefined => {
        if (!testBenchActionAllowed(action) || !record.current || (action.kind !== 'click' && action.kind !== 'type') || action.target.kind !== 'role') return;
        const target = action.target;
        return record.current.items.filter(item => item.role === target.role && item.name === target.name).length === 1 ? target : undefined;
      };
      return {
        listWindows: async filter => { const value = await window(); return !filter || (!filter.windowTitle || value.title.includes(filter.windowTitle)) &&
          (!filter.processPath || value.processPath.toLowerCase() === filter.processPath.toLowerCase()) &&
          (!filter.windowClass || value.windowClass === filter.windowClass) ? [value] : []; },
        ensureApp: async () => { throw new Error('testbench-launch-forbidden'); },
        attach: async () => { throw new Error('testbench-target-rebind-forbidden'); },
        probe: async () => ({ ...await window(), uiaControls: true }),
        observe: async () => {
          const value = await capture();
          return { windowHandle: value.hwnd, windowTitle: value.title, windowRect: value.rect, pageText: value.text,
            accessibility: JSON.stringify(value.items), textEvidence: [{ source: 'uia', text: value.text }],
            structured: { source: 'uia', complete: true, items: value.items },
            capture: { epoch: value.incarnation, sequence: value.sequence, object: 'window:' + value.incarnation + ':' + value.hwnd, startedAt: value.startedAt,
              finishedAt: value.finishedAt, clock: 'collector', atomic: false, enumerationComplete: true, fields: { pageText: { complete: true, source: 'uia' }, accessibility: { complete: true, source: 'uia' }, structured: { complete: true, source: 'uia' } } } };
        },
        ground: async action => { check(); await record.backend.call('current'); check(); const target = targetOf(action); return { target, attempts: [{ strategy: 'role', matched: !!target, selected: !!target, detail: 'Original TestBench observed semantic control' }] }; },
        resolveAction: async action => { check(); await record.backend.call('current'); check(); const available = !!targetOf(action) || boundedWait(action); const provider = boundedWait(action) ? 'testbench.wait' : 'testbench.owned-peer'; return { selected: available ? provider : '',
          reason: available ? 'Owned Bench read/query semantic action' : 'TestBench action outside observed read/query scope',
          candidates: [{ provider, available, reason: 'No alternate input provider' }] }; },
        execute: async (action, resolution, actionId = randomUUID()) => {
          check();
          if (boundedWait(action) && action.kind === 'wait') {
            if (resolution && resolution.selected !== 'testbench.wait' || !record.authority) throw new Error('testbench-wait-not-admitted');
            this.input.assertAuthority(session, record.authority); record.current = undefined;
            await new Promise(done => setTimeout(done, action.ms));
            check(); this.input.assertAuthority(session, record.authority);
            return { ok: true, effect: 'none', provider: 'testbench.wait', message: 'Bounded wait; no input effect' };
          }
          if (!targetOf(action) || resolution && resolution.selected !== 'testbench.owned-peer' || !record.authority) throw new Error('testbench-action-not-admitted');
          const caps = await this.capabilities();
          check(); this.input.assertAuthority(session, record.authority);
          assertDesktopCapabilities(['input.semantic'], { providerId: this.id, environmentKind: this.kind,
            application: 'WindowsAgentTestBench', applicationVersion: 'task-channel-v1', targetRole: 'owned-main-window',
            action: action.kind, mechanism: 'testbench-owned-peer' }, { provider: caps, session: caps, target: caps },
            { session: { 'input.semantic': { state: 'ready' } }, target: { 'input.semantic': { state: 'ready' } } });
          const observed = record.current!; record.current = undefined;
          // Host checks are preflight only. The actual WPF UI producer re-reads the authoritative
          // Registry under BEGIN IMMEDIATE through synchronous commit, serializing revocation.
          return record.backend.call('execute', { authority: record.authority, action, observation: observed.observation, actionId });
        },
        restore: async observation => { check(); await record.backend.call('current'); check(); if (!record.current || observation.windowHandle !== record.current.hwnd || observation.windowTitle !== record.current.title) throw new Error('testbench-restore-substitution-forbidden'); },
        recoverFocus: async () => { throw new Error('testbench-focus-input-forbidden'); },
        close: async () => { record.workerClosed = true; record.current = undefined; },
      };
    } catch (error) {
      try { await this.closeSession(session); } catch (cleanup) { throw new AggregateError([error, cleanup], 'testbench-bridge-cleanup-unconfirmed'); }
      throw error;
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    return this.closing = (async () => {
      const pendingFailures: unknown[] = [];
      await this.pendingOpen?.catch(error => { if (error instanceof AggregateError) pendingFailures.push(error); });
      const results = await Promise.allSettled([...this.records.keys()].map(session => this.closeSession(session)));
      const failures = [...pendingFailures, ...results.filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason)];
      if (failures.length) throw new AggregateError(failures, 'testbench-workspace-cleanup-unconfirmed');
    })();
  }
}
