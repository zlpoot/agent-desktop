import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import type { AppLaunchSpec, EnvironmentAppBinding, EnvironmentAppScope } from '../contracts/environment-apps.js';
import type { AppInstallationCheck, AppLaunchExecution, AppRuntimeContext, ManagedAppLaunchBackend } from '../contracts/app-launch.js';
import { AppLaunchError, launchDefinition } from './launcher.js';
import { sameAppScope, scopeValue, textValue } from './validation.js';

export interface AppLaunchTransport {
  request(operation: string, fields: Record<string, unknown>, signal: AbortSignal): Promise<any>;
  close(): Promise<void>;
}
/** Persistent managed native helper. Fixed script, structured stdin, no shell/focus/input. */
export class WindowsAppLaunchTransport implements AppLaunchTransport {
  private process?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private next = 0;
  private closed = false;
  constructor(private readonly scope: EnvironmentAppScope, private readonly python = 'python',
    private readonly script = resolve('guest/app_launch.py')) {
    scopeValue(scope); if (scope.providerId !== 'physical') throw new Error('physical-launch-scope-required');
  }
  private connect() {
    if (this.closed) throw new AppLaunchError('unavailable', 'app-launch-transport-closed');
    if (this.process) return this.process;
    const child = spawn(this.python, [this.script], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process = child;
    const fail = () => { this.closed = true; for (const waiting of this.pending.values()) waiting.reject(new AppLaunchError('unknown', 'app-launch-helper-disconnected'));
      this.pending.clear(); };
    child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail); child.stderr.on('data', () => {});
    createInterface({ input: child.stdout }).on('line', line => {
      if (Buffer.byteLength(line) > 262144) { child.kill(); fail(); return; }
      let value: any; try { value = JSON.parse(line); } catch { child.kill(); fail(); return; }
      const waiting = this.pending.get(value.id); if (!waiting) return;
      this.pending.delete(value.id);
      if (value.error) waiting.reject(new AppLaunchError(['stale', 'unavailable', 'unknown'].includes(value.kind) ? value.kind : 'unknown',
        typeof value.error === 'string' ? value.error : 'app-launch-helper-error')); else waiting.resolve(value.result);
    });
    return child;
  }
  request(operation: string, fields: Record<string, unknown>, signal: AbortSignal): Promise<any> {
    if (signal.aborted) return Promise.reject(new AppLaunchError('unavailable', 'app-launch-cancelled'));
    const child = this.connect(), id = ++this.next;
    return new Promise((accept, reject) => {
      // Do not kill a helper during an effect: await its bounded response, then drain/cleanup.
      const timer = setTimeout(() => { this.pending.delete(id); this.closed = true; child.kill();
        reject(new AppLaunchError('unknown', 'app-launch-helper-timeout')); }, 31000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); accept(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.stdin.write(JSON.stringify({ id, operation, scope: this.scope, ...fields }) + '\n');
    });
  }
  async close(): Promise<void> {
    if (this.pending.size) throw new Error('app-launch-transport-drain-unconfirmed');
    this.closed = true; this.process?.stdin.end();
    const child = this.process;
    if (child && child.exitCode === null) await new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('app-launch-helper-close-unconfirmed')); }, 3000);
      child.once('exit', () => { clearTimeout(timer); accept(); });
    });
  }
}
/** Guest capability is negotiated independently of action RPC. No Host stat/fallback.
 * The authenticated channel is a trusted Host management channel, never a browser/model API. */
