import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import type { TaskController } from "../app/task-runner.js";
import type { DesktopProvider } from "../contracts/desktop-provider.js";
import { SqliteTrace } from "../trace/sqlite-trace.js";
import { connectionDefaults, type ConnectionConfig } from "./connection-config.js";
import { WorkerConnectionError } from "../contracts/worker-error.js";

export type ControlMode = "AGENT_CONTROL" | "PAUSING" | "PAUSED" | "HUMAN_CONTROL" |
  "RESUMING" | "STOPPED" | "ERROR";
export interface ControlState { mode: ControlMode; taskId: string | null; humanClient: string | null;
  error?: string; }
export interface DesktopControlHooks {
  workerEndpoint(): string;
  assertTaskAllowed(taskId?: string): void;
  beginTask(taskId: string): Promise<void>;
  finishTask(taskId: string, status?: string): Promise<boolean>;
}

class DesktopNotReadyError extends Error {
  constructor(readonly reason: string, readonly observable: boolean, readonly inputReady: boolean) {
    super(`Guest 桌面未就绪：${reason}；请登录或解锁 Windows 后重试`);
  }
}

/**
 * 输入控制的资源与租约边界（阶段 A 契约）。
 *
 * 关闭语义（阶段 B 收尾）：
 * - close() 置 closed 并等待所有在途控制请求 settle（网络请求有 30s 上限）；
 * - 在途操作结束后，用更新的 revision 请求 Guest paused/stopped，撤销旧输入权；
 * - 只有撤权失败才记录未确认状态；STOPPED 不因网络错误降级；
 * - 关闭后所有入口（command/input/beginTask/finishTask/reconnect/view）拒绝；
 * - close() 幂等且可重复调用。
 */
