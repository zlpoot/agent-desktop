import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, win32 } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { DesktopProvider, DesktopCapabilities } from '../contracts/desktop-environment.js';
import type { EnvironmentAppScope, AppLaunchSpec, EnvironmentAppBinding } from '../contracts/environment-apps.js';
import type { AppInstallationCheck, AppInstanceEvidence, AppRuntimeContext, ManagedAppLaunchBackend } from '../contracts/app-launch.js';
import { AppLaunchError } from '../environment-apps/launcher.js';
import { ScopedAppDiscovery } from '../environment-apps/discovery.js';
import type { CollectedApp } from '../contracts/app-discovery.js';
import { readDashboardInstallationIdentity } from '../composition/dashboard-discovery.js';

export interface WorkbenchAppConfig { path: string; sha256: string; version: '3.1.40.205461'; }
export function workbenchAppConfig(value: unknown): WorkbenchAppConfig {
  const config = value as WorkbenchAppConfig;
  if (!config || Object.keys(config).some(key => !['path', 'sha256', 'version'].includes(key)) ||
      typeof config.path !== 'string' || !/^[a-z]:\\/i.test(config.path) || win32.basename(config.path).toLowerCase() !== 'cloudmusic.exe' ||
      /[\x00-\x1f"|?*]/.test(config.path) || typeof config.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(config.sha256) ||
      config.version !== '3.1.40.205461') throw new Error('invalid-workbench-app-config');
  return Object.freeze({ ...config });
}
export function loadWorkbenchAppConfig(project: string, explicitPath?: string): WorkbenchAppConfig | undefined {
  const path = explicitPath ?? resolve(project, 'config/workbench-apps.local.json');
  if (!existsSync(path)) { if (explicitPath) throw Error('workbench-app-config-missing'); return; }
  return workbenchAppConfig(JSON.parse(readFileSync(path, 'utf8')));
}
export interface WorkbenchAppClient { call<T>(method: string, fields?: object): Promise<T>; close(): Promise<void>; }
export class NativeWorkbenchAppClient implements WorkbenchAppClient {
  private child?: ChildProcessWithoutNullStreams;
  private next = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private failed = false;
  constructor(private readonly config: WorkbenchAppConfig, private readonly scope: EnvironmentAppScope,
    private readonly registry: string, private readonly project: string) {}
  private async initialize() {
    if (this.failed) throw Error('workbench-app-worker-unavailable');
    if (this.child) return;
    const child = this.child = spawn('python', [resolve(this.project, 'src/desktop-provider/workbench_app_worker.py')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const fail = () => { this.failed = true; for (const waiter of this.pending.values()) waiter.reject(Error('workbench-app-worker-disconnected')); this.pending.clear(); };
    child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail); child.stderr.on('data', () => {});
    createInterface({ input: child.stdout }).on('line', line => {
      if (Buffer.byteLength(line) > 131072) { child.kill(); fail(); return; }
      let value: any; try { value = JSON.parse(line); } catch { child.kill(); fail(); return; }
      const waiter = this.pending.get(value.id); if (!waiter) return; this.pending.delete(value.id);
      if (value.error && value.diagnostic) console.error('Workbench native diagnostic:', JSON.stringify(value.diagnostic));
      if (value.error) waiter.reject(new AppLaunchError(value.error === 'workbench-installation-changed' ? 'stale'
        : value.error === 'workbench-native-operation-failed' ? 'unknown' : 'unavailable', value.error)); else waiter.resolve(value.result);
    });
    await this.send('init', { config: this.config, scope: this.scope, registry: this.registry });
  }
  private send<T>(method: string, fields: object = {}): Promise<T> {
    const id = ++this.next;
    return new Promise((resolveReply, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.failed = true; this.child?.kill(); reject(Error('workbench-app-worker-timeout')); }, 15000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolveReply(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.child!.stdin.write(JSON.stringify({ id, method, fields }) + '\n');
    });
  }
  async call<T>(method: string, fields: object = {}): Promise<T> { await this.initialize(); return this.send<T>(method, fields); }
  async close() {
    const child = this.child; if (!child) return;
    if (!this.failed) await this.send('close');
    child.stdin.end();
    if (child.exitCode === null) await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error('workbench-app-worker-close-unconfirmed')); }, 3000);
      child.once('exit', () => { clearTimeout(timer); done(); });
    });
  }
}

