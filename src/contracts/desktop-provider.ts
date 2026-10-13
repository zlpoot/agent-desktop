import type { Server } from "node:http";

/**
 * Legacy Hyper-V 管理 / 传输契约。新桌面环境请使用 `desktop-environment.ts`。
 *
 * 本模块与 `desktop-environment.ts` 是**两个职责不同且不互相继承**的契约：
 * - 这里：VM/Session 的管理面 + Web 传输挂接（register/list/get/attach/poll/close）。
 * - 那里：真实环境的发现与 Session 生命周期（discover/open/capabilities/close）。
 * 旧管理面在此保留显式名称 `LegacyDesktopProvider`，不再导出同名 `DesktopProvider` 别名，
 * 以免与 `desktop-environment.ts` 中唯一的 `DesktopProvider` 混淆。
 * 桌面控制的职责边界（Kernel 只依赖本文件，不接触 VM/传输实现）：
 * - LegacyDesktopProvider：桌面的发现、注册、状态、轮询与连接的生命周期管理面。
 *   它不拥有 Web 传输；传输（WebSocket 心跳/画面流、HTTP 状态接口）由实现
 *   通过 attach(server) 挂接到网页服务器，帧协议属于 Infrastructure 细节。
 * - DesktopSessionView：稳定身份 + 当前连接状态 + Worker 端点的只读能力视图。
 *   它是快照，不持有传输或资源；VM/连接细节在实现中。
 * - InputControl：Agent/Human 输入所有权与租约边界；紧急停止与恢复由实现保持。
 */
export interface DesktopSessionView {
  sessionId: string;
  environmentType: "hyper-v";
  vmId: string;
  status: "connecting" | "online" | "offline";
  currentTaskId: string | null;
  workerEndpoint: string;
  createdAt: string;
  lastSeenAt: string | null;
  lastError: string | null;
}

/** Legacy Hyper-V management/transport contract; new environments use desktop-environment.ts. */
export interface LegacyDesktopProvider {
  register(vmId: string, endpoint: string, sessionId?: string): DesktopSessionView;
  list(): DesktopSessionView[];
  get(id: string): DesktopSessionView | undefined;
  updateWorkerEndpoint(sessionId: string, endpoint: string): void;
  setCurrentTask(sessionId: string, taskId: string | null): void;
  /**
   * 标记会话活跃/停用：全局轮询与新的 Web 连接只服务活跃会话；
   * 停用（Session 作用域卸载）保留持久记录但不再访问其 Worker。
   */
  setActive(sessionId: string, active: boolean): void;
  /** 断开某会话的全部网页连接（卸载时调用）。 */
  disconnect(sessionId: string): void;
  /** 将实现自有的 Web 传输（WebSocket/HTTP）挂接到网页服务器；契约不暴露帧协议。 */
  attach(server: Server): void;
  poll(): Promise<void>;
  close(): Promise<void>;
}

/** Agent/Human 输入所有权与租约边界；紧急停止与恢复由实现保持。 */
export interface InputControl {
  workerEndpoint(): string;
  assertTaskAllowed(taskId?: string): void;
  beginTask(taskId: string): Promise<void>;
  /** The Guest gate revision granted to this task. Implementations without a Guest may omit it. */
  agentEpoch?(): number | undefined;
  finishTask(taskId: string, status?: string): Promise<boolean>;
}
