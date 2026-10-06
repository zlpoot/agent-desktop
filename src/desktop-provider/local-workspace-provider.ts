import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import type { Observation } from "../actions/schema.js";
import type { CapabilityContext, CapabilityDeclaration, CapabilityScope, CapabilityState, DesktopCapabilities, DesktopCapability,
  DesktopProvider, DesktopSession, DesktopSessionIdentity, DesktopSessionStatus, DesktopTargetBinding,
  DesktopReadiness } from "../contracts/desktop-environment.js";
import type { DesktopInputArbiter, DesktopInputControl, InputAuthority, InputClient } from "../contracts/desktop-input-control.js";
import { assertDesktopCapabilities, deny, sameSession } from "./admission.js";

export type LocalWorkspaceAppConfig =
  | { app: "fixture" }
  | { app: "netease"; path: string; song: string; artist: string };
export interface LocalWorkspaceState {
  status: string; app: string; run_id: string; owner?: string; epoch?: number; control_ready?: boolean;
  app_version?: string; desktop?: string; cleanup?: { status?: string; job_active?: number; desktop_absent?: boolean };
  [key: string]: unknown;
}
export interface LocalWorkspaceFrame {
  png: string; metadata: { sequence: number; width: number; height: number; sha256: string; heartbeat: number };
  uia: Array<{ role: number; name: string; auto_id: string; class: string; enabled: boolean;
    offscreen: boolean; rect: [number, number, number, number] }>;
}
export interface LocalWorkspaceConnection {
  state: LocalWorkspaceState; targetId: string | null; viewerPort: number; viewerToken: string;
  windowsSessionId: number;
  backendInstanceId: string;
}
export interface LocalWorkspaceBackend {
  start(config: LocalWorkspaceAppConfig): Promise<LocalWorkspaceConnection>;
  state(): Promise<{ state: LocalWorkspaceState; targetId: string | null; windowsSessionId: number; backendInstanceId: string }>;
  setOwner(runId: string, owner: "agent" | "human"): Promise<LocalWorkspaceState>;
  frame(): Promise<LocalWorkspaceFrame>;
  act(runId: string, epoch: number): Promise<LocalWorkspaceState>;
  ping(): Promise<void>;
  stop(): Promise<LocalWorkspaceState>;
  viewerUrl(): string;
  setEventHandler(handler: (event: Record<string, unknown>) => Promise<unknown>): void;
  close(): Promise<void>;
}
export type LocalWorkspaceBackendFactory = (directory: string) => LocalWorkspaceBackend;
export interface LocalWorkspaceRuntime {
  bind(): Promise<LocalWorkspaceTarget>;
  observe(): Promise<Observation>;
  /** Only the prevalidated D0 scenario for this configured app can be started. */
  runValidatedScenario(): Promise<LocalWorkspaceState>;
  close(): Promise<void>;
}
export interface LocalWorkspaceTarget extends DesktopTargetBinding {
  readonly capabilities: DesktopCapabilities;
  readonly readiness: DesktopReadiness;
}
interface Binding {
  identity: DesktopSessionIdentity;
  state: DesktopSessionStatus["state"];
  config: LocalWorkspaceAppConfig;
  appVersion: string;
  backend: LocalWorkspaceBackend;
  targetId: string;
  runId: string;
  desktopName: string;
  windowsSessionId: number;
  d0Epoch: number;
  transitioning: boolean;
  scenarioStarted: boolean;
  authority?: InputAuthority;
  heartbeat?: NodeJS.Timeout;
  runtime?: { authority: InputAuthority; close(): Promise<void> };
  cleanup?: Promise<void>;
}
interface RpcMessage { id?: number; result?: any; error?: string; event?: string; eventId?: string; [key: string]: any; }

class WorkspaceBackendError extends Error {}

/** Authenticated local stdio bridge to spikes/local-workspace/provider_worker.py. */
class D0WorkspaceBackend implements LocalWorkspaceBackend {
  private readonly process: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private eventHandler: (event: Record<string, unknown>) => Promise<unknown> = async () => { throw new Error("workspace_event_unhandled"); };
  private closing?: Promise<void>;
  private outputError = "";
  private connection?: LocalWorkspaceConnection;

