import type { ActionResult, ComputerAction, GroundingResult, Observation } from "../actions/schema.js";
import type { ActionResolution } from "../actions/action-resolution.js";
import type { DesktopProbe, DesktopRuntimeOptions, WindowFilter, WindowInfo } from "../runtime/desktop/desktop-runtime.js";

/**
 * Guest Worker 客户端：协议版本/能力协商、超时、取消、重连与错误语义
 * 由实现负责；契约只固化 Task 绑定所需的方法面。
 * 边界：Session 连接（心跳/画面，由 DesktopProvider 实现持有）与 Task 绑定
 * （本接口的窗口绑定/动作执行）相互分离；close() 只释放本次任务绑定，
 * 不销毁 Session 连接。
 */
export interface WorkerClient {
  listWindows(filter?: WindowFilter): Promise<WindowInfo[]>;
  ensureApp(appId: string): Promise<{ handle: number; title: string }>;
  attach(options: DesktopRuntimeOptions): Promise<void>;
  observe(screenCapture?: boolean): Promise<Observation>;
  probe(focus?: boolean): Promise<DesktopProbe>;
  recoverFocus(): Promise<void>;
  ground(action: ComputerAction): Promise<GroundingResult>;
  resolveAction(action: ComputerAction): Promise<ActionResolution>;
  execute(action: ComputerAction, resolution?: ActionResolution, actionId?: string): Promise<ActionResult>;
  restore(observation: Observation): Promise<void>;
  close(): Promise<void>;
}

/** WorkerClient 创建工厂；GuestDesktopRuntime.connect 满足该签名。 */
export type WorkerClientFactory = (endpoint: string, token: string, vmId: string,
  artifactDir: string, controlEpoch?: number) => Promise<WorkerClient>;
