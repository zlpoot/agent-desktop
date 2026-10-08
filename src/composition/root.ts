import { Context, type Plugin } from "cordis";
import { resolve } from "node:path";
import { DesktopTaskController } from "../app/task-runner.js";
import { TaskDesktopSessions } from '../app/task-desktop-sessions.js';
import { DesktopSessionManager } from "../desktop-session/session-manager.js";
import { HyperVVmControl, type VmControl } from "../desktop-session/vm-control.js";
import { recoverDesktopTasks } from "../desktop-session/recovery.js";
import { configuredModelProvider, configuredVerifier } from "../agent/local-config.js";
import { GuestDesktopRuntime } from "../runtime/desktop/guest-runtime.js";
import { SqliteTrace } from "../trace/sqlite-trace.js";
import { WorkflowStore } from "../workflows/store.js";
import { createDefaultExtensionRegistry } from "../extensions/index.js";
import type { ExtensionRegistry } from "../contracts/extension.js";
import { FacetRegistry } from "../contracts/facets.js";
import { ContributorRegistry } from "../contracts/verifier-contributor.js";
import { createDomainEvaluator } from "../verification/domain-evaluator.js";
import type { DesktopProvider } from "../contracts/desktop-provider.js";
import type { DesktopProvider as EnvironmentProvider } from "../contracts/desktop-environment.js";
import { HyperVDesktopProvider } from "../desktop-provider/hyperv-provider.js";
import { PhysicalDesktopProvider, type PhysicalBackendFactory } from "../desktop-provider/physical-provider.js";
import { PhysicalTaskExecutor } from '../desktop-provider/physical-task-executor.js';
import { LocalWorkspaceTaskExecutor } from '../desktop-provider/local-workspace-task-executor.js';
import { registeredGuestApps } from '../runtime/desktop/app-catalog.js';
import { ResourceInputControl } from "../desktop-provider/resource-input-control.js";
import { LocalWorkspaceDesktopProvider, type LocalWorkspaceAppConfig,
  type LocalWorkspaceBackendFactory } from "../desktop-provider/local-workspace-provider.js";
import type { PhysicalInputPolicy } from "../runtime/desktop/desktop-runtime.js";
import type { ModelProvider } from "../contracts/model-provider.js";
import type { TraceStore, WorkflowStore as WorkflowStoreContract } from "../contracts/stores.js";
import type { WorkerClientFactory } from "../contracts/worker-client.js";
import "./services.js";
import { mountInspected, inspectAssembly, type AssemblySnapshot } from './inspection.js';
import { composeEnvironmentApps, type EnvironmentAppInfrastructure } from './environment-apps.js';
import { SqliteEnvironmentAppStore } from '../environment-apps/sqlite-registry.js';
import type { EnvironmentAppServices } from '../contracts/environment-apps.js';

/**
 * 控制总线：DesktopSessionManager 的 controlMessage/controlDisconnected 是单回调，
 * 装配层在此按 sessionId 分发到各 Session 作用域的输入控制，并随作用域卸载移除。
 * 作用域卸载后（或从未挂载时）任何控制消息都被拒绝——旧输入不会命中旧作用域。
 */
export interface ControlBus {
  close(): void;
  /** Track idempotent Session cleanup independently of Cordis' concurrent disposers. */
  trackSession(cleanup: () => Promise<void>): () => Promise<void>;
  disposeSessions(): Promise<void>;
  set(sessionId: string, handler: (clientId: string, raw: unknown) => Promise<unknown>,
    disconnected: (clientId: string) => Promise<void>): void;
  remove(sessionId: string): void;
  /** 按 session 派发控制消息（manager 的 controlMessage 同路径）；无处理器时拒绝。 */
  dispatch(sessionId: string, clientId: string, raw: unknown): Promise<unknown>;
  /** 按 session 派发断开事件（manager 的 controlDisconnected 同路径）。 */
  dispatchDisconnect(sessionId: string, clientId: string): Promise<void>;
}