  constructor(private readonly directory: string, projectRoot: string, pythonPath = "python") {
    this.process = spawn(pythonPath, [resolve(projectRoot, "spikes/local-workspace/provider_worker.py"),
      "--directory", directory], { cwd: projectRoot, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    createInterface({ input: this.process.stdout }).on("line", line => {
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; } catch { return; }
      if (message.eventId && message.event) {
        void this.eventHandler(message).then(result => this.sendEventResult(message.eventId!, { result }))
          .catch(() => this.sendEventResult(message.eventId!, { error: "workspace_control_unconfirmed" }));
        return;
      }
      const waiting = this.pending.get(message.id ?? -1);
      if (!waiting) return;
      this.pending.delete(message.id!); clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new WorkspaceBackendError(message.error));
      else waiting.resolve(message.result);
    });
    this.process.stderr.on("data", chunk => { this.outputError = (this.outputError + chunk.toString()).slice(-2000); });
    this.process.on("exit", code => {
      for (const [id, waiting] of this.pending) {
        clearTimeout(waiting.timer); waiting.reject(new WorkspaceBackendError(`D0 provider worker exited (${code})`));
        this.pending.delete(id);
      }
    });
    this.process.on("error", error => {
      for (const [id, waiting] of this.pending) {
        clearTimeout(waiting.timer); waiting.reject(new WorkspaceBackendError(error.message)); this.pending.delete(id);
      }
    });
  }
  private request<T>(method: string, args: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new WorkspaceBackendError(`D0 provider ${method} timeout`)); this.process.kill();
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveResult, reject, timer });
      const identity = this.connection?.backendInstanceId;
      this.process.stdin.write(JSON.stringify({ id, method, args, ...(identity ? { identity } : {}) }) + "\n", error => {
        if (error) { this.pending.delete(id); clearTimeout(timer); reject(new WorkspaceBackendError("D0 provider transport failed")); }
      });
    });
  }
  private sendEventResult(eventId: string, value: Record<string, unknown>): void {
    if (this.process.exitCode !== null) return;
    this.process.stdin.write(JSON.stringify({ eventResult: eventId, ...value }) + "\n");
  }
  async start(config: LocalWorkspaceAppConfig): Promise<LocalWorkspaceConnection> {
    const args = config.app === "fixture" ? { app: "fixture" } :
      { app: "netease", netease: { path: config.path, song: config.song, artist: config.artist } };
    const raw = await this.request<LocalWorkspaceConnection>("start", args, 45000);
    if (!Number.isInteger(raw.viewerPort) || raw.viewerPort < 1 || raw.viewerPort > 65535 ||
      typeof raw.viewerToken !== "string" || !raw.viewerToken || !Number.isInteger(raw.windowsSessionId) ||
      typeof raw.backendInstanceId !== "string" || !raw.backendInstanceId) {
      throw new WorkspaceBackendError("D0 provider handshake invalid");
    }
    this.connection = raw; return raw;
  }
  state() { return this.request<{ state: LocalWorkspaceState; targetId: string | null; windowsSessionId: number; backendInstanceId: string }>("state"); }
  async setOwner(runId: string, owner: "agent" | "human"): Promise<LocalWorkspaceState> {
    return this.request("set_owner", { run_id: runId, owner });
  }
  frame() { return this.request<LocalWorkspaceFrame>("frame", {}, 15000); }
  act(runId: string, epoch: number) { return this.request<LocalWorkspaceState>("act", { run_id: runId, epoch }); }
  async ping(): Promise<void> { await this.request("ping"); }
  stop() { return this.request<LocalWorkspaceState>("stop"); }
  viewerUrl(): string {
    if (!this.connection) throw new WorkspaceBackendError("D0 provider not started");
    return `http://127.0.0.1:${this.connection.viewerPort}/#${this.connection.viewerToken}`;
  }
  setEventHandler(handler: (event: Record<string, unknown>) => Promise<unknown>): void { this.eventHandler = handler; }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      try { await this.request("close", {}, 12000); } finally { this.process.kill(); }
    })();
  }
}

