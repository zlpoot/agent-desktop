import type { WorkbenchAppClient, WorkbenchAppConfig } from '../../src/desktop-provider/workbench-apps.js';
import type { EnvironmentAppBinding, EnvironmentAppScope } from '../../src/contracts/environment-apps.js';
export const config: WorkbenchAppConfig = { path: 'C:\\Synthetic\\cloudmusic.exe', sha256: 'a'.repeat(64), version: '3.1.40.205461' };
export const scope: EnvironmentAppScope = { providerId: 'workbench-apps', environmentId: 'local-workspace:apps', installationScopeId: 'windows:' + 'b'.repeat(64) };
export class FakeWorkbenchClient implements WorkbenchAppClient {
  calls: string[] = []; starts = 0; active = false; changed = false;
  context = { scope, sessionId: 'fake-session', instanceId: 'fake-instance', windowsSessionId: 1, desktop: 'WinSta0\\AgentD0_App_fake' };
  identity = { productId: 'win32-binary:' + config.sha256, fingerprint: config.sha256, version: config.version };
  async call<T>(method: string, fields: any = {}): Promise<T> {
    this.calls.push(method);
    const profile = fields.profile as EnvironmentAppBinding;
    const result = method === 'inspect' ? { scope, launchSpec: fields.spec, identity: this.identity }
      : method === 'catalog' ? { displayName: '网易云音乐', aliases: ['NetEase Cloud Music'], launchSpec: { kind: 'exe', executable: config.path, args: [] },
        source: 'explicit-operator-config', version: config.version, publisher: 'Synthetic Publisher', contentFingerprint: config.sha256 }
      : method === 'reserve' ? this.context : method === 'current' ? { ...this.context, ...(this.changed ? { instanceId: 'changed' } : {}) }
      : method === 'start' ? (this.starts++, this.active = true, 'private-owned-app')
      : method === 'instances' ? this.active ? [{ ...this.context, targetToken: 'private-owned-app', identity: this.identity,
        executable: profile.launchSpec.kind === 'package' ? '' : profile.launchSpec.executable, args: [],
        processOwnedByInstallation: true, windowOwnedByProcess: true, sameUser: true, permissionsCompatible: true }] : []
      : method === 'close' || method === 'cleanup' ? (this.active = false, { cleaned: true }) : undefined;
    return result as T;
  }
  async close() { await this.call('close'); }
}
