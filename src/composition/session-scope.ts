import { type Context, type FiberLike } from "cordis";
import { resolve } from "node:path";
import { DesktopControl } from "../desktop-session/control.js";
import type { ControlBus } from "./root.js";
import "./services.js";
import { connectionConfig } from "../desktop-session/connection-config.js";
import { mountInspected } from './inspection.js';

export interface SessionScopeOptions {
  root: Context;
  rootDir: string;
  sessionId: string;
  vmId: string;
  endpoint: string;
  /** Worker 鉴权 Token；控制与轮询请求共用。 */
  token: string;
  /** 控制总线：作用域卸载时移除本会话的处理器，旧输入不再命中。 */
  controlBus: ControlBus;
  /** 是否要求先重连到 Guest Worker（真实部署为 true；测试可关）。 */
  requireReconnect?: boolean;
  /** 输入控制与端点刷新的轮询间隔（毫秒）。 */
  intervalMs?: number;
}

export interface SessionScope {
  fiber: FiberLike;
  scope: Context;
  control?: DesktopControl;
  dispose(): Promise<void>;
}

/**
 * 为单个 Desktop Session 建立受管理作用域（Cordis 独立 fiber）：
 * - 同步创建本会话的 DesktopControl（输入控制），apply 阶段接线到控制器与
 *   ControlBus（作用域装载为异步，控制消息在装载完成前被总线拒绝）；
 * - 注册/更新会话记录；
 * - 可选：VM 端点刷新轮询（vmControl 已提供时）；
 * - 重连定时器作为 effect 归入作用域，dispose 时清理全部定时器/处理器并关闭控制；
 * - 卸载后该会话的控制消息被 ControlBus 拒绝，stopped 任务不会被复活。
 * dispose 可重复调用；销毁本作用域不影响其他 Session 作用域与 Root。
 */
export function mountSessionScope(options: SessionScopeOptions): SessionScope {
  const { root, rootDir, sessionId, vmId, endpoint, token, controlBus } = options;
  const config = connectionConfig(rootDir);
  const intervalMs = options.intervalMs ?? config.pollMs;
  const requireReconnect = options.requireReconnect ?? true;
  const provider = root.desktopProvider;
  const controller = root.taskController;
  let control: DesktopControl | undefined;
  let active = true;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  let unregisterEnvironment: (() => Promise<void>) | undefined;
  const cleanup = controlBus.trackSession(async () => {
    active = false;
    clearInterval(refreshTimer);
    clearInterval(reconnectTimer);
    provider.setActive(sessionId, false);
    provider.disconnect(sessionId);
    controlBus.remove(sessionId);
    if (control) {
      try { await controller.releaseDesktopControl(control, sessionId); }
      finally {
        try { await unregisterEnvironment?.(); }
        finally { await control.close(); }
      }
    }
  });
  // 登记会话（同步、幂等）必须先于 DesktopControl 构造：其构造会写控制状态并回写会话。
  provider.register(vmId, endpoint, sessionId);
  control = new DesktopControl(resolve(rootDir), provider, sessionId,
    token, controller, requireReconnect, config);
  const sessionControl = control;
  unregisterEnvironment = root.get("hyperVCompatibility", false)?.registerControl(sessionId, sessionControl);
  const fiber = mountInspected(root, {
    name: `session:${sessionId}`,
    inject: ["desktopProvider", "taskController"],
    apply(ctx) {
      if (!active) return cleanup;
      controller.setDesktopControl(sessionControl, sessionId);
      controlBus.set(sessionId,
        async (clientId, raw) => {
          if (!raw || typeof raw !== "object") throw new Error("控制请求无效");
          const value = raw as { command?: string; event?: unknown };
          return value.command === "input"
            ? sessionControl.input(clientId, value.event)
            : sessionControl.command(clientId, value.command ?? "");
        },
        (clientId) => sessionControl.disconnect(clientId),
      );
      let reconnecting = false;
      const reconnect = async () => {
        if (!active || reconnecting) return;
        reconnecting = true;
        try { await sessionControl.reconnect(); } catch { /* Retry after VM boot/login; inputs stay frozen. */ }
        finally { reconnecting = false; }
      };
      reconnectTimer = setInterval(() => { void reconnect(); }, intervalMs);
      reconnectTimer.unref();
      // vmControl 是可选服务：非 strict 读取，未提供时不启用端点刷新。
      const vmControl = ctx.get("vmControl", false) as
        { status(): Promise<{ ipv4?: string | null }> } | undefined;
      if (vmControl) {
        const refreshEndpoint = async () => {
          try {
            const vm = await vmControl.status();
            if (active && vm.ipv4) provider.updateWorkerEndpoint(sessionId, `http://${vm.ipv4}:8765`);
          } catch { /* VM is unavailable until Hyper-V or Guest is ready. */ }
        };
        void refreshEndpoint();
        refreshTimer = setInterval(() => { void refreshEndpoint(); }, intervalMs);
        refreshTimer.unref();
        // 卸载顺序：先停止刷新与重连定时器，再停用会话（全局轮询跳过、拒绝新
        // 连接、断开既有连接），移除控制处理器，按 owner 清空任务控制绑定，最后
        // 等待在途控制请求 settle 并关闭控制（冻结/撤销 Guest 输入权）。
        return cleanup;
      }
      return cleanup;
    },
  }, `Session / ${sessionId}`);
  return {
    fiber,
    scope: fiber.ctx,
    control,
    dispose: async () => {
      try { await cleanup(); }
      finally { await fiber.dispose(); }
    },
  };
}