export class GuestAppLaunchTransport implements AppLaunchTransport {
  private readonly endpoint: string;
  constructor(private readonly scope: EnvironmentAppScope, endpoint: string, private readonly token: string,
    private readonly vmId: string, private readonly managementKey: string) {
    scopeValue(scope);
    if (scope.providerId !== 'hyper-v' || scope.environmentId !== `vm:${vmId.toLowerCase()}` || !token ||
        typeof managementKey !== 'string' || managementKey.length < 32 || /[\r\n]/.test(managementKey)) throw new Error('guest-launch-scope-or-management-credential-mismatch');
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid-app-guest-endpoint');
    this.endpoint = url.origin;
  }
  private async json(response: Response): Promise<any> {
    if (!response.ok || !response.body) throw new AppLaunchError('unavailable', `guest-app-launch-http-${response.status}`);
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const item = await reader.read(); if (item.done) break;
      size += item.value.length; if (size > 262144) throw new AppLaunchError('unknown', 'guest-app-launch-reply-limit'); chunks.push(item.value); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { await reader.cancel(); }
  }
  async request(operation: string, fields: Record<string, unknown>, signal: AbortSignal): Promise<any> {
    // Drain operations remain possible after local cancellation; remote execution is bounded.
    const bounded = AbortSignal.timeout(31000), options = { signal: bounded, redirect: 'error' as const,
      headers: { Authorization: `Bearer ${this.token}`, 'X-Agent-Desktop-App-Launch-Key': this.managementKey, 'Content-Type': 'application/json' } };
    if (signal.aborted && !['release', 'cleanup'].includes(operation)) throw new AppLaunchError('unavailable', 'app-launch-cancelled');
    const state = await this.json(await fetch(`${this.endpoint}/state`, options));
    if (state.vm_id !== this.vmId || state.app_launch?.protocolVersion !== 1 || !sameAppScope(scopeValue(state.app_launch.scope), this.scope)) {
      throw new AppLaunchError('unavailable', 'guest-app-launch-unsupported-or-identity-mismatch');
    }
    const reply = await this.json(await fetch(`${this.endpoint}/apps/launch`, { ...options, method: 'POST',
      body: JSON.stringify({ protocolVersion: 1, scope: this.scope, operation, ...fields }) }));
    if (reply.protocolVersion !== 1 || !sameAppScope(scopeValue(reply.scope), this.scope)) throw new AppLaunchError('unknown', 'guest-app-launch-identity-changed');
    if (reply.error) throw new AppLaunchError(['stale', 'unavailable', 'unknown'].includes(reply.kind) ? reply.kind : 'unknown', reply.error);
    return reply.result;
  }
  async close(): Promise<void> {} // No process/Session owned by this transport.
}
export class RpcAppLaunchBackend implements ManagedAppLaunchBackend {
  readonly scope: EnvironmentAppScope;
  constructor(scope: EnvironmentAppScope, private readonly transport: AppLaunchTransport,
    private readonly assertWindowManagementAllowed: () => Promise<void>) {
    this.scope = scopeValue(scope);
    if (!['physical', 'hyper-v'].includes(scope.providerId)) throw new Error('native-app-launch-environment-unsupported');
  }
  inspect(spec: AppLaunchSpec, signal: AbortSignal): Promise<AppInstallationCheck> {
    launchDefinition(spec); return this.transport.request('inspect', { launchSpec: spec }, signal);
  }
  async open(signal: AbortSignal): Promise<AppLaunchExecution> {
    await this.assertWindowManagementAllowed();
    const { reservationId, context } = await this.transport.request('reserve', {}, signal);
    let stage: { appBindingId: string; profileRevision: number; profileDigest: string; stageId: string; permitId: string } | undefined;
    const call = (operation: string, fields: Record<string, unknown> = {}, drain = false) =>
      this.transport.request(operation, { reservationId, ...fields }, drain ? new AbortController().signal : signal);
    const staged = async (profile: EnvironmentAppBinding) => {
      if (stage && (stage.appBindingId !== profile.appBindingId || stage.profileRevision !== profile.profileRevision || stage.profileDigest !== profile.profileDigest)) throw new Error('app-launch-stage-mismatch');
      if (!stage) stage = { appBindingId: profile.appBindingId, profileRevision: profile.profileRevision, profileDigest: profile.profileDigest,
        ...await call('stage', { profile: { appBindingId: profile.appBindingId, profileRevision: profile.profileRevision,
          profileDigest: profile.profileDigest, launchSpec: profile.launchSpec, identity: profile.identity } }) };
      return stage!;
    };
    return { context,
      assertCurrent: async () => { await this.assertWindowManagementAllowed(); await call('current'); },
      inspect: spec => call('inspect', { launchSpec: spec }),
      instances: async profile => call('instances', { stageId: (await staged(profile)).stageId }),
      start: async profile => { await this.assertWindowManagementAllowed(); const value = await staged(profile);
        // Staging is asynchronous: a revoke while it runs must win before start is sent.
        await this.assertWindowManagementAllowed();
        return call('start', { stageId: value.stageId, permitId: value.permitId }); },
      observe: async (profile, ownedToken) => call('observe', { stageId: (await staged(profile)).stageId, ...(ownedToken ? { ownedToken } : {}) }),
      cleanupOwned: token => call('cleanup', { ownedToken: token }, true),
      close: async keepTarget => {
        const result = await call('release', { keepTarget: keepTarget === true && !signal.aborted }, true);
        if (keepTarget && result?.targetKept !== true) throw new AppLaunchError('unknown', 'app-target-invalidated-during-drain');
      } };
  }
  close(): Promise<void> { return this.transport.close(); }
}
/** Supplied only by trusted composition from the selected Workspace's owned runtime records.
 * current must revalidate ownership/readiness; launch-backend self-reported context is not its source. */