const FIXTURE_VERSION = "d0-synthetic-fixture-v1";
const NETEASE_VERSION = "3.1.40.205461";
const NETEASE_ROLES = new Set([50000, 50004, 50007, 50011, 50018, 50019, 50026, 50029]);
const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function pngCrc(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ PNG_CRC_TABLE[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
/** D0 emits bounded 8-bit RGB PNGs. Validate full chunk/CRC/zlib/scanline structure. */
function inspectD0Png(bytes: Buffer): { width: number; height: number } | undefined {
  try {
    if (bytes.length > 16 * 1024 * 1024 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return;
    let offset = 8, width = 0, height = 0, gotIdat = false, ended = false, idatEnded = false;
    const idat: Buffer[] = [];
    while (offset < bytes.length) {
      if (bytes.length - offset < 12) return;
      const size = bytes.readUInt32BE(offset), end = offset + 12 + size;
      if (!Number.isSafeInteger(end) || end > bytes.length) return;
      const typeBytes = bytes.subarray(offset + 4, offset + 8), type = typeBytes.toString("ascii");
      const body = bytes.subarray(offset + 8, offset + 8 + size);
      if (pngCrc(bytes.subarray(offset + 4, offset + 8 + size)) !== bytes.readUInt32BE(offset + 8 + size)) return;
      if (offset === 8) {
        if (type !== "IHDR" || size !== 13) return;
        width = body.readUInt32BE(0); height = body.readUInt32BE(4);
        if (!width || !height || width > 2048 || height > 2048 || body[8] !== 8 || body[9] !== 2 ||
          body[10] !== 0 || body[11] !== 0 || body[12] !== 0) return;
      } else if (type === "IDAT") {
        if (idatEnded) return;
        gotIdat = true; idat.push(body);
      } else if (type === "IEND") {
        if (size !== 0 || !gotIdat || end !== bytes.length) return;
        ended = true; break;
      } else {
        if (gotIdat || (typeBytes[0] & 0x20) === 0) return;
      }
      if (gotIdat && type !== "IDAT") idatEnded = true;
      offset = end;
    }
    if (!ended) return;
    const expected = height * (width * 3 + 1);
    const pixels = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
    if (pixels.length !== expected) return;
    for (let row = 0; row < height; row++) if (pixels[row * (width * 3 + 1)] > 4) return;
    return { width, height };
  } catch { return; }
}

/** Bridges the capability-scoped D0 controller; it does not become a generic desktop executor. */
export class LocalWorkspaceDesktopProvider implements DesktopProvider {
  readonly id = "windows-local-workspace";
  readonly kind = "local-workspace" as const;
  readonly inputControl: DesktopInputControl;
  private readonly bindings = new Map<string, Binding>();
  private readonly opening = new Set<Promise<DesktopSession>>();
  private closed = false;
  private closing?: Promise<void>;
  private readonly environmentId: string;
  private readonly app: string;
  private readonly appVersion: string;
  private readonly config: LocalWorkspaceAppConfig;
  private readonly available: boolean;

  constructor(private readonly input: DesktopInputArbiter, config: LocalWorkspaceAppConfig | undefined,
    private readonly artifactRoot: string, private readonly projectRoot: string,
    private readonly factory: LocalWorkspaceBackendFactory = directory => new D0WorkspaceBackend(directory, projectRoot),
    available = process.platform === "win32") {
    this.inputControl = input;
    this.available = available && !!config;
    this.config = Object.freeze({ ...(config ?? { app: "fixture" as const }) });
    if (this.config.app !== "fixture" && this.config.app !== "netease")
      throw new Error("Local Workspace supports only the validated fixture or NetEase app");
    if (this.config.app === "netease" && (typeof this.config.path !== "string" || !this.config.path.trim() ||
        typeof this.config.song !== "string" || !this.config.song.trim() ||
        typeof this.config.artist !== "string" || !this.config.artist.trim()))
      throw new Error("Local Workspace NetEase requires an explicit executable, song, and artist");
    if (this.config.app === "netease" && (this.config.song !== "我怀念的" || this.config.artist !== "孙燕姿"))
      throw new Error("Local Workspace NetEase supports only the D0 validated song/artist");
    this.app = this.config.app === "fixture" ? "d0-synthetic-fixture" : "netease-cloud-music";
    this.appVersion = this.config.app === "fixture" ? FIXTURE_VERSION : NETEASE_VERSION;
    this.environmentId = `local-workspace:${this.config.app}`;
    input.registerBackend(identity => this.valid(identity), async (authority, successor) => {
      const record = this.bindings.get(authority.sessionId);
      if (!record || !sameSession(record.identity, authority)) return;
      record.transitioning = true;
      clearInterval(record.heartbeat); record.heartbeat = undefined; record.authority = undefined;
      if (record.runtime && sameSession(record.runtime.authority, authority)) await record.runtime.close();
      if (record.state !== "open" || !successor) {
        const stopped = await record.backend.stop();
        if (stopped.cleanup?.status !== "PASS" || stopped.cleanup.job_active !== 0 || stopped.cleanup.desktop_absent !== true)
          throw new WorkspaceBackendError("D0 job/Desktop cleanup unconfirmed");
        record.transitioning = false;
        return;
      }
      const next = await record.backend.setOwner(record.runId, successor.owner.kind);
      if (next.status !== "ready" || !next.control_ready || next.owner !== successor.owner.kind)
        throw new WorkspaceBackendError("D0 owner transition was not acknowledged");
      record.d0Epoch = next.epoch!;
    }, authority => this.activate(authority));
  }

  private valid(identity: DesktopSessionIdentity): boolean {
    const record = this.bindings.get(identity.sessionId);
    return !this.closed && !!record && record.state === "open" && sameSession(identity, record.identity);
  }
  private record(identity: DesktopSessionIdentity): Binding {
    if (!this.valid(identity)) deny("stale-session");
    return this.bindings.get(identity.sessionId)!;
  }
  private async confirm(record: Binding): Promise<void> {
    this.record(record.identity);
    if (record.transitioning) deny("local-workspace-transition-in-progress");
    try {
      const current = await record.backend.state();
      const owner = record.authority?.owner.kind ?? "agent";
      if (current.state.status !== "ready" || current.state.run_id !== record.runId ||
          current.state.desktop !== record.desktopName || current.targetId !== record.targetId ||
          current.backendInstanceId !== record.identity.instanceId ||
          current.windowsSessionId !== record.windowsSessionId || current.state.epoch !== record.d0Epoch ||
          current.state.owner !== owner || this.config.app === "netease" && current.state.app_version !== NETEASE_VERSION) {
        this.invalidate(record); deny("local-workspace-identity-drift");
      }
    } catch (error) {
      this.invalidate(record);
      throw error;
    }
  }
  private declarations(capability: DesktopCapability): CapabilityDeclaration[] {
    const scope: Partial<Record<keyof CapabilityContext, string[]>> = { providerId: [this.id], environmentKind: [this.kind], application: [this.app],
      applicationVersion: [this.appVersion], targetRole: ["owned-main-window"], mechanism: ["d0-local-workspace"] };
    const evidence = [{ source: "spikes/local-workspace/capability-matrix.md (D0-D)",
      description: "Accepted capability-scoped D0 evidence; does not imply arbitrary-app compatibility" }];
    let state: CapabilityState;
    if (capability === "observation.pixels" || capability === "input.targetedWindow" ||
        capability.startsWith("control.") || capability === "isolation.separateDesktop" ||
        capability === "isolation.sharedUserSession") state = "supported";
    else if (capability === "input.globalInput") state = "forbidden";
    else if (capability === "input.rawIsolated") state = "not-proven";
    else if (capability === "observation.accessibility" || capability === "input.semantic")
      state = this.config.app === "netease" ? "supported" : "not-proven";
    else if (capability === "isolation.separateOs") state = "unsupported";
    else state = "not-proven";
    if (capability === "observation.accessibility" || capability === "input.semantic") {
      scope.application = ["netease-cloud-music"]; scope.applicationVersion = [NETEASE_VERSION];
      scope.mechanism = [capability === "input.semantic" ? "uia-valuepattern" : "uia-owned-descendants"];
      if (this.config.app !== "netease") state = "not-proven";
    }
    if (capability === "input.targetedWindow") { scope.mechanism = ["owned-hwnd-message"]; scope.action = ["run-validated-scenario", "viewer-click"]; }
    if (capability === "input.semantic") scope.action = ["viewer-edit"];
    if (capability.startsWith("observation.")) scope.action = ["observe"];
    if (capability === "isolation.separateDesktop") scope.mechanism = ["win32-hidden-desktop"];
    if (capability === "isolation.separateOs" || capability === "isolation.sharedUserSession")
      scope.mechanism = ["same-windows-session"];
    if (capability === "input.globalInput") scope.mechanism = ["system-input"];
    if (capability === "input.rawIsolated") scope.mechanism = ["raw-hidden-desktop-input"];
    if (capability.startsWith("control.")) scope.mechanism = ["d0-owner-epoch-and-viewer-lease"];
    return [{ state, scope: scope as CapabilityScope, evidence }];
  }
  async capabilities(): Promise<DesktopCapabilities> {
    const keys: DesktopCapability[] = ["observation.pixels", "observation.accessibility", "input.targetedWindow", "input.semantic",
      "input.rawIsolated", "input.globalInput", "control.humanTakeover", "control.resumable",
      "control.leaseProtected", "isolation.separateDesktop", "isolation.separateOs", "isolation.sharedUserSession"];
    return Object.fromEntries(keys.map(key => [key, this.declarations(key)])) as DesktopCapabilities;
  }
  private async admit(capability: DesktopCapability, action: string, mechanism: string): Promise<void> {
    const provider = await this.capabilities();
    const target = localWorkspaceTargetCapabilities(provider, this.app, this.appVersion);
    const ready = { [capability]: { state: "ready" as const } };
    assertDesktopCapabilities([capability], { providerId: this.id, environmentKind: this.kind,
      application: this.app, applicationVersion: this.appVersion, targetRole: "owned-main-window", action, mechanism },
    { provider, session: provider, target }, { session: ready, target: ready });
  }
  async discover() {
    if (this.closed) deny("provider-closed");
    return this.available ? [{ providerId: this.id, environmentId: this.environmentId, kind: this.kind }] : [];
  }
  open(environmentId: string): Promise<DesktopSession> {
    const opening = this.openWorkspace(environmentId);
    this.opening.add(opening);
    void opening.finally(() => this.opening.delete(opening)).catch(() => {});
    return opening;
  }
  private async openWorkspace(environmentId: string): Promise<DesktopSession> {
    if (!this.available || this.closed) deny("local-workspace-unavailable");
    if (environmentId !== this.environmentId) deny("unknown-local-workspace-environment");
    const sessionId = randomUUID();
    const directory = resolve(this.artifactRoot, sessionId);
    await mkdir(directory, { recursive: true });
    const backend = this.factory(directory);
    let connection: LocalWorkspaceConnection;
    try { connection = await backend.start(this.config); }
    catch (error) { await backend.close().catch(() => {}); throw error; }
    const state = connection.state;
    if (state.status !== "ready" || state.control_ready !== true || state.owner !== "agent" ||
      !Number.isSafeInteger(state.epoch) || !state.run_id || !state.desktop?.startsWith("AgentD0_") ||
      !connection.targetId || !Number.isInteger(connection.windowsSessionId) || !connection.backendInstanceId ||
      this.config.app === "netease" && state.app_version !== NETEASE_VERSION) {
      const stopped = await backend.stop().catch(() => undefined);
      await backend.close().catch(() => {});
      if (this.config.app === "netease" && state.app_version !== NETEASE_VERSION) deny("unsupported-netease-version");
      deny(stopped?.cleanup?.status === "PASS" ? "local-workspace-handshake-invalid" : "local-workspace-cleanup-unconfirmed");
    }
    const inputResourceId = `local-workspace-input:${createHash("sha256").update(
      `${process.env.COMPUTERNAME ?? "windows"}\0${connection.windowsSessionId}\0${state.desktop}`).digest("hex")}`;
    const identity = Object.freeze({ providerId: this.id, environmentId, sessionId, instanceId: connection.backendInstanceId,
      inputResourceId });
    const record: Binding = { identity, state: this.closed ? "closed" : "open", config: this.config, appVersion: this.appVersion,
      backend, targetId: connection.targetId, runId: state.run_id, desktopName: state.desktop!,
      windowsSessionId: connection.windowsSessionId, d0Epoch: state.epoch!, transitioning: false, scenarioStarted: false };
    this.bindings.set(sessionId, record);
    if (this.closed) { await this.cleanup(record); deny("provider-closed"); }
    backend.setEventHandler(event => this.handleEvent(record, event));
    return Object.freeze({ ...identity,
      capabilities: async () => { this.record(identity); return this.capabilities(); },
      status: async () => {
        if (record.state === "open" && !record.transitioning) {
          try {
            await this.confirm(record);
          } catch { this.invalidate(record); }
        }
        const open = record.state === "open" && !record.transitioning;
        const capabilities = await this.capabilities();
        return { state: record.state, readiness: Object.fromEntries(Object.entries(capabilities).map(([key, values]) =>
          [key, { state: !open ? "not-ready" as const : values?.every(item => item.state === "supported") ? "ready" as const : "unknown" as const }])) };
      },
      close: async () => { if (record.state !== "closed") record.state = "closed"; await this.cleanup(record); },
    });
  }
  private async activate(authority: InputAuthority): Promise<void> {
    const record = this.record(authority);
    if (authority.owner.kind !== "agent" && authority.owner.kind !== "human") deny("invalid-local-workspace-owner");
    const state = await record.backend.setOwner(record.runId, authority.owner.kind);
    if (state.status !== "ready" || !state.control_ready || state.owner !== authority.owner.kind || !Number.isInteger(state.epoch))
      throw new WorkspaceBackendError("D0 control epoch activation unconfirmed");
    record.d0Epoch = state.epoch!; record.authority = authority;
    record.transitioning = false;
    if (authority.owner.kind === "agent") {
      clearInterval(record.heartbeat);
      record.heartbeat = setInterval(() => {
        if (record.state !== "open" || record.authority !== authority) return;
        try {
          if (!this.input.renewAuthority) deny("input-authority-renewal-unavailable");
          this.input.renewAuthority(authority);
        }
        catch { this.invalidate(record); return; }
        void record.backend.ping().catch(() => this.invalidate(record));
      }, 500);
      record.heartbeat.unref();
    } else { clearInterval(record.heartbeat); record.heartbeat = undefined; }
  }
  private async handleEvent(record: Binding, event: Record<string, unknown>): Promise<unknown> {
    this.record(record.identity);
    if (event.run_id !== record.runId || event.epoch !== record.d0Epoch) deny("stale-local-workspace-viewer-event");
    const authority = record.authority;
    if (!authority) deny("local-workspace-input-unowned");
    this.input.assertAuthority(record.identity, authority);
    if (event.event === "viewer_input_authority") {
      if (event.owner !== "human" || authority.owner.kind !== "human") deny("human-authority-required");
      return true;
    }
    if (event.event === "viewer_heartbeat") {
      if (event.owner !== "human" || authority.owner.kind !== "human") deny("viewer-heartbeat-without-human-owner");
      if (!this.input.renewAuthority) deny("input-authority-renewal-unavailable");
      this.input.renewAuthority(authority);
      return true;
    }
    if (event.event === "viewer_transfer") {
      if (event.owner !== "agent" && event.owner !== "human") deny("unsupported-local-workspace-transfer");
      const nextOwner: InputClient = event.owner === "agent"
        ? { kind: "agent", clientId: "local-workspace-agent" }
        : { kind: "human", clientId: "local-workspace-viewer" };
      await this.input.transfer(authority, nextOwner);
      return record.backend.state().then(value => value.state);
    }
    deny("unsupported-local-workspace-event");
  }
  private invalidate(record: Binding): void {
    if (record.state !== "open") return;
    record.state = "stale"; clearInterval(record.heartbeat); record.heartbeat = undefined;
    void this.cleanup(record).catch(() => {});
  }
  private cleanup(record: Binding): Promise<void> {
    return record.cleanup ??= (async () => {
      clearInterval(record.heartbeat); record.heartbeat = undefined; record.authority = undefined;
      const failures: unknown[] = [];
      try { await this.input.revokeSession(record.identity); } catch (error) { failures.push(error); }
      let stopped: LocalWorkspaceState | undefined;
      try { stopped = await record.backend.stop(); } catch (error) { failures.push(error); }
      const cleanupConfirmed = stopped?.cleanup?.status === "PASS" && stopped.cleanup.job_active === 0 &&
        stopped.cleanup.desktop_absent === true;
      if (!cleanupConfirmed) failures.push(new WorkspaceBackendError("D0 owned Job/Desktop cleanup was not confirmed"));
      if (cleanupConfirmed) {
        try { await record.backend.close(); } catch (error) { failures.push(error); }
      }
      if (failures.length) {
        this.input.blockResource(record.identity);
        throw new AggregateError(failures, "Local Workspace revoke/cleanup was not confirmed; input resource blocked");
      }
    })();
  }
  /** Trusted integration only. The bearer Viewer URL is never included in an observation. */
  viewerUrl(session: DesktopSession, authority: InputAuthority): string {
    const record = this.record(session);
    this.input.assertAuthority(session, authority);
    if (authority.owner.kind !== "human" || record.authority !== authority) deny("human-viewer-authority-required");
    return record.backend.viewerUrl();
  }
  /** Creates the bounded D0 scenario runtime after an Agent grant. */
  connectRuntime(session: DesktopSession, authority: InputAuthority, artifactDir: string): LocalWorkspaceRuntime {
    const record = this.record(session); this.input.assertAuthority(session, authority);
    if (authority.owner.kind !== "agent" || record.authority !== authority) deny("agent-authority-required");
    if (record.runtime) deny("local-workspace-runtime-busy");
    let closed = false, bound = false, observedAt = -Infinity, lastFrameSequence = -1,
      activeOperations = 0, closing: Promise<void> | undefined;
    let drained: (() => void) | undefined;
    const check = () => {
      if (closed) deny("local-workspace-runtime-closed");
      this.record(session); this.input.assertAuthority(session, authority);
      if (record.authority !== authority) deny("invalid-local-workspace-authority");
    };
    const enter = () => {
      check(); activeOperations++;
      return () => { activeOperations--; if (activeOperations === 0) { drained?.(); drained = undefined; } };
    };
    const confirm = async () => {
      check();
      try { await this.confirm(record); }
      catch (error) { throw error; }
      check();
    };
    const runtime: LocalWorkspaceRuntime = {
      bind: async () => {
        const leave = enter();
        try {
          await confirm(); bound = true; observedAt = -Infinity;
          return Object.freeze({ ...session, targetId: record.targetId,
            capabilities: localWorkspaceTargetCapabilities(await this.capabilities(), this.app, this.appVersion),
            readiness: (await session.status()).readiness });
        } finally { leave(); }
      },
      observe: async () => {
        const leave = enter();
        try {
          if (!bound) deny("local-workspace-rebind-required");
          await confirm();
          await this.admit("observation.pixels", "observe", "d0-local-workspace");
          const frame = await record.backend.frame();
          if (typeof frame.png !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.png))
            deny("local-workspace-frame-encoding-invalid");
          const image = Buffer.from(frame.png, "base64");
          const hash = createHash("sha256").update(image).digest("hex");
          const inspected = inspectD0Png(image);
          if (!inspected || hash !== frame.metadata.sha256 || !Number.isSafeInteger(frame.metadata.sequence) ||
              frame.metadata.sequence <= lastFrameSequence ||
              frame.metadata.width <= 0 || frame.metadata.width > 2048 ||
              frame.metadata.height <= 0 || frame.metadata.height > 2048 ||
              frame.metadata.width !== inspected.width || frame.metadata.height !== inspected.height)
            deny("local-workspace-frame-integrity-failed");
          await confirm();
          const folder = resolve(artifactDir, "local-workspace", record.runId);
          if (!folder.startsWith(resolve(artifactDir) + "/") && !folder.startsWith(resolve(artifactDir) + "\\"))
            deny("invalid-local-workspace-artifact-path");
          await mkdir(folder, { recursive: true });
          const screenshot = resolve(folder, `frame-${frame.metadata.sequence}.png`);
          await writeFile(screenshot, image);
          const items = record.config.app === "netease" ? frame.uia.filter(item => NETEASE_ROLES.has(item.role)).map(item => ({
            role: ({ 50000: "button", 50004: "edit", 50007: "listitem", 50011: "text", 50018: "list",
              50019: "tab", 50026: "listitem", 50029: "text" } as Record<number, string>)[item.role] ?? "unknown",
            name: item.name, classTokens: item.class ? [item.class] : [], complete: true,
          })) : [];
          const startedAt = performance.now();
          const observation: Observation = {
            windowTitle: record.config.app === "netease" ? "NetEase Cloud Music (D0 owned window)" : "D0 synthetic fixture",
            screenshot, screenshotHash: hash,
            capture: { epoch: record.runId, sequence: frame.metadata.sequence, object: record.targetId,
              startedAt, finishedAt: performance.now(), clock: "collector", atomic: false,
              enumerationComplete: record.config.app === "netease",
              fields: { screenshot: { complete: true, source: "window" },
                accessibility: { complete: record.config.app === "netease", source: "uia" } } },
            structured: record.config.app === "netease" ? { source: "uia", complete: true, items } : undefined,
            accessibility: record.config.app === "netease" ? JSON.stringify(items) : undefined,
          };
          await confirm(); lastFrameSequence = frame.metadata.sequence; observedAt = performance.now(); return observation;
        } catch (error) { if (!(closed && record.state === "open")) this.invalidate(record); throw error; }
        finally { leave(); }
      },
      runValidatedScenario: async () => {
        const leave = enter();
        if (!bound || performance.now() - observedAt > 2000 || record.scenarioStarted) {
          leave(); deny("fresh-observation-or-single-run-required");
        }
        try {
          record.scenarioStarted = true; observedAt = -Infinity;
          await confirm();
          await this.admit("input.targetedWindow", "run-validated-scenario", "owned-hwnd-message");
          const state = await record.backend.act(record.runId, record.d0Epoch);
          await confirm(); return state;
        } catch (error) { if (!(closed && record.state === "open")) this.invalidate(record); throw error; }
        finally { leave(); }
      },
      close: () => closing ??= (async () => {
        closed = true; bound = false; observedAt = -Infinity;
        if (activeOperations) await new Promise<void>(resolveDrain => { drained = resolveDrain; });
        if (record.runtime?.authority === authority) record.runtime = undefined;
      })(),
    };
    record.runtime = { authority, close: runtime.close };
    return runtime;
  }
  close(): Promise<void> { return this.closing ??= this.shutdown(); }
  private async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.opening]);
    for (const record of this.bindings.values()) if (record.state === "open") record.state = "closed";
    const results = await Promise.allSettled([...this.bindings.values()].map(record => this.cleanup(record)));
    const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, "LocalWorkspace cleanup unconfirmed");
  }
}

