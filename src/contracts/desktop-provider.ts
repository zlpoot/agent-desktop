import type { Server } from "node:http";

/**
 * 桌面控制的职责边界（Kernel 只依赖本文件，不接触 VM/传输实现）：
 * - DesktopProvider：桌面的发现、注册、状态、轮询与连接的生命周期管理面。
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

/** @deprecated Compatibility alias for existing consumers; not the environment Provider. */
export type DesktopProvider = LegacyDesktopProvider;

/** Agent/Human 输入所有权与租约边界；紧急停止与恢复由实现保持。 */
export interface InputControl {
  workerEndpoint(): string;
  assertTaskAllowed(taskId?: string): void;
  beginTask(taskId: string): Promise<void>;
  /** The Guest gate revision granted to this task. Implementations without a Guest may omit it. */
  agentEpoch?(): number | undefined;
  finishTask(taskId: string, status?: string): Promise<boolean>;
}