export class DesktopControl implements DesktopControlHooks {
  private readonly db: DatabaseSync;
  private state: ControlState = { mode: "PAUSED", taskId: null, humanClient: null };
  private lease?: string;
  private stopping = false;
  private running = false;
  private serial = Promise.resolve();
  private revision = Date.now() * 1000;
  private emergencyEpoch = 0;
  private agentRevision?: number;
  private workerReady: boolean;
  private closed = false;
  private remoteTouched = false;
  private closePromise?: Promise<void>;
  private connection: { status: "connecting" | "ready" | "not_ready" | "offline" | "incompatible";
    error?: string; lastConnectedAt?: string; retryAt?: number; workerOnline?: boolean;
    readyForObservation?: boolean; readyForInput?: boolean; blockedReason?: string } = { status: "connecting" };
  private workerEpoch?: string;
  private connectedEndpoint?: string;
  private recoveryPending = false;
  private failures = 0;
  constructor(private readonly rootDir: string, private readonly sessions: DesktopProvider,
    private readonly sessionId: string, private readonly token: string,
    private readonly controller: TaskController, private readonly requireReconnect = false,
    private readonly connectionOptions: ConnectionConfig = connectionDefaults) {
    this.workerReady = !requireReconnect;
    this.db = new DatabaseSync(resolve(rootDir, "desktop-control.sqlite"));
    this.db.exec(`CREATE TABLE IF NOT EXISTS control_state (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS control_events (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL,
        task_id TEXT, created_at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL)`);
    const row = this.db.prepare("SELECT value FROM control_state WHERE id=?").get(sessionId) as { value: string } | undefined;
    if (row) {
      const previous = JSON.parse(row.value) as ControlState;
      const trace = new SqliteTrace(resolve(rootDir, "web-tasks.sqlite"));
      try {
        const task = previous.taskId ? trace.load(previous.taskId) : undefined;
        this.state = { mode: previous.mode === "STOPPED" ? "STOPPED" : "PAUSED",
          taskId: task && ["paused", "waiting_user", "stopped"].includes(task.status) ? task.taskId : null,
          humanClient: null };
        this.stopping = this.state.mode === "STOPPED";
      } finally { trace.close(); }
    }
    // Restart preserves task identity, never a browser lease or permission to type.
    if (this.state.mode === "STOPPED") this.markStopped();
    this.save("host_started");
  }
  private save(kind: string, detail: unknown = {}) {
    this.db.prepare("INSERT OR REPLACE INTO control_state VALUES (?, ?)")
      .run(this.sessionId, JSON.stringify(this.state));
    this.db.prepare("INSERT INTO control_events(session_id,task_id,created_at,kind,detail) VALUES(?,?,?,?,?)")
      .run(this.sessionId, this.state.taskId, new Date().toISOString(), kind, JSON.stringify(detail));
    this.sessions.setCurrentTask(this.sessionId, this.state.taskId);
  }
  view() {
    if (this.closed) throw new Error("控制已关闭");
    const trace = new SqliteTrace(resolve(this.rootDir, "web-tasks.sqlite"));
    try {
      const task = this.state.taskId ? trace.load(this.state.taskId) : undefined;
      return { ...this.state, workerReady: this.workerReady, connection: this.connection, task: task && { id: task.taskId, status: task.status, goal: task.goal,
        stage: task.stage?.goal, action: task.lastAction?.kind, provider: task.lastResult?.provider,
        verify: task.lastVerification?.message, summary: task.summary },
        events: this.db.prepare("SELECT created_at,kind,detail FROM control_events WHERE session_id=? ORDER BY id DESC LIMIT 10")
          .all(this.sessionId) };
    } finally { trace.close(); }
  }
  private async request(path: string, body: object, boundEndpoint?: string): Promise<Record<string, unknown>> {
    if (path === "/control") this.remoteTouched = true;
    const session = this.sessions.get(this.sessionId);
    if (!session) throw new Error("Desktop Session 不存在");
    const response = await fetch(`${boundEndpoint ?? session.workerEndpoint}${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ vmId: session.vmId, ...body }), signal: AbortSignal.timeout(30000) });
    const reply = await response.json() as { error?: string; result?: Record<string, unknown> };
    if (!response.ok || reply.error || !reply.result) throw new Error(reply.error ?? `Worker HTTP ${response.status}`);
    return reply.result;
  }
  private async gate(mode: "agent" | "paused" | "human" | "stopped") {
    const revision = ++this.revision;
    const result = await this.request("/control", { mode, revision });
    if (revision !== this.revision) throw new Error("控制权请求已被更新请求取代");
    this.lease = typeof result.lease === "string" ? result.lease : undefined;
    this.agentRevision = mode === "agent" ? revision : undefined;
  }
  agentEpoch(): number | undefined {
    if (this.closed || this.state.mode !== "AGENT_CONTROL") return undefined;
    return this.agentRevision;
  }
  /** Infrastructure snapshot of the last validated handshake, never a grant to perform input. */
  connectionIdentity(): { endpoint: string; recoveryEpoch: string } | undefined {
    if (this.closed || !this.workerReady || !this.connectedEndpoint || !this.workerEpoch) return undefined;
    return { endpoint: this.connectedEndpoint, recoveryEpoch: this.workerEpoch };
  }
  private async humanCheckpoint() {
    try {
      const session = this.sessions.get(this.sessionId)!;
      const response = await fetch(`${session.workerEndpoint}/frame`, {
        headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(`Screenshot HTTP ${response.status}`);
      const png = Buffer.from(await response.arrayBuffer());
      if (png.length > 8_000_000 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Invalid PNG");
      const dir = resolve(this.rootDir, ".artifacts", "agent-desktop", "human");
      await mkdir(dir, { recursive: true });
      const path = resolve(dir, `${randomUUID()}.png`); await writeFile(path, png);
      this.save("human_checkpoint", { path, sha256: createHash("sha256").update(png).digest("hex") });
    } catch (error) { this.save("human_checkpoint_error", { error: String(error) }); }
  }
  workerEndpoint(): string {
    const session = this.sessions.get(this.sessionId);
    if (!session) throw new Error("Desktop Session 不存在");
    return session.workerEndpoint;
  }
  async reconnect(): Promise<void> {
    if (this.closed) throw new Error("控制已关闭");
    if (!this.requireReconnect && this.workerReady) return;
    if (Date.now() < (this.connection.retryAt ?? 0)) return;
    await this.exclusive(async () => {
      try {
        await this.checkConnection();
        if (!this.workerReady && !this.running) await this.ensureWorker();
      } catch (error) {
        this.connectionFailed(error);
      }
    });
  }
  private connectionFailed(error: unknown) {
    if (this.closed) return;
    const message = String(error);
    const changed = this.workerReady || this.connection.error !== message;
    this.workerReady = false; this.lease = undefined; this.state.humanClient = null;
    this.agentRevision = undefined;
    this.recoveryPending = true;
    if (this.state.mode !== "STOPPED") this.state.mode = this.running ? "PAUSING" : "PAUSED";
    const notReady = error instanceof DesktopNotReadyError ? error : undefined;
    this.connection = { ...this.connection,
      status: notReady ? "not_ready" : /身份|协议|鉴权/.test(message) ? "incompatible" : "offline", error: message,
      workerOnline: !!notReady, readyForObservation: notReady?.observable ?? false,
      readyForInput: notReady?.inputReady ?? false, blockedReason: notReady?.reason,
      retryAt: Date.now() + Math.min(this.connectionOptions.retryMaxMs, this.connectionOptions.pollMs * 2 ** Math.min(this.failures++, 5)) };
    if (this.state.taskId) {
      const trace = new SqliteTrace(resolve(this.rootDir, "web-tasks.sqlite"));
      try {
        trace.requestPause(this.state.taskId);
        if (!this.running) this.parkTask(trace);
      } finally { trace.close(); }
    }
    if (changed) this.save(notReady ? "desktop_not_ready" : "worker_unavailable", { error: message });
  }
  private parkTask(trace: SqliteTrace) {
    const task = this.state.taskId ? trace.load(this.state.taskId) : undefined;
    if (task && !["done", "stopped"].includes(task.status)) trace.save("worker_disconnected", {
      ...task, status: "paused", recoveryRequired: true,
      recoveryUncertain: task.recoveryUncertain || !!task.inFlightAction || task.lastResult?.effect === "uncertain",
      summary: task.error ? `Worker 连接中断；原始失败：${task.error}。等待就绪后继续，先重新观察`
        : "Worker 连接中断；等待就绪后点击继续，先重新观察", error: task.error });
  }
  private async workerState() {
    const session = this.sessions.get(this.sessionId)!;
    const response = await fetch(`${session.workerEndpoint}/state`, {
      headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(this.connectionOptions.timeoutMs) });
    if ([401, 403].includes(response.status)) throw new Error("Worker 鉴权失败，请检查已保存的凭据");
    if (!response.ok) throw new Error(`Worker 状态 HTTP ${response.status}`);
    const value = await response.json() as { vm_id?: string; action_rpc?: boolean; control_rpc?: boolean;
      recovery_rpc?: boolean; control_epoch_rpc?: boolean; action_id_rpc?: boolean; recovery_epoch?: string;
      ready_for_observation?: boolean; ready_for_input?: boolean; blocked_reason?: string | null };
    if (value.vm_id !== session.vmId) throw new Error("Worker 身份不匹配，禁止连接另一台 VM");
    if (!value.action_rpc || !value.control_rpc || !value.recovery_rpc || !value.recovery_epoch ||
        !value.control_epoch_rpc || !value.action_id_rpc)
      throw new Error("Worker 协议不兼容，需要 Action/Control/Recovery/ControlEpoch/ActionId RPC");
    if (typeof value.ready_for_observation !== 'boolean' || typeof value.ready_for_input !== 'boolean')
      throw new Error('Worker 协议不兼容，需要 Desktop Readiness 字段');
    return { value, endpoint: session.workerEndpoint };
  }
  private async checkConnection() {
    const { value, endpoint } = await this.workerState();
    if (this.closed) return;
    if (this.workerReady && (this.workerEpoch !== value.recovery_epoch || this.connectedEndpoint !== endpoint)) {
      this.connectionFailed(new Error("Worker 会话或地址已变化，需要重新握手"));
    }
    if (!value.ready_for_observation || !value.ready_for_input) {
      const wasReady = this.workerReady;
      const error = new DesktopNotReadyError(value.blocked_reason ?? 'desktop_not_ready',
        value.ready_for_observation === true,
        value.ready_for_observation === true && value.ready_for_input === true);
      this.connectionFailed(error);
      if (wasReady) await this.gate(this.stopping ? 'stopped' : 'paused');
      throw error;
    }
    const frame = await fetch(`${endpoint}/frame`, { headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(this.connectionOptions.timeoutMs) });
    const png = frame.ok ? Buffer.from(await frame.arrayBuffer()) : Buffer.alloc(0);
    if (!frame.ok || png.length > 8_000_000 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      // Freeze an otherwise reachable Guest even if only its desktop capture failed.
      const error = new DesktopNotReadyError('desktop_unobservable', false, false);
      this.connectionFailed(error);
      await this.gate(this.stopping ? "stopped" : "paused");
      throw error;
    }
    if (!this.workerReady && this.running) await this.gate(this.stopping ? "stopped" : "paused");
  }
  private async ensureWorker() {
    if (this.workerReady) return;
    if (this.requireReconnect) {
      await this.checkConnection();
      if (this.closed) throw new Error("控制已关闭");
      if (this.running) throw new Error("等待运行中任务安全暂停");
    }
    const revision = ++this.revision;
    const result = await this.request("/control", { mode: this.state.mode === "STOPPED" ? "stopped" : "paused",
      revision, resetTask: true });
    if (revision !== this.revision) throw new Error("重连已被新的控制请求取代");
    if (result.recovery_rpc !== true) throw new Error("Guest Worker 需要更新到支持 D4 重连的版本");
    if (this.requireReconnect) {
      const { value, endpoint } = await this.workerState();
      if (this.closed) return;
      this.workerEpoch = value.recovery_epoch; this.connectedEndpoint = endpoint;
    }
    this.workerReady = true; this.lease = undefined; this.state.error = undefined;
    this.failures = 0; this.connection = { status: "ready", workerOnline: true,
      readyForObservation: true, readyForInput: true, lastConnectedAt: new Date().toISOString() };
    this.save("worker_reconnected");
  }
  /**
   * 串行执行控制操作；close 发起后：
   * - 尚未开始的操作被拒绝（停止接收新请求）；
   * - 已开始的操作先完成；close 等待串行链，再向 Guest 发出最终撤权请求。
   */
  private exclusive<T>(fn: () => Promise<T>, cleanup = false): Promise<T> {
    const epoch = this.emergencyEpoch;
    const next = this.serial.then(async () => {
      if (!cleanup && epoch !== this.emergencyEpoch) throw new Error("指令已被紧急停止撤销");
      if (this.closed) throw new Error("控制已关闭");
      return fn();
    });
    this.serial = next.then(() => {}, () => {});
    return next;
  }
  /**
   * 数据库在远端撤权结果落盘后才关闭；不把本地丢弃租约当作远端撤权成功。
   */
  private async finalizeClosed() {
    if (!this.remoteTouched && !this.lease && !this.running) return;
    const stopped = this.stopping || this.state.mode === "STOPPED";
    this.lease = undefined;
    this.state.humanClient = null;
    try {
      // Use a newer revision after all earlier requests settle, so the Guest revokes
      // old leases and cannot finish a delayed take/agent request after this fence.
      await this.gate(stopped ? "stopped" : "paused");
    } catch (error) {
      this.state = { ...this.state, mode: stopped ? "STOPPED" : "ERROR",
        error: `宿主控制已关闭，Guest 输入权状态未确认：${String(error)}` };
      this.save("closed_unconfirmed");
      return;
    } finally {
      this.lease = undefined;
      this.workerReady = false;
    }
    this.state = { ...this.state, mode: stopped ? "STOPPED" : "PAUSED", error: undefined };
    // A local persistence failure must not be reported as failed Guest revocation.
    this.save("closed_confirmed");
  }
  assertTaskAllowed(taskId?: string) {
    if (this.closed) throw new Error("控制已关闭");
    if (!["PAUSED", "RESUMING"].includes(this.state.mode) ||
        this.state.taskId && this.state.taskId !== taskId) throw new Error("请先结束人工接管或处理当前保留任务");
  }
  async beginTask(taskId: string): Promise<void> {
    await this.exclusive(async () => {
      if (this.requireReconnect) {
        try { await this.checkConnection(); } catch (error) { this.connectionFailed(error); throw new WorkerConnectionError(String(error)); }
        if (!this.workerReady && this.connectedEndpoint) throw new WorkerConnectionError("Worker 需要重新连接；请等待就绪后继续");
      }
      await this.ensureWorker();
      if (!["PAUSED", "RESUMING"].includes(this.state.mode) ||
          this.state.taskId && this.state.taskId !== taskId) throw new Error("Desktop 正被接管、暂停保留或已停止");
      await this.gate("agent");
      this.running = true;
      this.recoveryPending = false;
      this.state = { mode: "AGENT_CONTROL", taskId, humanClient: null };
      this.save("agent_started");
    });
  }
  async finishTask(taskId: string, status?: string): Promise<boolean> {
    return this.exclusive(async () => {
      if (this.state.taskId !== taskId) return false;
      this.running = false;
      const stopped = this.stopping || this.state.mode === "STOPPED";
      if (this.requireReconnect) {
        try { await this.checkConnection(); } catch (error) { this.connectionFailed(error); }
      }
      if (this.recoveryPending && !stopped) {
        const trace = new SqliteTrace(resolve(this.rootDir, "web-tasks.sqlite"));
        try {
          this.parkTask(trace);
          if (trace.load(taskId)?.status === "done") this.state.taskId = null;
        } finally { trace.close(); }
        this.state.mode = "PAUSED"; this.state.humanClient = null;
        this.save("task_parked"); return false;
      }
      try { await this.gate(stopped ? "stopped" : "paused"); }
      catch (error) {
        if (this.state.mode === "STOPPED") {
          this.state = { ...this.state, taskId: null,
            error: `Guest 未确认停止：${String(error)}` };
          this.save("task_stopped_unconfirmed", { taskId, status });
          return true;
        }
        this.state = { ...this.state, mode: "ERROR", error: String(error) }; this.save("gate_error"); return stopped;
      }
      this.state = { mode: stopped ? "STOPPED" : "PAUSED", humanClient: null,
        taskId: !stopped && ["paused", "waiting_user"].includes(status ?? "") ? taskId : null };
      this.save(stopped ? "task_stopped" : "agent_released", { taskId, status });
      return stopped;
    }, true);
  }
  async command(client: string, command: string): Promise<ReturnType<DesktopControl["view"]>> {
    if (this.closed) throw new Error("控制已关闭");
    if (command === "emergency") {
      const run = async () => {
        this.emergencyEpoch++;
        this.stopping = true;
        this.state = { ...this.state, mode: "STOPPED", humanClient: null };
        this.lease = undefined;
        this.save("emergency_requested");
        if (!this.running) this.markStopped();
        if (this.running && this.state.taskId) { try { this.controller.pause(this.state.taskId); } catch { /* planning or already pausing */ } }
        try { await this.gate("stopped"); this.save("emergency_acknowledged"); }
        catch (error) { this.state.error = `Guest 未确认停止：${String(error)}`; this.save("emergency_unconfirmed"); }
        return this.view();
      };
      const op = run();
      this.inflight = Promise.allSettled([this.inflight, op]).then(() => undefined);
      return op;
    }
    return this.exclusive(async () => {
      const epoch = this.emergencyEpoch;
      const taskIdBeforeCommand = this.state.taskId;
      try {
        if (this.requireReconnect) await this.checkConnection();
        await this.ensureWorker();
      } catch (error) {
        this.connectionFailed(error);
        if (command !== "pause" && command !== "stop") throw error;
        if (command === "stop") {
          this.stopping = true;
          this.state.mode = "STOPPED";
          if (!this.running) this.markStopped();
        }
        this.save(command + "_unconfirmed", { client, error: String(error) });
        return this.view();
      }
      if (["STOPPED", "ERROR"].includes(this.state.mode) && command !== "reset") {
        throw new Error("控制已停止，必须显式重置后才能操作");
      }
      if (command === "pause" || command === "stop") {
        if (this.stopping && command === "pause") throw new Error("正在停止，不能改为暂停");
        this.stopping = command === "stop";
        if (this.running && this.state.taskId) {
          this.controller.pause(this.state.taskId);
          this.state.mode = "PAUSING";
        } else {
          await this.gate(command === "stop" ? "stopped" : "paused");
          this.state.mode = command === "stop" ? "STOPPED" : "PAUSED";
          if (command === "stop") this.markStopped();
        }
        this.state.humanClient = null;
      } else if (command === "take") {
        if (this.state.mode !== "PAUSED" || this.running) throw new Error("必须先等待暂停完成");
        await this.gate("human");
        this.state.mode = "HUMAN_CONTROL";
        this.state.humanClient = client;
      } else if (command === "resume") {
        if (!["PAUSED", "HUMAN_CONTROL"].includes(this.state.mode)) throw new Error("当前状态不能恢复 Agent");
        if (this.state.humanClient && this.state.humanClient !== client) throw new Error("只有接管页面可恢复 Agent");
        await this.gate("paused");
        this.state.humanClient = null;
        if (this.state.mode === "HUMAN_CONTROL") await this.humanCheckpoint();
        if (epoch !== this.emergencyEpoch) throw new Error("恢复已被紧急停止撤销");
        if (this.state.taskId) {
          this.state.mode = "RESUMING";
          try { this.controller.continue(this.state.taskId); }
          catch (error) { this.state.mode = "PAUSED"; throw error; }
        } else this.state.mode = "PAUSED";
      } else if (command === "reset") {
        if (this.running || !["STOPPED", "ERROR"].includes(this.state.mode)) throw new Error("当前不能重置");
        await this.gate("paused");
        this.stopping = false;
        this.state = { mode: "PAUSED", taskId: null, humanClient: null };
      } else throw new Error("控制指令无效");
      this.save(command, { client, ...(command === "stop" ? { taskId: taskIdBeforeCommand } : {}) });
      return this.view();
    });
  }
  private markStopped() {
    if (!this.state.taskId) return;
    const taskId = this.state.taskId;
    const trace = new SqliteTrace(resolve(this.rootDir, "web-tasks.sqlite"));
    try { const state = trace.load(taskId); if (state) trace.save("stop", { ...state,
      status: "stopped", summary: "用户停止任务，现场保留" }); } finally { trace.close(); }
    this.state.taskId = null;
  }
  async input(client: string, event: unknown) {
    return this.exclusive(async () => {
      if (this.state.mode !== "HUMAN_CONTROL" || this.state.humanClient !== client || !this.lease) {
        throw new Error("当前页面没有人工输入权");
      }
      // Endpoint refresh is independent of control polling. A previous human lease
      // must never be sent to a newly discovered address before re-handshake.
      const endpoint = this.workerEndpoint();
      if (this.requireReconnect && (!this.workerReady || endpoint !== this.connectedEndpoint)) {
        const error = new WorkerConnectionError("Worker 地址已变化，需要重新握手后重新接管桌面");
        this.connectionFailed(error);
        throw error;
      }
      let result: Record<string, unknown>;
      try { result = await this.request("/human-input", { lease: this.lease, event }, endpoint); }
      catch (error) { this.connectionFailed(error); throw error; }
      // Human events are separate from Agent actions and cannot verify a task by themselves.
      const value = event as { kind?: string; point?: unknown; destination?: unknown; keys?: unknown; text?: string; amount?: number };
      this.save("human_input", { client, kind: value?.kind, point: value?.point,
        destination: value?.destination, keys: value?.keys, textLength: value?.text?.length, amount: value?.amount });
      return result;
    });
  }
  async disconnect(client: string) {
    if (this.closed) return;
    if (this.state.humanClient !== client) return;
    this.state = { ...this.state, mode: "PAUSED", humanClient: null };
    this.lease = undefined;
    return this.exclusive(async () => {
      if (["STOPPED", "ERROR"].includes(this.state.mode)) return;
      try { await this.gate("paused"); }
      catch (error) { if (this.state.mode !== "STOPPED") { this.state.mode = "ERROR"; this.state.error = String(error); } }
      this.save("human_disconnected", { client });
    }, true);
  }
  /** 关闭：停止接收新请求、等在途请求 settle、冻结/撤销 Guest 输入权状态、关库。幂等。 */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      // 等待普通控制操作与紧急停止请求全部 settle（网络请求有 30s 上限）。
      await Promise.allSettled([this.serial, this.inflight]);
      try { await this.finalizeClosed(); }
      finally { this.db.close(); }
    })();
    return this.closePromise;
  }
  /** 紧急停止请求的在途跟踪（emergency 不排队，需单独等待）。 */
  private inflight: Promise<unknown> = Promise.resolve();
}
