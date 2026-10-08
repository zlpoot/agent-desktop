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
import type { AppDiscoveryCollector } from '../contracts/app-discovery.js';
import type { EnvironmentAppScope } from '../contracts/environment-apps.js';
import { discoveredEnvironment, sharedHostDiscovery } from './app-discovery.js';

/** Composition-owned ports; never supplied through HTTP, Task or a model. */
export interface DashboardReadonlyDiscovery {
  identity(): Promise<string>;
  collector(scope: EnvironmentAppScope): AppDiscoveryCollector;
}

export interface DashboardPreflightView {
  readonly mode: 'a1' | 'a2';
  readonly bridgePreview?: typeof import('./app-task-bridge.js').appBridgeCandidatePreview;
  readonly hostLabel: string;
  readonly configuration: 'explicit-operator-file';
  readonly localWorkspaceConfigured: boolean;
}

/** A1 has no Task controller, recovery, model, Worker, VM control or launch port.
 * Provider discovery is configuration enumeration, never native session readiness. */
export async function createDashboardPreflight(configPath: string, rootDir: string,
  synthetic?: { providers: readonly DesktopProvider[]; hostLabel: string; installationScopeId: string },
  readonlyDiscovery?: DashboardReadonlyDiscovery) {
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
  let installationScopeId = synthetic?.installationScopeId ?? `a1-unscanned:${createHash('sha256')
    .update(JSON.stringify([hostname(), userInfo().username])).digest('hex')}`;
  const mode = readonlyDiscovery ? 'a2' : 'a1';
  let identityAvailable = false;
  let apps: ReturnType<typeof composeEnvironmentApps> | undefined;
  let management: AppManagement | undefined;
  let closed = false;
  const unavailable = () => { throw new Error(`preflight-${mode}-operation-disabled`); };
  try {
    const environments = await sessions.discover();
    if (readonlyDiscovery) {
      try {
        const identity = await readonlyDiscovery.identity();
        if (!/^windows:[a-f0-9]{64}$/.test(identity)) throw new Error('invalid-installation-identity');
        installationScopeId = identity; identityAvailable = true;
      } catch { installationScopeId = 'a2-unavailable:host-identity'; }
    }
    const physical = environments.find(environment => environment.providerId === 'physical' && environment.kind === 'physical');
    const collector = readonlyDiscovery && identityAvailable && physical ? readonlyDiscovery.collector({
      providerId: physical.providerId, environmentId: physical.environmentId, installationScopeId,
    }) : undefined;
    apps = composeEnvironmentApps(store, environments.map(environment => {
      const scope = {
      providerId: environment.providerId, environmentId: environment.environmentId,
      // Guest installation domains must never alias the Host domain.
      installationScopeId: environment.kind === 'virtual-machine' ? `${mode}-unavailable:${environment.environmentId}` : installationScopeId,
      };
      if (collector && environment === physical) return discoveredEnvironment(scope, collector);
      if (collector && environment.kind === 'local-workspace' && environment.providerId === 'local-workspace') {
        return sharedHostDiscovery(scope, collector);
      }
      return { scope };
    }));
    management = new AppManagement(apps, () => sessions.discover());
    const controller: TaskController = {
      desktopOptions: () => sessions.discover(),
      async manageApps(body) {
        if (closed) throw new Error('preflight-closed');
        const allowed = mode === 'a2' ? ['open', 'list', 'close', 'cancel', 'scan', 'path'] : ['open', 'list', 'close', 'cancel'];
        if (!allowed.includes(String(body.action))) unavailable();
        const result = await management!.act(body);
        if (body.action === 'close' || body.action === 'cancel') return result;
        const target = body.desktopTarget as { providerId: string; environmentId: string };
        const provider = providers.find(item => item.id === target.providerId)!;
        const available = !!apps!.forEnvironment(target).discovery;
        const shared = target.providerId === 'local-workspace';
        return { ...(result as object), preflight: { mode, hostLabel,
          environmentStatus: 'configured; native-session-not-probed',
          installationOrigin: available ? shared ? 'shared-host-os' : 'selected-environment' : 'unavailable',
          discoveryReason: mode === 'a1'
            ? 'A1 尚未接入只读安装收集器；不可用不表示未安装。先完成环境选择体验并反馈，A2 再提供点击扫描。'
            : available ? '已接入只读收集器，只有点击扫描或指定路径才会读取应用信息；不会连接桌面或启动应用。'
              : target.providerId === 'hyper-v' ? '虚拟机安装清单未接入，不会扫描本机作为虚拟机结果；不可用不表示未安装。'
                : '无法核对本机安装域身份，请检查 Windows 和所指定 Python 的 pywin32 依赖，重启此服务后再试；不会使用未经核对的安装清单。不可用不表示未安装。',
          launchReason: `启动适配器未接入；${mode.toUpperCase()} 禁止启动、确认、任务执行、模型、输入和虚拟机控制。`,
          capabilities: await provider.capabilities() } };
      },
      submit: unavailable, resume: unavailable, pause: unavailable, continue: unavailable,
    };
    const view: DashboardPreflightView = { mode, hostLabel, configuration: 'explicit-operator-file',
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
