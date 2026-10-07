import type { EnvironmentAppScope } from '../contracts/environment-apps.js';
import type { AppDiscoveryCollector, AppScanLimits } from '../contracts/app-discovery.js';
import { ScopedAppDiscovery, defaultAppScanLimits } from '../environment-apps/discovery.js';
import type { EnvironmentAppInfrastructure } from './environment-apps.js';

export function discoveredEnvironment(scope: EnvironmentAppScope, collector: AppDiscoveryCollector,
  limits: AppScanLimits = defaultAppScanLimits): EnvironmentAppInfrastructure {
  return { scope, discovery: new ScopedAppDiscovery(scope, collector, limits) };
}
/** Explicit same-OS mapping only. Does not open a Workspace Session or create a Desktop. */
export function sharedHostDiscovery(workspace: EnvironmentAppScope, physicalCollector: AppDiscoveryCollector,
  limits: AppScanLimits = defaultAppScanLimits): EnvironmentAppInfrastructure {
  return { scope: workspace, discovery: new ScopedAppDiscovery(workspace, physicalCollector, limits, 'shared-host-os') };
}