/** Injectable concrete factory; no process is created until a configured Session opens. */
export function createD0WorkspaceBackendFactory(projectRoot: string, pythonPath?: string): LocalWorkspaceBackendFactory {
  return directory => new D0WorkspaceBackend(directory, projectRoot, pythonPath);
}

export function localWorkspaceVersion(config: LocalWorkspaceAppConfig): string {
  return config.app === "fixture" ? FIXTURE_VERSION : NETEASE_VERSION;
}

/** Target reports cannot widen the configured Provider's app/version/action evidence. */
export function localWorkspaceTargetCapabilities(provider: DesktopCapabilities,
  application: string, applicationVersion: string): DesktopCapabilities {
  return Object.fromEntries(Object.entries(provider).map(([key, declarations]) => [key, declarations!.map(item => {
    const matches = item.scope.application?.includes(application) && item.scope.applicationVersion?.includes(applicationVersion);
    const state = matches ? item.state : application === "packaged-notepad" ? "unsupported" : "not-proven";
    const scope = { ...item.scope, application: [application], applicationVersion: [applicationVersion],
      ...(key === "input.targetedWindow" ? { action: ["run-validated-scenario"] } : {}),
      ...(key === "input.semantic" ? { targetRole: ["search-editor"] } : {}) };
    // Prohibitions remain prohibitions even for an unknown target.
    return { ...item, state: item.state === "forbidden" ? "forbidden" : state, scope };
  })])) as DesktopCapabilities;
}