export interface RootAssemblyOptions {
  rootDir: string;
  /** Trusted environment/installation scope adapters. P7-A production default is empty. */
  environmentApps?: readonly EnvironmentAppInfrastructure[];
  /** Enable private Dashboard app management only through trusted assembly. */
  environmentAppManagement?: boolean;
  model?: ModelProvider;
  /** Synthetic registry port; production registers Hyper-V and explicitly configured Physical executors. */
  desktopSessions?: TaskDesktopSessions;
  traceStore?: (path: string) => TraceStore;
  workflowStore?: (path: string) => WorkflowStoreContract;
  workerClientFactory?: WorkerClientFactory;
  extensionRegistry?: ExtensionRegistry;
  desktop?: DesktopProvider;
  vmControl?: VmControl;
  physicalBackendFactory?: PhysicalBackendFactory;
  physicalInputPolicy?: PhysicalInputPolicy;
  localWorkspace?: LocalWorkspaceAppConfig;
  localWorkspaceBackendFactory?: LocalWorkspaceBackendFactory;
  /** 装配完成后追加的插件（测试注入用）；任一失败即回收整个 Root。 */
  extraPlugins?: Plugin[];
}

export interface RootAssembly {
  inspect(): AssemblySnapshot;
  root: Context;
  controller: DesktopTaskController;
  desktop?: DesktopProvider;
  vmControl?: VmControl;
  controlBus: ControlBus;
  environmentProviders: readonly EnvironmentProvider[];
  environmentApps: EnvironmentAppServices;
  /** 拒绝新任务/控制，等待任务收尾，再释放 Session 与基础设施。 */
  dispose(): Promise<void>;
}

/**
 * 集中装配层：创建 Root Context，按依赖序注册基础设施服务与任务控制器。
 * 生命周期契约（Cordis fiber 语义）：
 * - 任一插件初始化失败，Cordis 仍执行该插件已注册的 disposer；装配层随后 dispose
 *   整个 Root，回收全部已创建资源，再向上抛出原错误；
 * - assembly.dispose() 先等待控制器停止队列，再卸载 Cordis 作用域；
 *   Session 的独立卸载也必须等待使用该输入控制的任务收尾。
 */
