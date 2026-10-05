import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import type { Server } from "node:http";
import WebSocket, { WebSocketServer } from "ws";

export interface DesktopSession {
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

type Row = { session_id: string; environment_type: "hyper-v"; vm_id: string;
  status: DesktopSession["status"]; current_task_id: string | null;
  worker_endpoint: string; created_at: string; last_seen_at: string | null;
  last_error: string | null };

function asSession(row: Row): DesktopSession {
  return { sessionId: row.session_id, environmentType: row.environment_type,
    vmId: row.vm_id, status: row.status, currentTaskId: row.current_task_id,
    workerEndpoint: row.worker_endpoint, createdAt: row.created_at,
    lastSeenAt: row.last_seen_at, lastError: row.last_error };
}

export class DesktopSessionManager {
  private readonly db: DatabaseSync;
  private readonly sockets = new Map<string, Set<WebSocket>>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  private timer?: NodeJS.Timeout;
  private pollPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private closed = false;
  /** 活跃会话集合：register 默认标记活跃（保存记录）；Session 作用域卸载时停用。
   *  全局轮询只访问活跃会话，卸载后的会话记录保留但不再被轮询。 */
  private readonly active = new Set<string>();
  controlMessage?: (sessionId: string, clientId: string, value: unknown) => Promise<unknown>;
  controlDisconnected?: (clientId: string, sessionId: string) => Promise<void>;

  /** 标记会话活跃/停用：停用后全局轮询跳过、拒绝新 WebSocket 连接。 */
  setActive(sessionId: string, active: boolean): void {
    if (active) this.active.add(sessionId);
    else this.active.delete(sessionId);
  }

  /** 断开某会话的全部网页连接（Session 作用域卸载时调用）。 */
  disconnect(sessionId: string): void {
    for (const client of this.sockets.get(sessionId) ?? []) client.terminate();
  }

  constructor(rootDir: string, private readonly token: string,
    private readonly intervalMs = 750) {
    this.db = new DatabaseSync(resolve(rootDir, "desktop-sessions.sqlite"));
    this.db.exec(`CREATE TABLE IF NOT EXISTS desktop_sessions (
      session_id TEXT PRIMARY KEY, environment_type TEXT NOT NULL, vm_id TEXT NOT NULL,
      status TEXT NOT NULL, current_task_id TEXT, worker_endpoint TEXT NOT NULL,
      created_at TEXT NOT NULL, last_seen_at TEXT, last_error TEXT)`);
    this.db.exec("UPDATE desktop_sessions SET status='connecting' WHERE status='online'");
  }

  register(vmId: string, endpoint: string, sessionId: string = randomUUID()): DesktopSession {
    if (!vmId.trim()) throw new Error("VM ID 不能为空");
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Worker 地址必须使用 HTTP(S)");
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("Worker 地址只能包含协议、主机和端口");
    }
    this.db.prepare(`INSERT INTO desktop_sessions
      (session_id, environment_type, vm_id, status, current_task_id, worker_endpoint, created_at, last_seen_at, last_error)
      VALUES (?, 'hyper-v', ?, 'connecting', NULL, ?, ?, NULL, NULL)
      ON CONFLICT(session_id) DO UPDATE SET vm_id=excluded.vm_id,
      worker_endpoint=excluded.worker_endpoint, status='connecting', last_error=NULL`)
      .run(sessionId, vmId, url.origin, new Date().toISOString());
    this.active.add(sessionId);
    return this.get(sessionId)!;
  }

  list(): DesktopSession[] {
    return (this.db.prepare("SELECT * FROM desktop_sessions ORDER BY created_at")
      .all() as Row[]).map(asSession);
  }

  get(id: string): DesktopSession | undefined {
    const row = this.db.prepare("SELECT * FROM desktop_sessions WHERE session_id=?")
      .get(id) as Row | undefined;
    return row && asSession(row);
  }

