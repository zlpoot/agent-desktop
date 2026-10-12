import type { AppLaunchSpec, EnvironmentAppBinding, EnvironmentAppScope } from '../contracts/environment-apps.js';
import type { AppInstallationCheck, AppInstanceEvidence, AppLaunchExecution, AppRuntimeContext, ManagedAppLaunchBackend } from '../contracts/app-launch.js';
import { AppLaunchError } from '../environment-apps/launcher.js';
import { launchDefinition } from '../environment-apps/launcher.js';
import type { WorkbenchAppClient } from './workbench-app-native-client.js';
import { randomUUID } from 'node:crypto';

/** Keeps configured-App admission and original-resource checks at each native boundary. */
export function createWorkbenchAppLaunchBackend(options: {
  scope: EnvironmentAppScope;
  client: WorkbenchAppClient;
  isClosed(): boolean;
  close(): Promise<void>;
}): ManagedAppLaunchBackend {
  const { scope, client, isClosed, close } = options;

  async function inspectInstalledApp(value: AppLaunchSpec, signal: AbortSignal): Promise<AppInstallationCheck> {
    launchDefinition(value);
    if (isClosed() || signal.aborted || value.kind !== 'exe' || value.args.length || value.workingDirectory) {
      throw new AppLaunchError('unavailable', 'workbench-no-argument-exe-only');
    }
    const checked = await client.call<AppInstallationCheck>('inspect', { spec: value });
    if (signal.aborted || isClosed()) throw new AppLaunchError('unavailable', 'workbench-app-cancelled');
    return checked;
  }

  async function reserveExecution(signal: AbortSignal): Promise<AppLaunchExecution> {
    if (isClosed() || signal.aborted) throw Error('workbench-app-cancelled');
    // Native remembers which request created the resources. A reused context
    // permits observation only; its caller cannot release the original owner.
    const reservationId = randomUUID();
    const context = await client.call<AppRuntimeContext>('reserve', { reservationId });
    let owned: string | undefined;

    async function assertCurrent() {
      if (isClosed() || signal.aborted) throw Error('workbench-app-cancelled');
      const actual = await client.call<AppRuntimeContext>('current');
      if (JSON.stringify(actual) !== JSON.stringify(context)) throw Error('workbench-original-context-changed');
    }
    async function instances(profile: EnvironmentAppBinding) {
      await assertCurrent();
      const values = await client.call<AppInstanceEvidence[]>('instances', { profile });
      await assertCurrent();
      return values;
    }
    async function startOwnedApp(profile: EnvironmentAppBinding) {
      await assertCurrent();
      owned = await client.call<string>('start', { profile, reservationId });
      await assertCurrent();
      return owned;
    }
    async function observeOwnedApp(profile: EnvironmentAppBinding, token?: string) {
      if (token !== owned) throw Error('workbench-owned-token-required');
      const until = Date.now() + 8000;
      while (Date.now() < until) {
        const values = await instances(profile);
        if (values.length) {
          // Window fitting is part of the explicit start, never a status/preview
          // poll. Keep the original capture bounds and never move another APP.
          await client.call('fit', { profile, token: owned });
          return instances(profile);
        }
        await new Promise(done => setTimeout(done, 50));
      }
      throw new AppLaunchError('unknown', 'workbench-original-window-unavailable');
    }
    async function cleanupOwnedApp(token: string) {
      if (!owned || token !== owned) throw Error('workbench-owned-token-required');
      await client.call('cleanup', { token, reservationId });
    }
    async function closeExecution(keep?: boolean) {
      try { if (!keep || signal.aborted) await client.call('release', { reservationId }); }
      catch (error) {
        console.error('Workbench close diagnostic:', JSON.stringify({
          exception: error instanceof Error ? error.name : 'unknown',
          code: error instanceof Error && /^[a-z][a-z0-9-]{1,100}$/.test(error.message) ? error.message : 'workbench-close-failed',
        }));
        throw error;
      }
    }
    return { context, assertCurrent, inspect: value => inspectInstalledApp(value, signal), instances,
      start: startOwnedApp, observe: observeOwnedApp, cleanupOwned: cleanupOwnedApp, close: closeExecution };
  }
  return { scope, inspect: inspectInstalledApp, open: reserveExecution, close };
}