export async function createRootAssembly(options: RootAssemblyOptions): Promise<RootAssembly> {
  const rootDir = resolve(options.rootDir);
  const root = new Context();
  const controlBus = createControlBus();
  let controller: DesktopTaskController | undefined;
  let closing: Promise<void> | undefined;
  const dispose = () => {
    if (closing) return closing;
    controlBus.close();
    closing = (async () => {
      // Task cleanup must finish while its Session and storage services still exist.
      try { await controller?.close(); }
      finally {
        try { await controlBus.disposeSessions(); }
        finally { await root.fiber.dispose(); }
      }
    })();
    return closing;
  };
  try {
    await mountInspected(root, {
      name: "infrastructure",
      apply(ctx) {
        const extensionRegistry = options.extensionRegistry ?? createDefaultExtensionRegistry({ rootDir });
        const modelProvider = options.model ?? configuredModelProvider();
        const traceStore = options.traceStore ?? ((path: string) => new SqliteTrace(path));
        const workflowStore = options.workflowStore ?? ((path: string) => new WorkflowStore(path));
        const workerClientFactory = options.workerClientFactory ?? GuestDesktopRuntime.connect;
        const desktop = options.desktop ?? new DesktopSessionManager(rootDir, process.env.AGENT_DESKTOP_TOKEN ?? "");
        const hyperVCompatibility = new HyperVDesktopProvider(desktop, process.env.AGENT_DESKTOP_TOKEN ?? "");
        const managedInput = new ResourceInputControl();
        const physicalCompatibility = new PhysicalDesktopProvider(managedInput,
          options.physicalBackendFactory, options.physicalInputPolicy, options.physicalBackendFactory ? true : undefined);
        const localWorkspaceCompatibility = new LocalWorkspaceDesktopProvider(managedInput, options.localWorkspace,
          resolve(rootDir, ".artifacts", "local-workspace", "provider"), resolve("."),
          options.localWorkspaceBackendFactory,
          options.localWorkspaceBackendFactory ? true : undefined);
        const vmControl = options.vmControl
          ?? (process.env.AGENT_DESKTOP_VM_ID ? new HyperVVmControl(process.env.AGENT_DESKTOP_VM_ID) : undefined);
        ctx.provide("extensionRegistry", extensionRegistry);
        ctx.provide("modelProvider", modelProvider);
        ctx.provide("traceStore", traceStore);
        ctx.provide("workflowStore", workflowStore);
        ctx.provide("workerClientFactory", workerClientFactory);
        ctx.provide("desktopProvider", desktop);
        ctx.provide("hyperVCompatibility", hyperVCompatibility);
        ctx.provide("physicalCompatibility", physicalCompatibility);
        ctx.provide("localWorkspaceCompatibility", localWorkspaceCompatibility);
        ctx.provide("desktopEnvironmentProviders", Object.freeze([hyperVCompatibility, physicalCompatibility,
          localWorkspaceCompatibility]));
        if (vmControl) ctx.provide("vmControl", vmControl);
        if (desktop instanceof DesktopSessionManager) attachControlBus(desktop, controlBus);
        // 基础设施释放：先撤销全部业务扩展（触发各扩展 dispose），再关闭
        // DesktopProvider；两者都幂等，root dispose 时最后执行。
        return async () => {
          // Cordis runs sibling disposers concurrently, even during direct Root disposal.
          controlBus.close();
          try {
            try { await controller?.close(); }
            finally { await controlBus.disposeSessions(); }
          } finally {
            try { await extensionRegistry.clear(); }
            finally {
              try { await hyperVCompatibility.close(); }
              finally {
                try { await physicalCompatibility.close(); }
                finally {
                  try { await localWorkspaceCompatibility.close(); }
                  finally { await desktop.close(); }
                }
              }
            }
          }
        };
      },
    }, 'Root', ['extensionRegistry', 'modelProvider', 'traceStore', 'workflowStore',
      'workerClientFactory', 'desktopProvider', 'desktopEnvironmentProviders', 'hyperVCompatibility', 'physicalCompatibility',
      'localWorkspaceCompatibility',
      ...(options.vmControl || process.env.AGENT_DESKTOP_VM_ID ? ['vmControl'] : [])]);
    await mountInspected(root, {
      name: 'applicationRegistry',
      apply(ctx) {
        const store = new SqliteEnvironmentAppStore(resolve(rootDir, 'environment-apps.sqlite'));
        try {
          const services = composeEnvironmentApps(store, options.environmentApps);
          ctx.provide('environmentApps', services);
          return async () => { try { await services.close(); } finally { store.close(); } };
        }
        catch (error) { store.close(); throw error; }
      },
    }, 'Root', ['environmentApps']);
    await mountInspected(root, {
      name: "taskController",
      inject: ["extensionRegistry", "modelProvider", "traceStore", "workflowStore", "workerClientFactory", "desktopEnvironmentProviders", "hyperVCompatibility", "physicalCompatibility", "localWorkspaceCompatibility", "environmentApps"],
      apply(ctx) {
        // 从业务扩展注册表组装核心的 facet / contributor 注册表（核心本身不内置任何业务域）。
        const facetRegistry = new FacetRegistry();
        for (const provider of ctx.extensionRegistry.listFacetProviders()) facetRegistry.register(provider);
        const contributorRegistry = new ContributorRegistry();
        for (const contributor of ctx.extensionRegistry.listVerifierContributors()) {
          contributorRegistry.register(contributor);
        }
        const domainEvaluator = createDomainEvaluator(contributorRegistry, facetRegistry);
        const created = new DesktopTaskController(rootDir, {
          environmentApps: ctx.environmentApps,
          environmentAppManagement: options.environmentAppManagement === true,
          acceptanceVerifier: configuredVerifier(rootDir,
            { facets: facetRegistry, contributors: contributorRegistry }),
          registry: ctx.extensionRegistry,
          facetProviders: [...ctx.extensionRegistry.listFacetProviders()],
          domainEvaluator,
          modelProvider: ctx.modelProvider,
          traceStore: ctx.traceStore,
          workflowStore: ctx.workflowStore,
          desktopSessions: options.desktopSessions ?? new TaskDesktopSessions(ctx.desktopEnvironmentProviders,
            new Map<string, import('../app/task-desktop-sessions.js').DesktopTaskExecutor>([
              [ctx.hyperVCompatibility.id, {
                taskControl: session => ctx.hyperVCompatibility.taskControl(session),
                connectRuntime: (session, dir) => ctx.hyperVCompatibility.connectRuntime(session, dir),
                lifecycleOwner: session => ctx.hyperVCompatibility.lifecycleOwner(session),
                completeTask: (session, taskId) => ctx.hyperVCompatibility.completeTask(session, taskId),
                appCatalog: () => registeredGuestApps(rootDir),
              }],
              [ctx.physicalCompatibility.id, new PhysicalTaskExecutor(ctx.physicalCompatibility,
                ctx.physicalCompatibility.inputControl, options.physicalInputPolicy)],
              [ctx.localWorkspaceCompatibility.id, new LocalWorkspaceTaskExecutor(ctx.localWorkspaceCompatibility)],
            ])),
          legacyDesktopTarget: (state, environment, target) => environment === 'agent_desktop' &&
            !!state.desktopVmId && target.providerId === ctx.hyperVCompatibility.id &&
            target.environmentId === `vm:${state.desktopVmId.toLowerCase()}`,
        });
        controller = created;
        ctx.provide("taskController", created);
        // 卸载时关闭控制器：拒绝新任务提交与恢复（在途队列不打断）。
        return () => created.close();
      },
    }, 'Root', ['taskController']);
    {
      await mountInspected(root, {
        name: "taskRecovery",
        apply() {
          recoverDesktopTasks(rootDir);
        },
      });
    }
    for (const plugin of options.extraPlugins ?? []) {
      await mountInspected(root, plugin);
    }
    return {
      inspect: () => inspectAssembly(root, root.get('extensionRegistry', false)),
      root,
      controller: root.taskController,
      desktop: root.desktopProvider,
      vmControl: root.vmControl,
      controlBus,
      environmentProviders: root.desktopEnvironmentProviders,
      environmentApps: root.environmentApps,
      dispose,
    };
  } catch (error) {
    // 初始化失败：回收已创建资源后向上传播（dispose 可重复调用，安全）。
    await dispose();
    throw error;
  }
}

