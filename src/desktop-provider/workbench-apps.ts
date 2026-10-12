import { resolve, win32 } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { DesktopProvider, DesktopCapabilities } from '../contracts/desktop-environment.js';
import type { EnvironmentAppScope, AppLaunchSpec } from '../contracts/environment-apps.js';
import type { ManagedAppLaunchBackend } from '../contracts/app-launch.js';
import { ScopedAppDiscovery } from '../environment-apps/discovery.js';
import type { CollectedApp } from '../contracts/app-discovery.js';
import { readDashboardInstallationIdentity } from '../composition/dashboard-discovery.js';

import { NativeWorkbenchAppClient, type WorkbenchAppClient } from './workbench-app-native-client.js';
import { createWorkbenchAppLaunchBackend } from './workbench-app-launch-backend.js';
export { NativeWorkbenchAppClient, type WorkbenchAppClient } from './workbench-app-native-client.js';

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
    this.launchBackend = createWorkbenchAppLaunchBackend({ scope: this.scope, spec, client,
      isClosed: () => this.closed, close: () => this.close() });
    const inspect = this.launchBackend.inspect;
    this.discovery = new ScopedAppDiscovery(this.scope, { scope: this.scope,
      collect: async (_limits, signal) => {
        const checked = await inspect(spec, signal);
        const entry = await client.call<CollectedApp>('catalog');
        if (signal.aborted || entry.contentFingerprint !== checked.identity.fingerprint) throw Error('workbench-installation-changed');
        return { scope: this.scope, entries: [entry],
          coverage: [{ source: 'explicit-operator-config', status: 'complete', inspected: 1, rejected: 0 }] };
      }, inspectPath: async () => { throw Error('workbench-configured-app-only'); } });
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