  updateWorkerEndpoint(sessionId: string, endpoint: string): void {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) throw new Error("Worker 地址无效");
    this.db.prepare("UPDATE desktop_sessions SET worker_endpoint=? WHERE session_id=?")
      .run(url.origin, sessionId);
  }

  setCurrentTask(sessionId: string, taskId: string | null): void {
    const result = this.db.prepare("UPDATE desktop_sessions SET current_task_id=? WHERE session_id=?")
      .run(taskId, sessionId);
    if (!result.changes) throw new Error("Desktop Session 不存在");
  }

  attach(server: Server): void {
    server.on("upgrade", (request, socket, head) => {
      const match = /^\/api\/desktop\/sessions\/([^/]+)\/stream$/.exec(request.url ?? "");
      let id: string | undefined;
      try { id = match ? decodeURIComponent(match[1]) : undefined; } catch { socket.destroy(); return; }
      const origin = request.headers.origin;
      if (!id || !this.active.has(id) || !this.get(id) || !origin || origin !== `http://${request.headers.host}`) {
        socket.destroy(); return;
      }
      this.wss.handleUpgrade(request, socket, head, (client) => {
        const clientId = randomUUID();
        client.on("error", () => { client.terminate(); });
        let alive = true;
        client.on("pong", () => { alive = true; });
        const heartbeat = setInterval(() => {
          if (!alive) { client.terminate(); return; }
          alive = false; client.ping();
        }, 10000);
        heartbeat.unref();
        let pending = 0;
        client.send(JSON.stringify({ type: "client", clientId }));
        client.on("message", (data, binary) => {
          if (binary || !Buffer.isBuffer(data) || data.length > 8192 || !this.controlMessage) return;
          let message: { requestId?: string; command?: string };
          try { message = JSON.parse(data.toString()); } catch { return; }
          if (!message || typeof message !== "object" || Array.isArray(message) ||
              typeof message.requestId !== "string" || message.requestId.length > 80 ||
              !["input", "pause", "stop", "take", "resume", "reset", "emergency"].includes(message.command ?? "")) {
            client.send(JSON.stringify({ type: "control", error: "控制消息格式无效" })); return;
          }
          if (pending >= 4 && message.command !== "emergency") {
            client.send(JSON.stringify({ type: "control", requestId: message.requestId, error: "控制请求过多，请稍后重试" })); return;
          }
          pending++;
          void this.controlMessage(id, clientId, message).then((result) => {
            if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "control", requestId: message.requestId, result }));
            else void this.controlDisconnected?.(clientId, id).catch(() => {});
          }).catch((error) => {
            if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "control", requestId: message.requestId, error: String(error) }));
          }).finally(() => { pending--; });
        });
        const members = this.sockets.get(id) ?? new Set<WebSocket>();
        members.add(client);
        this.sockets.set(id, members);
        client.on("close", () => { members.delete(client); if (!members.size) this.sockets.delete(id);
          clearInterval(heartbeat);
          void this.controlDisconnected?.(clientId, id).catch(() => {}); });
        client.send(JSON.stringify({ type: "session", session: this.get(id) }));
      });
    });
    this.timer = setInterval(() => { void this.poll(); }, this.intervalMs);
    this.timer.unref();
    void this.poll();
    // The assembly owns close(): an HTTP close event must not close the database
    // while Session controls are still recording their final revocation result.
  }

  /** 轮询当前活跃的会话；已卸载（停用）的会话保留记录但不再访问。 */
  pollActive(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = Promise.all(this.list().filter((session) =>
      this.active.has(session.sessionId)).map((session) => this.pollOne(session)))
      .then(() => { this.pollPromise = undefined; });
    return this.pollPromise;
  }

  poll(): Promise<void> {
    return this.pollActive();
  }

  private async pollOne(session: DesktopSession): Promise<void> {
    const headers = { Authorization: `Bearer ${this.token}` };
    try {
      const stateResponse = await fetch(`${session.workerEndpoint}/state`, {
        headers, signal: AbortSignal.timeout(3000) });
      if (!stateResponse.ok) throw new Error(`Worker 状态 HTTP ${stateResponse.status}`);
      const state = await stateResponse.json() as { vm_id?: string };
      if (state.vm_id !== session.vmId) throw new Error("Worker VM ID 不匹配");
      this.db.prepare("UPDATE desktop_sessions SET status='online', last_seen_at=?, last_error=NULL WHERE session_id=?")
        .run(new Date().toISOString(), session.sessionId);
    } catch (error) {
      this.db.prepare("UPDATE desktop_sessions SET status='offline', last_error=? WHERE session_id=?")
        .run(String(error), session.sessionId);
      this.broadcast(session.sessionId, JSON.stringify({ type: "session", session: this.get(session.sessionId) }));
      return;
    }
    try {
      const frameResponse = await fetch(`${session.workerEndpoint}/frame`, {
        headers, signal: AbortSignal.timeout(3000) });
      if (!frameResponse.ok || !frameResponse.headers.get("content-type")?.startsWith("image/png")) {
        throw new Error(`Worker 截图 HTTP ${frameResponse.status}`);
      }
      const frame = Buffer.from(await frameResponse.arrayBuffer());
      if (frame.length > 8_000_000 || frame.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
        throw new Error("Worker 截图不是有效 PNG 或文件过大");
      }
      this.broadcast(session.sessionId, frame);
    } catch (error) {
      this.db.prepare("UPDATE desktop_sessions SET last_error=? WHERE session_id=?")
        .run(String(error), session.sessionId);
      this.broadcast(session.sessionId, JSON.stringify({ type: "session", session: this.get(session.sessionId) }));
    }
  }

  private broadcast(id: string, data: Buffer | string): void {
    for (const socket of this.sockets.get(id) ?? []) {
      if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 4_000_000) socket.send(data);
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      if (this.timer) clearInterval(this.timer);
      for (const members of this.sockets.values()) for (const client of members) client.terminate();
      await this.pollPromise;
      this.wss.close();
      this.db.close();
    })();
    return this.closePromise;
  }
}