function createControlBus(): ControlBus {
  let closed = false;
  const handlers = new Map<string, (clientId: string, raw: unknown) => Promise<unknown>>();
  const disconnects = new Map<string, (clientId: string) => Promise<void>>();
  const sessions = new Set<() => Promise<void>>();
  return {
    close() { closed = true; handlers.clear(); disconnects.clear(); },
    trackSession(cleanup) {
      if (closed) throw new Error("控制总线已关闭");
      let pending: Promise<void> | undefined;
      const dispose = () => pending ??= Promise.resolve().then(cleanup).finally(() => sessions.delete(dispose));
      sessions.add(dispose);
      return dispose;
    },
    async disposeSessions() {
      const results = await Promise.allSettled([...sessions].map(dispose => dispose()));
      const errors = results.filter(r => r.status === "rejected").map(r => r.reason);
      if (errors.length) throw new AggregateError(errors, "Session 关闭失败");
    },
    set(sessionId, handler, disconnected) {
      if (closed) throw new Error("控制总线已关闭");
      handlers.set(sessionId, handler);
      disconnects.set(sessionId, disconnected);
    },
    remove(sessionId) {
      handlers.delete(sessionId);
      disconnects.delete(sessionId);
    },
    async dispatch(sessionId: string, clientId: string, raw: unknown): Promise<unknown> {
      const handler = handlers.get(sessionId);
      if (!handler) throw new Error("该会话未启用输入控制或已卸载");
      return handler(clientId, raw);
    },
    async dispatchDisconnect(sessionId: string, clientId: string): Promise<void> {
      const disconnected = disconnects.get(sessionId);
      if (!disconnected) return;
      await disconnected(clientId);
    },
  };
}

function attachControlBus(desktop: DesktopSessionManager, bus: ControlBus): void {
  desktop.controlMessage = (sessionId, clientId, value) => bus.dispatch(sessionId, clientId, value);
  // 兼容约定：断开回调第一参数保持 clientId（旧接线语义），sessionId 追加为第二参数。
  desktop.controlDisconnected = (clientId, sessionId) => bus.dispatchDisconnect(sessionId, clientId);
}
