import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { DesktopProvider, DesktopSessionIdentity } from '../contracts/desktop-environment.js';
import type { EnvironmentAppScope, AppLaunchSpec, EnvironmentAppService } from '../contracts/environment-apps.js';
import type { ManagedAppLaunchBackend } from '../contracts/app-launch.js';
import { ScopedAppDiscovery } from '../environment-apps/discovery.js';
import type { CollectedApp } from '../contracts/app-discovery.js';
import { readDashboardInstallationIdentity } from '../composition/dashboard-discovery.js';
import { launchDefinition } from '../environment-apps/launcher.js';

import { NativeWorkbenchAppClient, type WorkbenchAppClient } from './workbench-app-native-client.js';
import { createWorkbenchAppLaunchBackend } from './workbench-app-launch-backend.js';
import { ResourceInputControl } from './resource-input-control.js';
import { WorkbenchTaskSession, workbenchTaskCapabilities, registerWorkbenchInput } from './workbench-task-executor.js';
export { NativeWorkbenchAppClient, type WorkbenchAppClient } from './workbench-app-native-client.js';

/** Optional legacy seed; manual imports are persisted by the environment Registry. */
export interface WorkbenchAppConfig { path: string; sha256: string; version: string; }
export function workbenchAppConfig(value: unknown): WorkbenchAppConfig {
  const config = value as WorkbenchAppConfig;
  if (!config || Object.keys(config).some(key => !['path', 'sha256', 'version'].includes(key)) ||
      typeof config.path !== 'string' || !/^[a-z]:\\/i.test(config.path) ||
      /[\x00-\x1f"|?*]/.test(config.path) || typeof config.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(config.sha256) ||
      typeof config.version !== 'string' || !config.version.trim() || /[\x00-\x1f]/.test(config.version)) throw new Error('invalid-workbench-app-config');
  launchDefinition({ kind: 'exe', executable: config.path, args: [] });
  return Object.freeze({ ...config });
}
export function loadWorkbenchAppConfig(project: string, explicitPath?: string): WorkbenchAppConfig | undefined {
  const path = explicitPath ?? resolve(project, 'config/workbench-apps.local.json');
  if (!existsSync(path)) { if (explicitPath) throw Error('workbench-app-config-missing'); return; }
  return workbenchAppConfig(JSON.parse(readFileSync(path, 'utf8')));
}
/** Scoped App management and read-only task Session handshake. Actions use a separate executor. */
export class WorkbenchApps implements DesktopProvider {
  readonly id = 'workbench-apps'; readonly kind = 'local-workspace' as const;
  readonly scope: EnvironmentAppScope;
  readonly discovery: ScopedAppDiscovery;
  readonly launchBackend: ManagedAppLaunchBackend;
  readonly liveStatus: NonNullable<EnvironmentAppService['liveStatus']>;
  readonly preview: NonNullable<EnvironmentAppService['preview']>;
  readonly stop: NonNullable<EnvironmentAppService['stop']>;
  private closed = false;
  readonly inputControl = new ResourceInputControl();
  private readonly sessions = new Set<WorkbenchTaskSession>();
  constructor(readonly config: WorkbenchAppConfig | undefined, installationScopeId: string, readonly client: WorkbenchAppClient, available = process.platform === 'win32') {
    this.config = config ? workbenchAppConfig(config) : undefined;
    this.available = available;
    this.scope = Object.freeze({ providerId: this.id, environmentId: 'local-workspace:apps', installationScopeId });
    registerWorkbenchInput(this, this.inputControl);
    const spec: AppLaunchSpec | undefined = config ? { kind: 'exe', executable: config.path, args: [] } : undefined;
    this.launchBackend = createWorkbenchAppLaunchBackend({ scope: this.scope, client,
      isClosed: () => this.closed, close: () => this.close() });
    this.liveStatus = app => client.call('status', { profile: app });
    this.preview = app => client.call('preview', { profile: app });
    this.stop = async app => { await client.call('stop', { profile: app }); };
    const inspect = this.launchBackend.inspect;
    this.discovery = new ScopedAppDiscovery(this.scope, { scope: this.scope,
      collect: async (_limits, signal) => {
        if (!spec) return { scope: this.scope, entries: [], coverage: [{ source: 'manual-import-only', status: 'complete', inspected: 0, rejected: 0 }] };
        const checked = await inspect(spec, signal);
        const entry = await client.call<CollectedApp>('catalog');
        if (signal.aborted || entry.contentFingerprint !== checked.identity.fingerprint) throw Error('workbench-installation-changed');
        return { scope: this.scope, entries: [entry],
          coverage: [{ source: 'explicit-operator-config', status: 'complete', inspected: 1, rejected: 0 }] };
      }, inspectPath: async (path, _limits, signal) => {
        const value: AppLaunchSpec = { kind: 'exe', executable: path, args: [] };
        const checked = await inspect(value, signal);
        const entry = await client.call<CollectedApp>('catalog', { path });
        if (signal.aborted || entry.contentFingerprint !== checked.identity.fingerprint) throw Error('workbench-installation-changed');
        return { scope: this.scope, entries: [entry], coverage: [{ source: 'explicit-operator-path', status: 'complete', inspected: 1, rejected: 0 }] };
      } });
  }
  private readonly available: boolean;
  taskAvailable() { return this.available && !this.closed; }
  ownsSession(value: WorkbenchTaskSession) { return this.sessions.has(value); }
  hasSessionIdentity(value: DesktopSessionIdentity) {
    return [...this.sessions].some(session => !session.closed && session.providerId === value.providerId && session.environmentId === value.environmentId &&
      session.sessionId === value.sessionId && session.instanceId === value.instanceId && session.inputResourceId === value.inputResourceId);
  }
  async discover() { return this.available && !this.closed ? [{ ...this.scope, kind: this.kind }] : []; }
  async capabilities() { return workbenchTaskCapabilities(); }
  async open(environmentId: string) {
    if (!this.taskAvailable() || environmentId !== this.scope.environmentId) throw Error('workbench-task-environment-unavailable');
    const value = await this.client.call<DesktopSessionIdentity>('task_session_open');
    const session = new WorkbenchTaskSession(this, value);
    this.sessions.add(session);
    if (this.closed) { await session.close(); throw Error('workbench-task-environment-closed'); }
    return session;
  }
  async close() {
    if (this.closed) return; this.closed = true;
    const results = await Promise.allSettled([...this.sessions].map(session => session.close()));
    await this.client.close();
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'workbench-task-cleanup-unconfirmed');
  }
}
export async function nativeWorkbenchApps(config: WorkbenchAppConfig | undefined, project: string, registry: string) {
  const identity = await readDashboardInstallationIdentity('python', resolve(project, 'scripts/dashboard-app-identity.py'));
  const scope = { providerId: 'workbench-apps', environmentId: 'local-workspace:apps', installationScopeId: identity };
  return new WorkbenchApps(config, identity, new NativeWorkbenchAppClient(config, scope, registry, project));
}
