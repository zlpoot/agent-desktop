import type { DesktopTaskController } from "../app/task-runner.js";
import type { VmControl } from "../desktop-session/vm-control.js";
import type { ExtensionRegistry } from "../contracts/extension.js";
import type { DesktopProvider } from "../contracts/desktop-provider.js";
import type { DesktopProvider as EnvironmentProvider } from "../contracts/desktop-environment.js";
import type { HyperVDesktopProvider } from "../desktop-provider/hyperv-provider.js";
import type { PhysicalDesktopProvider } from "../desktop-provider/physical-provider.js";
import type { LocalWorkspaceDesktopProvider } from "../desktop-provider/local-workspace-provider.js";
import type { ModelProvider } from "../contracts/model-provider.js";
import type { TraceStore, WorkflowStore } from "../contracts/stores.js";
import type { WorkerClientFactory } from "../contracts/worker-client.js";
import type { EnvironmentAppServices } from '../contracts/environment-apps.js';

/**
 * Cordis 服务名与 Context 类型增强（Cordis 类型化服务约定：通过 key 查找服务，
 * 不 import 具体实现）。装配层统一在 root Context 上注册以下服务：
 * - infrastructure：extensionRegistry / modelProvider / traceStore / workflowStore /
 *   workerClientFactory / desktopProvider / vmControl(可选)
 * - taskController：DesktopTaskController
 * Session 作用域通过 inject 声明对这些服务的依赖。
 */
declare module "cordis" {
  interface Context {
    extensionRegistry: ExtensionRegistry;
    modelProvider: ModelProvider;
    traceStore: (path: string) => TraceStore;
    workflowStore: (path: string) => WorkflowStore;
    workerClientFactory: WorkerClientFactory;
    desktopProvider: DesktopProvider;
    desktopEnvironmentProviders: readonly EnvironmentProvider[];
    environmentApps: EnvironmentAppServices;
    /** Composition-only legacy bridge, never an Agent Core dependency. */
    hyperVCompatibility: HyperVDesktopProvider;
    physicalCompatibility: PhysicalDesktopProvider;
    localWorkspaceCompatibility: LocalWorkspaceDesktopProvider;
    vmControl?: VmControl;
    taskController: DesktopTaskController;
  }
}

export {};
