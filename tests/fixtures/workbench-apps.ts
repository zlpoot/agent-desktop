import type { WorkbenchAppClient, WorkbenchAppConfig } from '../../src/desktop-provider/workbench-apps.js';
import type { EnvironmentAppBinding, EnvironmentAppScope } from '../../src/contracts/environment-apps.js';
import { createHash, randomUUID } from 'node:crypto';
import { AppLaunchError } from '../../src/environment-apps/launcher.js';
export const config: WorkbenchAppConfig = { path: 'C:\\Synthetic\\cloudmusic.exe', sha256: 'a'.repeat(64), version: '3.1.40.205461' };
export const scope: EnvironmentAppScope = { providerId: 'workbench-apps', environmentId: 'local-workspace:apps', installationScopeId: 'windows:' + 'b'.repeat(64) };
export class FakeWorkbenchClient implements WorkbenchAppClient {
  private taskSessions = new Set<string>();
  calls: string[] = []; starts = 0; active = false; changed = false;
  ended = false; unknown = false; activeProfile?: EnvironmentAppBinding;
  conflict = false;
  windowFailure?: string;
  stops = 0; stopFailure = false; operatorClosed = false;
  reservationId?: string; expiresAt?: string; allocations = 0;
  releasedReservations: string[] = []; cleanupFailure = false;
  previews = 0; beforePreview?: () => Promise<void>;
  beforeStart?: () => Promise<void>;
  context = { scope, sessionId: 'fake-session', instanceId: 'fake-instance', windowsSessionId: 1, desktop: 'WinSta0\\AgentD0_App_fake' };
  identity = { productId: 'win32-binary:' + config.sha256, fingerprint: config.sha256, version: config.version };
  async call<T>(method: string, fields: any = {}): Promise<T> {
    this.calls.push(method);
    if (method === 'task_session_open') {
      const sessionId = randomUUID(); this.taskSessions.add(sessionId);
      return { providerId: scope.providerId, environmentId: scope.environmentId, sessionId,
        instanceId: 'synthetic-task-worker', inputResourceId: 'synthetic-task-input' } as T;
    }
    if (method === 'task_status' || method === 'task_session_close') {
      if (!this.taskSessions.has(fields.session?.sessionId)) throw Error('workbench-task-stale-session');
      if (method === 'task_status') return { state: 'open', readiness: {} } as T;
      this.taskSessions.delete(fields.session.sessionId); return undefined as T;
    }
    const profile = fields.profile as EnvironmentAppBinding;
    const path = fields.path ?? fields.spec?.executable ?? config.path;
    const fingerprint = path === config.path ? config.sha256 : createHash('sha256').update(path).digest('hex');
    const identity = { productId: 'win32-binary:' + fingerprint, fingerprint, version: path === config.path ? config.version : 'synthetic-2' };
    if (method === 'reserve') {
      if (!this.reservationId) {
        this.reservationId = fields.reservationId; this.allocations++;
        this.context = { ...this.context, sessionId: `fake-session-${this.allocations}`, instanceId: `fake-instance-${this.allocations}` };
        this.expiresAt = new Date(Date.now() + 60000).toISOString();
      }
      return this.context as T;
    }
    if (method === 'start' && this.reservationId !== fields.reservationId) throw new AppLaunchError('unavailable', 'workbench-app-in-use');
    if (method === 'instances' && this.active && this.activeProfile?.appBindingId !== profile.appBindingId) throw new AppLaunchError('unavailable', 'workbench-app-in-use');
    if (method === 'instances' && this.active && this.activeProfile?.profileDigest !== profile.profileDigest) throw new AppLaunchError('unavailable', 'workbench-original-profile-mismatch');
    if (method === 'release' || method === 'cleanup') {
      if (this.reservationId !== fields.reservationId) return { cleaned: true } as T;
      if (method === 'cleanup' && fields.token !== 'private-owned-app') throw Error('workbench-owned-token-required');
      if (this.cleanupFailure) { this.unknown = true; throw Error('workbench-cleanup-unconfirmed'); }
      this.releasedReservations.push(this.reservationId!); this.reservationId = undefined;
      if (this.active && this.windowFailure) this.ended = true;
      this.active = false;
      return { cleaned: true } as T;
    }
    if (method === 'preview') {
      this.previews++;
      await this.beforePreview?.();
      if (!this.active || this.ended || this.unknown || this.activeProfile?.appBindingId !== profile.appBindingId || this.activeProfile?.profileDigest !== profile.profileDigest) throw Error('workbench-preview-original-window-unavailable');
      return { png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4AWPQaDoBAAJIAXNHdacMAAAAAElFTkSuQmCC',
        width: 1, height: 1, capturedAt: new Date().toISOString(), expiresAt: this.expiresAt } as T;
    }
    if (method === 'inspect' && path.endsWith('Missing.exe')) throw new AppLaunchError('stale', 'app-installation-path-unavailable');
    if (method === 'start' && this.conflict) throw new AppLaunchError('unavailable', 'workbench-existing-user-instance');
    if (method === 'stop') {
      if (this.active && (this.activeProfile?.appBindingId !== profile.appBindingId || this.activeProfile?.profileDigest !== profile.profileDigest)) throw Error('workbench-stop-original-profile-required');
      this.stops++;
      if (this.stopFailure) throw Error('workbench-cleanup-unconfirmed');
      if (this.active) { this.active = false; this.ended = this.operatorClosed = true; this.reservationId = undefined; }
      return { cleaned: true } as T;
    }
    if (method === 'instances' && this.active && this.windowFailure) throw new AppLaunchError('unavailable', this.windowFailure);
    if (method === 'status' && this.ended && !this.active) this.reservationId = undefined;
    const result = method === 'inspect' ? { scope, launchSpec: fields.spec, identity }
      : method === 'catalog' ? { displayName: fields.path ? fields.path.split('\\').at(-1).replace(/\.exe$/i, '') : '网易云音乐', aliases: [], launchSpec: { kind: 'exe', executable: fields.path ?? config.path, args: [] },
        source: 'explicit-operator-config', version: identity.version, publisher: 'Synthetic Publisher', contentFingerprint: fingerprint }
      : method === 'current' ? { ...this.context, ...(this.changed ? { instanceId: 'changed' } : {}) }
      : method === 'start' ? (this.starts++, this.active = true, this.ended = this.operatorClosed = false, this.activeProfile = structuredClone(profile), 'private-owned-app')
      : method === 'status' ? { state: this.unknown ? 'unknown' : this.ended ? 'exited' : this.active && this.activeProfile?.appBindingId === profile.appBindingId ? 'window-confirmed' : 'saved',
        checkedAt: new Date().toISOString(), expiresAt: this.expiresAt, reason: this.ended ? this.operatorClosed ? 'workbench-operator-closed' : this.windowFailure ? 'workbench-owned-resources-cleaned' : 'workbench-resource-expired' : undefined }
      : method === 'instances' ? this.active ? [{ ...this.context, targetToken: 'private-owned-app', identity: this.activeProfile!.identity,
        executable: this.activeProfile!.launchSpec.kind === 'package' ? '' : this.activeProfile!.launchSpec.executable, args: [],
        processOwnedByInstallation: true, windowOwnedByProcess: true, sameUser: true, permissionsCompatible: true }] : []
      : method === 'close' ? (this.active = false, this.reservationId = undefined, { cleaned: true }) : undefined;
    if (method === 'start') await this.beforeStart?.();
    return result as T;
  }
  async close() { await this.call('close'); }
}