export interface OwnedWorkspaceAppLaunchBinding {
  readonly scope: EnvironmentAppScope;
  current(): Promise<AppRuntimeContext>;
}
/** Existing Local Workspace launch mechanisms only. Configuration is supplied by trusted
 * composition, not discovered names. No Default Desktop or native Win32 fallback. */
export class LocalWorkspaceAppLaunchBackend implements ManagedAppLaunchBackend {
  readonly scope: EnvironmentAppScope;
  constructor(private readonly backend: ManagedAppLaunchBackend,
    private readonly profiles: readonly { mechanism: 'netease'; launchSpec: AppLaunchSpec }[],
    private readonly ownedWorkspace?: OwnedWorkspaceAppLaunchBinding) {
    this.scope = scopeValue(backend.scope);
    if (this.scope.providerId !== 'local-workspace' || profiles.some(item => item.mechanism !== 'netease')) throw new Error('invalid-workspace-launch-mapping');
    if (ownedWorkspace && !sameAppScope(scopeValue(ownedWorkspace.scope), this.scope)) throw new Error('workspace-owner-scope-mismatch');
    profiles.forEach(item => {
      launchDefinition(item.launchSpec);
      if (item.launchSpec.kind !== 'exe' || !/[\\/]cloudmusic\.exe$/i.test(item.launchSpec.executable) ||
          item.launchSpec.args.length || item.launchSpec.workingDirectory) throw new Error('invalid-workspace-launch-mapping');
    });
  }
  private ownedContext(value: AppRuntimeContext): AppRuntimeContext {
    if (!value || !sameAppScope(scopeValue(value.scope), this.scope) ||
        !Number.isSafeInteger(value.windowsSessionId) || value.windowsSessionId < 0 ||
        typeof value.desktop !== 'string' || !/^WinSta0\\AgentD0_[a-z0-9_-]+$/i.test(value.desktop)) {
      throw new AppLaunchError('unavailable', 'workspace-owned-hidden-desktop-unproven');
    }
    textValue(value.sessionId); textValue(value.instanceId);
    return structuredClone(value);
  }
  private matchesOwned(value: AppRuntimeContext, expected: AppRuntimeContext): void {
    this.ownedContext(value);
    if (!sameAppScope(value.scope, expected.scope) || value.sessionId !== expected.sessionId ||
        value.instanceId !== expected.instanceId || value.windowsSessionId !== expected.windowsSessionId || value.desktop !== expected.desktop) {
      throw new AppLaunchError('unavailable', 'workspace-owned-runtime-mismatch');
    }
  }
  private supported(spec: AppLaunchSpec) {
    if (!this.profiles.some(item => launchDefinition(item.launchSpec) === launchDefinition(spec))) throw new AppLaunchError('unavailable', 'workspace-app-launch-unsupported');
  }
  async inspect(spec: AppLaunchSpec, signal: AbortSignal) {
    this.supported(spec); const checked = await this.backend.inspect(spec, signal);
    if (checked.identity.version !== '3.1.40.205461') throw new AppLaunchError('unavailable', 'workspace-app-version-unsupported');
    return checked;
  }
  async open(signal: AbortSignal): Promise<AppLaunchExecution> {
    if (!this.ownedWorkspace) throw new AppLaunchError('unavailable', 'workspace-owned-runtime-binding-unavailable');
    const expected = this.ownedContext(await this.ownedWorkspace.current());
    const value = await this.backend.open(signal);
    const current = async () => {
      if (signal.aborted) throw new AppLaunchError('unavailable', 'workspace-app-launch-cancelled');
      await value.assertCurrent();
      this.matchesOwned(await this.ownedWorkspace!.current(), expected);
      this.matchesOwned(value.context, expected);
    };
    try { await current(); }
    catch (error) { await value.close(false); throw error; }
    return { get context() { return value.context; }, assertCurrent: current,
      inspect: async spec => { this.supported(spec); await current(); return value.inspect(spec); },
      instances: async profile => { this.supported(profile.launchSpec); await current(); const values = await value.instances(profile);
        await current(); for (const instance of values) this.matchesOwned(instance, expected); return values; },
      start: async profile => { this.supported(profile.launchSpec); await current(); return value.start(profile); },
      observe: async (profile, token) => { this.supported(profile.launchSpec); await current(); const values = await value.observe(profile, token);
        await current(); for (const instance of values) this.matchesOwned(instance, expected); return values; },
      cleanupOwned: token => value.cleanupOwned(token), close: async keepTarget => {
        if (keepTarget) { try { await current(); } catch (error) { await value.close(false); throw error; } }
        await value.close(keepTarget);
      } };
  }
  async close(): Promise<void> { await this.backend.close?.(); }
}
