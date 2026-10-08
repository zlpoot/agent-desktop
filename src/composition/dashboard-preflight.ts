import { hostname, userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { DesktopProvider } from '../contracts/desktop-environment.js';
import type { TaskController } from '../app/task-runner.js';
import { PhysicalDesktopProvider } from '../desktop-provider/physical-provider.js';
import { LocalWorkspaceDesktopProvider } from '../desktop-provider/local-workspace-provider.js';
import { ResourceInputControl } from '../desktop-provider/resource-input-control.js';
import { TaskDesktopSessions } from '../app/task-desktop-sessions.js';
import { AppManagement } from '../app/app-management.js';
import { SqliteEnvironmentAppStore } from '../environment-apps/sqlite-registry.js';
import { composeEnvironmentApps } from './environment-apps.js';
import { loadDesktopEnvironmentConfig } from './desktop-environment-config.js';

export interface DashboardPreflightView {
  readonly mode: 'a1';
  readonly hostLabel: string;
  readonly configuration: 'explicit-operator-file';
  readonly localWorkspaceConfigured: boolean;
}

/** A1 has no Task controller, recovery, model, Worker, VM control or launch port.
 * Provider discovery is configuration enumeration, never native session readiness. */
export async function createDashboardPreflight(configPath: string, rootDir: string,
  synthetic?: { providers: readonly DesktopProvider[]; hostLabel: string; installationScopeId: string }) {
  if (!configPath) throw new Error('preflight-explicit-config-required');
  const config = loadDesktopEnvironmentConfig(configPath);
  const input = new ResourceInputControl();
  const native = synthetic ? [] : [new PhysicalDesktopProvider(input),
    new LocalWorkspaceDesktopProvider(input, config.localWorkspace, resolve(rootDir, '.artifacts', 'preflight'), rootDir)];
  const providers: readonly DesktopProvider[] = synthetic?.providers ?? native;
  const sessions = new TaskDesktopSessions(providers, new Map());
  // Fresh ephemeral Registry only. Never import an existing private database or confirmation.
  const store = new SqliteEnvironmentAppStore(':memory:');
  const hostLabel = synthetic?.hostLabel ?? hostname();
  const installationScopeId = synthetic?.installationScopeId ?? `a1-unscanned:${createHash('sha256')
    .update(JSON.stringify([hostname(), userInfo().username])).digest('hex')}`;
  let apps: ReturnType<typeof composeEnvironmentApps> | undefined;
  let management: AppManagement | undefined;
  let closed = false;
  const unavailable = () => { throw new Error('preflight-a1-operation-disabled'); };
  try {
    const environments = await sessions.discover();
    apps = composeEnvironmentApps(store, environments.map(environment => ({ scope: {
      providerId: environment.providerId, environmentId: environment.environmentId,
      // Guest installation domains must never alias the Host domain.
      installationScopeId: environment.kind === 'virtual-machine' ? `a1-unavailable:${environment.environmentId}` : installationScopeId,
    } })));
    management = new AppManagement(apps, () => sessions.discover());
    const controller: TaskController = {
      desktopOptions: () => sessions.discover(),
      async manageApps(body) {
        if (closed) throw new Error('preflight-closed');
        if (!['open', 'list', 'close', 'cancel'].includes(String(body.action))) unavailable();
        const result = await management!.act(body);
        if (body.action === 'close' || body.action === 'cancel') return result;
        const target = body.desktopTarget as { providerId: string; environmentId: string };
        const provider = providers.find(item => item.id === target.providerId)!;
        return { ...(result as object), preflight: { mode: 'a1', hostLabel,
          environmentStatus: 'configured; native-session-not-probed',
          installationOrigin: 'unavailable: no installation collector connected',
          discoveryReason: 'A1 尚未接入只读安装收集器；不可用不表示未安装。先完成环境选择体验并反馈，A2 再提供点击扫描。',
          launchReason: '启动适配器未接入；A1 禁止启动、确认、Task、模型、输入和 VM 控制。',
          capabilities: await provider.capabilities() } };
      },
      submit: unavailable, resume: unavailable, pause: unavailable, continue: unavailable,
    };
    const view: DashboardPreflightView = { mode: 'a1', hostLabel, configuration: 'explicit-operator-file',
      localWorkspaceConfigured: !!config.localWorkspace };
    return { controller, view, async close() {
      if (closed) return; closed = true;
      try { await management!.close(); }
      finally { try { await apps!.close(); await sessions.close(); }
        finally { store.close(); await Promise.all(native.map(provider => provider.close())); } }
    } };
  } catch (error) {
    try { await management?.close(); await apps?.close(); await sessions.close(); }
    finally { store.close(); await Promise.all(native.map(provider => provider.close())); }
    throw error;
  }
}
