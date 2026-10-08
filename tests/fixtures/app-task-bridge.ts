import { randomUUID } from 'node:crypto';
import type { AppRuntimeContext, AppInstanceEvidence, ManagedAppLaunchBackend } from '../../src/contracts/app-launch.js';
import type { DesktopSession } from '../../src/contracts/desktop-environment.js';
import { SqliteEnvironmentAppStore } from '../../src/environment-apps/sqlite-registry.js';
import { ScopedAppDiscovery } from '../../src/environment-apps/discovery.js';
import { composeEnvironmentApps } from '../../src/composition/environment-apps.js';
import { createUnavailableAppTaskBridge } from '../../src/composition/app-task-bridge.js';

type Mutable<T> = T extends readonly (infer Item)[] ? Mutable<Item>[] : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;

export async function appTaskBridgeFixture(options: { close?: () => Promise<void> } = {}) {
  const scope = { providerId: 'local-workspace', environmentId: 'local-workspace:netease', installationScopeId: 'synthetic-os' };
  const identity = { productId: 'synthetic-product', version: '3.1.40.205461', fingerprint: 'synthetic-binary' };
  const spec = { kind: 'exe' as const, executable: 'C:\\Synthetic\\cloudmusic.exe', args: [], workingDirectory: 'C:\\Synthetic' };
  const counters = { inspections: 0, opens: 0, starts: 0, cleanups: 0, closes: 0, sessionStatus: 0 };
  const context: AppRuntimeContext = { scope, sessionId: randomUUID(), instanceId: randomUUID(), windowsSessionId: 7, desktop: 'WinSta0\\AgentD0_synthetic' };
  const instance: AppInstanceEvidence = { ...context, targetToken: randomUUID(), identity, executable: spec.executable, args: [], workingDirectory: spec.workingDirectory,
    processOwnedByInstallation: true, windowOwnedByProcess: true, sameUser: true, permissionsCompatible: true };
  const backend: ManagedAppLaunchBackend = { scope,
    inspect: async launchSpec => { counters.inspections++; return { scope, launchSpec, identity }; },
    open: async () => { counters.opens++; return { context,
      assertCurrent: async () => {}, inspect: async launchSpec => ({ scope, launchSpec, identity }),
      instances: async () => [structuredClone(instance)], observe: async () => [structuredClone(instance)],
      start: async () => { counters.starts++; throw new Error('synthetic-existing-instance-must-not-start'); },
      cleanupOwned: async () => { counters.cleanups++; }, close: async () => { counters.closes++; await options.close?.(); },
    }; } };
  const store = new SqliteEnvironmentAppStore(':memory:');
  const discovery = new ScopedAppDiscovery(scope, { scope, collect: async () => ({ scope,
    entries: [{ displayName: 'Synthetic NetEase', aliases: [], version: identity.version, contentFingerprint: identity.fingerprint,
      launchSpec: spec, source: 'synthetic-source' }], coverage: [{ source: 'synthetic-source', status: 'complete', inspected: 1, rejected: 0 }] }),
    inspectPath: async () => { throw new Error('no-extra-inspection'); } });
  const apps = composeEnvironmentApps(store, [{ scope, discovery, launchBackend: backend }]);
  const service = apps.forEnvironment(scope);
  const candidate = (await discovery.scan()).snapshots[0];
  const display = await service.onboarding!.prepare({ candidateId: candidate.candidateId, candidateRevision: candidate.revision });
  const outcome = await service.onboarding!.confirm({ confirmationId: display.confirmationId, digest: display.digest }, 'synthetic-operator');
  const profile = service.registry.get(display.appBindingId)!;
  const hooks: { status?: () => Promise<{ state: 'open' | 'stale' | 'closed'; readiness: {} }> } = {};
  const session: DesktopSession = { providerId: scope.providerId, environmentId: scope.environmentId,
    sessionId: 'synthetic-task-session', instanceId: 'synthetic-task-instance', inputResourceId: 'synthetic-resource',
    status: async () => { counters.sessionStatus++; return hooks.status ? hooks.status() : { state: 'open', readiness: {} }; },
    capabilities: async () => ({}), close: async () => { throw new Error('bridge-must-not-close-session'); } };
  const binding = () => ({ profile: structuredClone(profile) as Mutable<typeof profile>, target: structuredClone(outcome.target!) as Mutable<NonNullable<typeof outcome.target>>, assertCurrentTrust() {} });
  return { scope, store, apps, service, outcome, profile, session, hooks, counters, binding,
    bridge: createUnavailableAppTaskBridge(service), async close() { try { await apps.close(); } finally { store.close(); } } };
}
