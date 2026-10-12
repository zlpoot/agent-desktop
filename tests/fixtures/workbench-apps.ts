import type { WorkbenchAppClient, WorkbenchAppConfig } from '../../src/desktop-provider/workbench-apps.js';
import type { EnvironmentAppBinding, EnvironmentAppScope } from '../../src/contracts/environment-apps.js';
import { createHash } from 'node:crypto';
import { AppLaunchError } from '../../src/environment-apps/launcher.js';
export const config: WorkbenchAppConfig = { path: 'C:\\Synthetic\\cloudmusic.exe', sha256: 'a'.repeat(64), version: '3.1.40.205461' };
export const scope: EnvironmentAppScope = { providerId: 'workbench-apps', environmentId: 'local-workspace:apps', installationScopeId: 'windows:' + 'b'.repeat(64) };
export class FakeWorkbenchClient implements WorkbenchAppClient {
  calls: string[] = []; starts = 0; active = false; changed = false;
  ended = false; unknown = false; activeProfile?: EnvironmentAppBinding;
  conflict = false;
  previews = 0; beforePreview?: () => Promise<void>;
  context = { scope, sessionId: 'fake-session', instanceId: 'fake-instance', windowsSessionId: 1, desktop: 'WinSta0\\AgentD0_App_fake' };
  identity = { productId: 'win32-binary:' + config.sha256, fingerprint: config.sha256, version: config.version };
  async call<T>(method: string, fields: any = {}): Promise<T> {
    this.calls.push(method);
    const profile = fields.profile as EnvironmentAppBinding;
    const path = fields.path ?? fields.spec?.executable ?? config.path;
    const fingerprint = path === config.path ? config.sha256 : createHash('sha256').update(path).digest('hex');
    const identity = { productId: 'win32-binary:' + fingerprint, fingerprint, version: path === config.path ? config.version : 'synthetic-2' };
    if (method === 'preview') {
      this.previews++;
      await this.beforePreview?.();
      if (!this.active || this.ended || this.unknown || this.activeProfile?.appBindingId !== profile.appBindingId) throw Error('workbench-preview-original-window-unavailable');
      return { png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4AWPQaDoBAAJIAXNHdacMAAAAAElFTkSuQmCC',
        width: 1, height: 1, capturedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() } as T;
    }
    if (method === 'inspect' && path.endsWith('Missing.exe')) throw new AppLaunchError('stale', 'app-installation-path-unavailable');
    if (method === 'start' && this.conflict) throw new AppLaunchError('unavailable', 'workbench-existing-user-instance');
    const result = method === 'inspect' ? { scope, launchSpec: fields.spec, identity }
      : method === 'catalog' ? { displayName: fields.path ? fields.path.split('\\').at(-1).replace(/\.exe$/i, '') : '网易云音乐', aliases: [], launchSpec: { kind: 'exe', executable: fields.path ?? config.path, args: [] },
        source: 'explicit-operator-config', version: identity.version, publisher: 'Synthetic Publisher', contentFingerprint: fingerprint }
      : method === 'reserve' ? this.context : method === 'current' ? { ...this.context, ...(this.changed ? { instanceId: 'changed' } : {}) }
      : method === 'start' ? (this.starts++, this.active = true, this.activeProfile = profile, 'private-owned-app')
      : method === 'status' ? { state: this.unknown ? 'unknown' : this.ended ? 'exited' : this.active && this.activeProfile?.appBindingId === profile.appBindingId ? 'window-confirmed' : 'saved',
        checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), reason: this.ended ? 'workbench-resource-expired' : undefined }
      : method === 'instances' ? this.active ? [{ ...this.context, targetToken: 'private-owned-app', identity: profile.identity,
        executable: profile.launchSpec.kind === 'package' ? '' : profile.launchSpec.executable, args: [],
        processOwnedByInstallation: true, windowOwnedByProcess: true, sameUser: true, permissionsCompatible: true }] : []
      : method === 'close' || method === 'cleanup' ? (this.active = false, { cleaned: true }) : undefined;
    return result as T;
  }
  async close() { await this.call('close'); }
}
