import type { EnvironmentAppDiscovery, EnvironmentAppLauncher, EnvironmentAppScope,
  EnvironmentAppService, EnvironmentAppServices } from '../contracts/environment-apps.js';
import { desktopTarget, type TaskDesktopTarget } from '../contracts/task-desktop.js';
import { SqliteEnvironmentAppStore } from '../environment-apps/sqlite-registry.js';
import { sameAppScope, scopeValue } from '../environment-apps/validation.js';
import type { ManagedAppLaunchBackend } from '../contracts/app-launch.js';
import type { ReadonlyAppDiscovery } from '../contracts/app-discovery.js';
import { ControlledAppLauncher } from '../environment-apps/launcher.js';
import { AppOnboardingService } from '../environment-apps/onboarding.js';

export interface EnvironmentAppInfrastructure {
  readonly scope: EnvironmentAppScope;
  readonly discovery?: EnvironmentAppDiscovery;
  readonly launcher?: EnvironmentAppLauncher;
  readonly launchBackend?: ManagedAppLaunchBackend;
}
function key(target: TaskDesktopTarget): string {
  const checked = desktopTarget(target?.providerId, target?.environmentId);
  return JSON.stringify([checked.providerId, checked.environmentId]);
}
/** No provider-specific Core branch, fallback, discovery call or process startup. */
export function composeEnvironmentApps(store: SqliteEnvironmentAppStore,
  infrastructure: readonly EnvironmentAppInfrastructure[] = []): EnvironmentAppServices & { close(): Promise<void> } {
  const validated = infrastructure.map(entry => {
    const scope = scopeValue(entry.scope);
    for (const port of [entry.discovery, entry.launcher, entry.launchBackend]) {
      if (port && !sameAppScope(scopeValue(port.scope), scope)) throw new Error('app-port-environment-mismatch');
    }
    if (entry.launchBackend && (entry.launcher || typeof (entry.discovery as ReadonlyAppDiscovery)?.candidate !== 'function')) {
      throw new Error('managed-app-launch-requires-scoped-discovery');
    }
    return { ...entry, scope };
  });
  if (new Set(validated.map(entry => key(entry.scope))).size !== validated.length) {
    throw new Error('duplicate-app-environment');
  }
  const services = new Map<string, EnvironmentAppService>();
  for (const entry of validated) {
    const registry = store.bind(entry.scope), launcher = entry.launchBackend ? new ControlledAppLauncher(entry.launchBackend) : entry.launcher;
    const onboarding = entry.launchBackend ? new AppOnboardingService(registry, entry.discovery as ReadonlyAppDiscovery, launcher as ControlledAppLauncher) : undefined;
    services.set(key(entry.scope), Object.freeze({ registry, ...(entry.discovery ? { discovery: entry.discovery } : {}),
      ...(launcher ? { launcher } : {}), ...(onboarding ? { onboarding } : {}) }));
  }
  return Object.freeze({ async close() {
    const results = await Promise.allSettled([...services.values()].map(async service => {
      await service.onboarding?.close();
    }));
    const backends = await Promise.allSettled(validated.map(entry => entry.launchBackend?.close?.()));
    const failures = [...results, ...backends].filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason);
    if (failures.length) throw new AggregateError(failures, 'app-launch-drain-unconfirmed');
  }, forEnvironment(target: TaskDesktopTarget) {
    const service = services.get(key(target));
    if (!service) throw new Error('environment-app-service-unavailable');
    return service;
  } });
}
