import type { EnvironmentAppDiscovery, EnvironmentAppLauncher, EnvironmentAppScope,
  EnvironmentAppService, EnvironmentAppServices } from '../contracts/environment-apps.js';
import { desktopTarget, type TaskDesktopTarget } from '../contracts/task-desktop.js';
import { SqliteEnvironmentAppStore } from '../environment-apps/sqlite-registry.js';
import { sameAppScope, scopeValue } from '../environment-apps/validation.js';

export interface EnvironmentAppInfrastructure {
  readonly scope: EnvironmentAppScope;
  readonly discovery?: EnvironmentAppDiscovery;
  readonly launcher?: EnvironmentAppLauncher;
}
function key(target: TaskDesktopTarget): string {
  const checked = desktopTarget(target?.providerId, target?.environmentId);
  return JSON.stringify([checked.providerId, checked.environmentId]);
}
/** No provider-specific Core branch, fallback, discovery call or process startup. */
export function composeEnvironmentApps(store: SqliteEnvironmentAppStore,
  infrastructure: readonly EnvironmentAppInfrastructure[] = []): EnvironmentAppServices {
  const validated = infrastructure.map(entry => {
    const scope = scopeValue(entry.scope);
    for (const port of [entry.discovery, entry.launcher]) {
      if (port && !sameAppScope(scopeValue(port.scope), scope)) throw new Error('app-port-environment-mismatch');
    }
    return { ...entry, scope };
  });
  if (new Set(validated.map(entry => key(entry.scope))).size !== validated.length) {
    throw new Error('duplicate-app-environment');
  }
  const services = new Map<string, EnvironmentAppService>();
  for (const entry of validated) services.set(key(entry.scope), Object.freeze({ registry: store.bind(entry.scope),
    ...(entry.discovery ? { discovery: entry.discovery } : {}), ...(entry.launcher ? { launcher: entry.launcher } : {}) }));
  return Object.freeze({ forEnvironment(target: TaskDesktopTarget) {
    const service = services.get(key(target));
    if (!service) throw new Error('environment-app-service-unavailable');
    return service;
  } });
}