/** Configured App opening only. Never supplies a Task runtime or input authority. */
export class WorkbenchApps implements DesktopProvider {
  readonly id = 'workbench-apps'; readonly kind = 'local-workspace' as const;
  readonly scope: EnvironmentAppScope;
  readonly discovery: ScopedAppDiscovery;
  readonly launchBackend: ManagedAppLaunchBackend;
  private closed = false;
  constructor(readonly config: WorkbenchAppConfig, installationScopeId: string, private readonly client: WorkbenchAppClient, available = process.platform === 'win32') {
    this.config = workbenchAppConfig(config);
    this.available = available;
    this.scope = Object.freeze({ providerId: this.id, environmentId: 'local-workspace:apps', installationScopeId });
    const spec: AppLaunchSpec = { kind: 'exe', executable: config.path, args: [] };
    const inspect = async (value: AppLaunchSpec, signal: AbortSignal) => {
      if (this.closed || signal.aborted || JSON.stringify(value) !== JSON.stringify(spec)) throw new AppLaunchError('unavailable', 'workbench-configured-app-only');
      const checked = await client.call<AppInstallationCheck>('inspect', { spec: value });
      if (signal.aborted || this.closed) throw new AppLaunchError('unavailable', 'workbench-app-cancelled');
      return checked;
    };
    this.discovery = new ScopedAppDiscovery(this.scope, { scope: this.scope,
      collect: async (_limits, signal) => {
        const checked = await inspect(spec, signal);
        const entry = await client.call<CollectedApp>('catalog');
        if (signal.aborted || entry.contentFingerprint !== checked.identity.fingerprint) throw Error('workbench-installation-changed');
        return { scope: this.scope, entries: [entry],
          coverage: [{ source: 'explicit-operator-config', status: 'complete', inspected: 1, rejected: 0 }] };
      }, inspectPath: async () => { throw Error('workbench-configured-app-only'); } });
    this.launchBackend = { scope: this.scope, inspect, open: async signal => {
      if (this.closed || signal.aborted) throw Error('workbench-app-cancelled');
      const context = await client.call<AppRuntimeContext>('reserve');
      let owned: string | undefined;
      const current = async () => {
        if (this.closed || signal.aborted) throw Error('workbench-app-cancelled');
        const actual = await client.call<AppRuntimeContext>('current');
        if (JSON.stringify(actual) !== JSON.stringify(context)) throw Error('workbench-original-context-changed');
      };
      const instances = async (profile: EnvironmentAppBinding) => { await current();
        const values = await client.call<AppInstanceEvidence[]>('instances', { profile }); await current(); return values; };
      return { context, assertCurrent: current, inspect: value => inspect(value, signal), instances,
        start: async profile => { await current(); owned = await client.call<string>('start', { profile }); await current(); return owned; },
        observe: async (profile, token) => {
          if (token !== owned) throw Error('workbench-owned-token-required');
          const until = Date.now() + 8000;
          while (Date.now() < until) { const values = await instances(profile); if (values.length) return values; await new Promise(done => setTimeout(done, 50)); }
          throw new AppLaunchError('unknown', 'workbench-original-window-unavailable');
        }, cleanupOwned: async token => { if (!owned || token !== owned) throw Error('workbench-owned-token-required'); await client.call('cleanup', { token }); },
        close: async keep => {
          try { if (!keep || signal.aborted) await client.call('close'); }
          catch (error) { console.error('Workbench close diagnostic:', JSON.stringify({
            exception: error instanceof Error ? error.name : 'unknown',
            code: error instanceof Error && /^[a-z][a-z0-9-]{1,100}$/.test(error.message) ? error.message : 'workbench-close-failed' })); throw error; }
        } };
    }, close: () => this.close() };
  }
  private readonly available: boolean;
  async discover() { return this.available && !this.closed ? [{ ...this.scope, kind: this.kind }] : []; }
  async capabilities(): Promise<DesktopCapabilities> { return { 'input.globalInput': [{ state: 'forbidden', scope: {} }], 'input.rawIsolated': [{ state: 'forbidden', scope: {} }] }; }
  async open(): Promise<never> { throw Error('workbench-app-only-no-task-runtime'); }
  async close() { if (this.closed) return; this.closed = true; await this.client.close(); }
}
export async function nativeWorkbenchApps(config: WorkbenchAppConfig, project: string, registry: string) {
  const identity = await readDashboardInstallationIdentity('python', resolve(project, 'scripts/dashboard-app-identity.py'));
  const scope = { providerId: 'workbench-apps', environmentId: 'local-workspace:apps', installationScopeId: identity };
  return new WorkbenchApps(config, identity, new NativeWorkbenchAppClient(config, scope, registry, project));
}
