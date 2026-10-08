import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRootAssembly } from '../../src/composition/root.js';
import { ScopedAppDiscovery } from '../../src/environment-apps/discovery.js';
import { AppLaunchError } from '../../src/environment-apps/launcher.js';
import { TaskDesktopSessions } from '../../src/app/task-desktop-sessions.js';
import { createDashboardServer } from '../../src/app/server.js';
import type { CollectedApp, AppCollection } from '../../src/contracts/app-discovery.js';
import type { ManagedAppLaunchBackend, AppInstanceEvidence, AppLaunchExecution } from '../../src/contracts/app-launch.js';
import type { EnvironmentAppBinding, EnvironmentAppScope } from '../../src/contracts/environment-apps.js';
import type { DesktopProvider } from '../../src/contracts/desktop-environment.js';

export class SyntheticAppEnvironment implements ManagedAppLaunchBackend {
  starts = 0; scans = 0; inspections = 0; cleanups = 0; running = false; offline = false; incomplete = false; unknown = false;
  beforeScan?: () => Promise<void>; beforeObserve?: () => Promise<void>;
  installed = { productId: 'synthetic-music', version: '1', fingerprint: 'synthetic-contents' };
  entries: CollectedApp[] = [{ displayName: 'AA音乐', aliases: ['QQ音乐'], launchSpec: {
    kind: 'exe', executable: 'C:\\Synthetic\\Music.exe', args: [] }, source: 'synthetic-menu',
    version: '1', publisher: 'Synthetic Publisher', contentFingerprint: 'synthetic-contents' }];
  constructor(readonly scope: EnvironmentAppScope) {}
  collection(): AppCollection { return { scope: this.scope, entries: this.offline ? [] : this.entries,
    coverage: [{ source: 'synthetic-menu', status: this.offline ? 'unavailable' : this.incomplete ? 'truncated' : 'complete',
      inspected: this.entries.length, rejected: 0, ...(this.offline ? { reason: 'synthetic-offline' } : {}) }] }; }
  async inspect(launchSpec: EnvironmentAppBinding['launchSpec']) {
    this.inspections++; if (this.offline) throw new AppLaunchError('unavailable', 'synthetic-offline');
    if (!this.entries.some(item => JSON.stringify(item.launchSpec) === JSON.stringify(launchSpec))) throw new AppLaunchError('stale', 'synthetic-installation-deleted');
    return { scope: this.scope, launchSpec, identity: this.installed };
  }
  async open(signal: AbortSignal): Promise<AppLaunchExecution> {
    if (this.offline) throw new AppLaunchError('unavailable', 'synthetic-offline');
    const context = { scope: this.scope, sessionId: 'synthetic-reservation', instanceId: 'synthetic-instance', windowsSessionId: 1, desktop: 'SyntheticDesktop' };
    const instances = (app: EnvironmentAppBinding): AppInstanceEvidence[] => !this.running || this.unknown || app.launchSpec.kind === 'package' ? [] : [{
      ...context, targetToken: 'private-synthetic-target', identity: this.installed, executable: app.launchSpec.executable,
      args: app.launchSpec.args, workingDirectory: app.launchSpec.workingDirectory,
      processOwnedByInstallation: true, windowOwnedByProcess: true, sameUser: true, permissionsCompatible: true }];
    return { context, assertCurrent: async () => { if (signal.aborted) throw new AppLaunchError('unavailable', 'synthetic-cancelled'); },
      inspect: spec => this.inspect(spec), instances: async app => instances(app), start: async () => {
        if (signal.aborted) throw new AppLaunchError('unavailable', 'synthetic-cancelled');
        this.starts++; this.running = true; return 'synthetic-owned'; },
      observe: async app => { await this.beforeObserve?.(); return instances(app); },
      cleanupOwned: async () => { this.cleanups++; this.running = false; }, close: async () => {} };
  }
}
export async function managementFixture(enabled = true, sharedSyntheticLaunch = false) {
  const dir = mkdtempSync(join(tmpdir(), 'p7e-synthetic-'));
  const scopes = [
    { providerId: 'hyper-v', environmentId: 'vm:a', installationScopeId: 'synthetic-a' },
    { providerId: 'hyper-v', environmentId: 'vm:b', installationScopeId: 'synthetic-b' },
    { providerId: 'physical', environmentId: 'host', installationScopeId: 'synthetic-host' },
    { providerId: 'local-workspace', environmentId: 'hidden', installationScopeId: 'synthetic-host' },
  ];
  const backends = scopes.map(scope => new SyntheticAppEnvironment(scope));
  const infrastructure = backends.map((backend, index) => {
    const scope = backend.scope, collectorScope = index === 3 ? scopes[2] : scope;
    const discovery = new ScopedAppDiscovery(scope, { scope: collectorScope, collect: async () => {
      backend.scans++; await backend.beforeScan?.(); return { ...backend.collection(), scope: collectorScope };
    }, inspectPath: async path => ({ ...backend.collection(), scope: collectorScope, entries: backend.offline ? [] : backend.entries.filter(item =>
      item.launchSpec.kind !== 'package' && (item.launchSpec.kind === 'shortcut' ? item.launchSpec.shortcutPath : item.launchSpec.executable) === path) }) },
    undefined, index === 3 ? 'shared-host-os' : 'selected-environment');
    return { scope, discovery, ...(index < 2 || sharedSyntheticLaunch ? { launchBackend: backend } : {}) };
  });
  let models = 0, runtime = 0, leases = 0;
  const assemble = () => {
    const providers = ['hyper-v', 'physical', 'local-workspace'].map(id => ({ id,
      kind: id === 'hyper-v' ? 'virtual-machine' : id === 'physical' ? 'physical' : 'local-workspace',
      capabilities: async () => ({}), discover: async () => scopes.filter(scope => scope.providerId === id).map(scope => ({
        providerId: scope.providerId, environmentId: scope.environmentId,
        kind: id === 'hyper-v' ? 'virtual-machine' : id === 'physical' ? 'physical' : 'local-workspace' })),
      open: async () => { throw new Error('management-must-not-open-task-session'); } } as DesktopProvider));
    const sessions = new TaskDesktopSessions(providers, new Map(providers.map(provider => [provider.id, {
      assertAvailable() { if (provider.id !== 'hyper-v') throw new Error(provider.id === 'physical'
        ? 'physical-generic-not-supported;native-dispatch-fence-missing' : 'local-workspace-managed-backend-owned-hidden-desktop-required'); },
      connectRuntime: async () => { runtime++; throw new Error('management-no-runtime'); },
      taskControl: () => { leases++; throw new Error('management-no-input'); },
    }])));
    return createRootAssembly({ rootDir: dir, environmentAppManagement: enabled, environmentApps: infrastructure, desktopSessions: sessions,
      model: { createModel: () => { models++; throw new Error('management-no-model'); } } });
  };
  let assembly = await assemble();
  const serve = async () => {
    const server = createDashboardServer(dir, assembly.controller);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
    return { server, base: `http://127.0.0.1:${address.port}` };
  };
  let { server, base } = await serve();
  const post = async (body: object, origin: string | null = base) => fetch(`${base}/api/desktop/apps`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  return { dir, scopes, backends, infrastructure, get base() { return base; }, get assembly() { return assembly; }, post,
    counts: () => ({ models, runtime, leases }),
    restart: async () => { await new Promise<void>(done => server.close(() => done())); await assembly.dispose();
      assembly = await assemble(); ({ server, base } = await serve()); },
    close: async () => { await new Promise<void>(done => server.close(() => done())); await assembly.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}
