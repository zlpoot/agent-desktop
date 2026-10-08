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
import type { DesktopInputArbiter, InputAuthority, InputClient } from "../contracts/desktop-input-control.js";
import { assertDesktopCapabilities, DesktopAdmissionError, deny, sameSession } from "./admission.js";
import type { DesktopExecutionBackend, TargetBinding } from '../contracts/desktop-execution.js';
import type { DesktopObservationBinding } from '../contracts/desktop-environment.js';
import type { DesktopScenarioDefinition, DesktopScenarioOption, DesktopScenarioVerification } from '../contracts/desktop-scenario.js';

export type LocalWorkspaceAppConfig =
  | { app: "fixture" }
  | { app: "netease"; path: string; song: string; artist: string };
export interface LocalWorkspaceState {
  status: string; app: string; run_id: string; owner?: string; epoch?: number; control_ready?: boolean;
  app_version?: string; desktop?: string; cleanup?: { status?: string; job_active?: number; desktop_absent?: boolean };
  [key: string]: unknown;
}
export interface LocalWorkspaceFrame {
  observationToken: string;
  /** Remaining backend-clock lifetime; Host starts its conservative deadline before requesting the frame. */
  validForMs: number;
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
  activateGrant(runId: string, authority: InputAuthority): Promise<LocalWorkspaceState>;
  revokeGrant(runId: string, authority: InputAuthority): Promise<LocalWorkspaceState>;
  frame(authority: InputAuthority): Promise<LocalWorkspaceFrame>;
  act(runId: string, epoch: number, authority: InputAuthority, observationToken: string): Promise<LocalWorkspaceState>;
  ping(authority: InputAuthority): Promise<void>;
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
export interface LocalWorkspaceScenarioBackend extends DesktopExecutionBackend<string, void> {
  observe(authority: InputAuthority): Promise<{ observation: Observation; binding: DesktopObservationBinding }>;
  verify(authority: InputAuthority): Promise<DesktopScenarioVerification>;
  close(): Promise<void>;
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
  d0Owner: string;
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
  activateGrant(runId: string, authority: InputAuthority): Promise<LocalWorkspaceState> {
    return this.request("activate_grant", { run_id: runId, authority });
  }
  revokeGrant(runId: string, authority: InputAuthority): Promise<LocalWorkspaceState> {
    return this.request("revoke_grant", { run_id: runId, authority });
  }
  frame(authority: InputAuthority) { return this.request<LocalWorkspaceFrame>("frame", { authority }, 15000); }
  act(runId: string, epoch: number, authority: InputAuthority, observationToken: string) {
    return this.request<LocalWorkspaceState>("act", { run_id: runId, epoch, authority, observationToken });
  }
  async ping(authority: InputAuthority): Promise<void> { await this.request("ping", { authority }); }
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
  readonly inputControl: DesktopInputArbiter;
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
      const drained = record.runtime && sameSession(record.runtime.authority, authority) ? record.runtime.close() : Promise.resolve();
      if (record.state !== "open" || !successor) {
        let stopped: LocalWorkspaceState;
        try { stopped = await record.backend.stop(); }
        finally { await drained; }
        if (stopped.cleanup?.status !== "PASS" || stopped.cleanup.job_active !== 0 || stopped.cleanup.desktop_absent !== true)
          throw new WorkspaceBackendError("D0 job/Desktop cleanup unconfirmed");
        record.transitioning = false;
        return;
      }
      let next: LocalWorkspaceState;
      try { next = await record.backend.revokeGrant(record.runId, authority); }
      finally { await drained; }
      if (next.status !== "ready" || !next.control_ready || next.owner !== "none" || !Number.isInteger(next.epoch))
        throw new WorkspaceBackendError("D0 owner transition was not acknowledged");
      record.d0Epoch = next.epoch!;
      record.d0Owner = next.owner!;
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
  private async confirm(record: Binding): Promise<LocalWorkspaceState> {
    this.record(record.identity);
    if (record.transitioning) deny("local-workspace-transition-in-progress");
    // Management/preflight reads only native identity and acknowledged control facts.
    // Input authority is checked separately at observation/dispatch/effect time.
    const epoch = record.d0Epoch, owner = record.d0Owner;
    try {
      const current = await record.backend.state();
      if (record.transitioning || record.d0Epoch !== epoch || record.d0Owner !== owner) deny("local-workspace-transition-in-progress");
      if (current.state.status !== "ready" || current.state.app !== record.config.app || current.state.run_id !== record.runId ||
          current.state.desktop !== record.desktopName || current.targetId !== record.targetId ||
          current.backendInstanceId !== record.identity.instanceId ||
          current.windowsSessionId !== record.windowsSessionId || current.state.epoch !== record.d0Epoch ||
          current.state.owner !== owner || this.config.app === "netease" && current.state.app_version !== NETEASE_VERSION) {
        this.invalidate(record); deny("local-workspace-identity-drift");
      }
      return current.state;
    } catch (error) {
      if (!record.transitioning && record.d0Epoch === epoch && record.d0Owner === owner) this.invalidate(record);
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
    if (capability === "input.targetedWindow") {
      const declaration = (targetRole: string[], action: string, mechanism: string): CapabilityDeclaration =>
        ({ state, scope: { ...scope, targetRole, action: [action], mechanism: [mechanism] }, evidence });
      return [declaration(["owned-main-window"], "run-validated-scenario", "owned-hwnd-message"),
        declaration(this.config.app === "fixture" ? ["fixture-editor", "fixture-button"] : ["playback-button"],
          "viewer-click", "owned-hwnd-message"),
        ...(this.config.app === "fixture" ? [declaration(["fixture-editor"], "viewer-edit", "owned-hwnd-char")] : [])];
    }
    if (capability === "input.semantic") {
      scope.action = ["viewer-edit"]; scope.targetRole = ["search-editor"];
      return [{ state, scope: scope as CapabilityScope, evidence },
        { state, scope: { ...scope, action: ["viewer-click"], mechanism: ["uia-control-selection"] } as CapabilityScope, evidence }];
    }
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
  private async admit(record: Binding, capability: DesktopCapability, action: string, mechanism: string,
    targetRole = "owned-main-window"): Promise<void> {
    const provider = await this.capabilities();
    const target = this.targetCapabilities(provider);
    const state = await this.confirm(record);
    if (!state.control_ready || capability.startsWith("input.") && this.config.app === "netease" && !state.input_ready)
      deny("local-workspace-input-not-ready");
    const ready = { [capability]: { state: "ready" as const } };
    assertDesktopCapabilities([capability], { providerId: this.id, environmentKind: this.kind,
      application: this.app, applicationVersion: this.appVersion, targetRole, action, mechanism },
    { provider, session: provider, target }, { session: ready, target: ready });
  }
  private targetCapabilities(provider: DesktopCapabilities): DesktopCapabilities {
    return localWorkspaceTargetCapabilities(provider, this.app, this.appVersion);
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
      windowsSessionId: connection.windowsSessionId, d0Epoch: state.epoch!, d0Owner: state.owner!, transitioning: false, scenarioStarted: false };
    this.bindings.set(sessionId, record);
    if (this.closed) { await this.cleanup(record); deny("provider-closed"); }
    backend.setEventHandler(event => this.handleEvent(record, event));
    return Object.freeze({ ...identity,
      capabilities: async () => { this.record(identity); return this.capabilities(); },
      status: async () => {
        let native: LocalWorkspaceState | undefined;
        if (record.state === "open" && !record.transitioning) {
          try {
            native = await this.confirm(record);
          } catch { /* confirm invalidates identity failures; handoff is transient. */ }
        }
        const open = record.state === "open" && !record.transitioning && native?.control_ready === true;
        const capabilities = await this.capabilities();
        return { state: record.state, readiness: Object.fromEntries(Object.entries(capabilities).map(([key, values]) =>
          [key, { state: !open || key.startsWith('input.') && record.config.app === 'netease' && native?.input_ready !== true ?
            "not-ready" as const : values?.every(item => item.state === "supported") ? "ready" as const : "unknown" as const }])) };
      },
      close: async () => { if (record.state !== "closed") record.state = "closed"; await this.cleanup(record); },
    });
  }
  private async activate(authority: InputAuthority): Promise<void> {
    const record = this.record(authority);
    if (authority.owner.kind !== "agent" && authority.owner.kind !== "human") deny("invalid-local-workspace-owner");
    const state = await record.backend.activateGrant(record.runId, authority);
    if (state.status !== "ready" || !state.control_ready || state.owner !== authority.owner.kind || !Number.isInteger(state.epoch))
      throw new WorkspaceBackendError("D0 control epoch activation unconfirmed");
    record.d0Epoch = state.epoch!; record.d0Owner = state.owner!; record.authority = authority;
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
        void record.backend.ping(authority).catch(() => {
          if (record.authority === authority && !record.transitioning) this.invalidate(record);
        });
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
    const claimed = event.authority as InputAuthority | undefined;
    if (!claimed || !sameSession(claimed, authority) || claimed.grantId !== authority.grantId ||
        claimed.epoch !== authority.epoch || claimed.owner?.kind !== authority.owner.kind ||
        claimed.owner?.clientId !== authority.owner.clientId) deny("stale-local-workspace-viewer-grant");
    if (event.event === "viewer_input_authority") {
      if (event.owner !== "human" || authority.owner.kind !== "human") deny("human-authority-required");
      const context = event.context as { capability?: DesktopCapability; action?: string; mechanism?: string; targetRole?: string } | undefined;
      if (!context || event.targetId !== record.targetId ||
          !["input.targetedWindow", "input.semantic"].includes(context.capability ?? "") ||
          !["viewer-click", "viewer-edit"].includes(context.action ?? "") ||
          typeof context.mechanism !== "string" || typeof context.targetRole !== "string") deny("invalid-viewer-action-context");
      await this.admit(record, context.capability!, context.action!, context.mechanism, context.targetRole);
      this.input.assertAuthority(record.identity, authority);
      if (record.authority !== authority) deny("stale-local-workspace-viewer-grant");
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
      try { await record.backend.close(); } catch (error) { failures.push(error); }
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
  /** Read-only finite selection, with no worker construction or input claim. */
  scenarios(environmentId: string): readonly DesktopScenarioOption[] {
    const id = this.config.app === 'fixture' ? 'd0-fixture-text-click-v1' : 'd0-netease-fixed-track-v1';
    const definition = this.scenario(environmentId, id);
    return Object.freeze([
      Object.freeze({ id, label: definition.goal, availability: 'supported' as const,
        application: this.app, applicationVersion: this.appVersion, targetRole: 'owned-main-window',
        evidence: 'spikes/local-workspace/capability-matrix.md (D0-D)' }),
      Object.freeze({ id: 'packaged-notepad', label: '打包版 Notepad', availability: 'unsupported' as const,
        reason: '历史验证不支持' }),
      Object.freeze({ id: 'raw-isolated-input', label: 'RAW 隔离输入', availability: 'not-proven' as const,
        reason: '尚无已接受的能力证据' }),
      Object.freeze({ id: 'arbitrary-local-workspace', label: '任意应用 / 通用任务 / Workflow', availability: 'not-proven' as const,
        reason: '仅限已验证的固定场景' }),
    ]);
  }
  scenario(environmentId: string, id: string): DesktopScenarioDefinition {
    if (!this.available || this.closed) deny('local-workspace-unavailable');
    if (environmentId !== this.environmentId) deny('unknown-local-workspace-environment');
    const expected = this.config.app === 'fixture' ? 'd0-fixture-text-click-v1' : 'd0-netease-fixed-track-v1';
    if (id !== expected) deny('local-workspace-scenario-not-proven');
    return Object.freeze({ id, goal: this.config.app === 'fixture' ?
      '运行 D0 合成 EDIT/BUTTON 固定文本与点击场景' : '网易云 3.1.40.205461：播放孙燕姿《我怀念的》' });
  }
  /** P6-B production port: prepare/bind/status/requirements do not inspect authority.
   * Native observation tokens stay inside the existing P4 runtime and Python fence. */
  scenarioBackend(session: DesktopSession, artifactDir: string): LocalWorkspaceScenarioBackend {
    const record = this.record(session);
    let target: TargetBinding | undefined, runtime: LocalWorkspaceRuntime | undefined,
      authority: InputAuthority | undefined, observation: DesktopObservationBinding | undefined, closed = false, busy = false,
      closing: Promise<void> | undefined, drained: (() => void) | undefined;
    const check = () => { if (closed) deny('local-workspace-scenario-closed'); this.record(session); };
    const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
      check(); if (busy) deny('local-workspace-scenario-busy');
      busy = true;
      try { return await operation(); }
      finally { busy = false; drained?.(); drained = undefined; }
    };
    const assertTarget = (value: TargetBinding) => {
      check();
      if (!target || !sameSession(value, target) ||
          (['targetId', 'application', 'applicationVersion', 'targetRole'] as const).some(key => value[key] !== target![key]))
        deny('stale-target-binding');
    };
    const assertGrant = (value: InputAuthority) => {
      check(); this.input.assertAuthority(session, value);
      if (value.owner.kind !== 'agent' || !authority || authority.grantId !== value.grantId ||
          authority.epoch !== value.epoch || authority.owner.clientId !== value.owner.clientId || record.authority !== authority)
        deny('invalid-local-workspace-authority');
    };
    const observe = async (value: InputAuthority) => {
      check(); observation = undefined;
      this.input.assertAuthority(session, value);
      if (!target) deny('local-workspace-rebind-required');
      if (!runtime) {
        authority = value;
        runtime = this.connectRuntime(session, value, artifactDir);
        await runtime.bind();
      }
      assertGrant(value);
      const captured = await runtime.observe();
      assertGrant(value); assertTarget(target);
      const binding = Object.freeze({ ...target, observationId: randomUUID() });
      observation = binding;
      return { observation: captured, binding };
    };
    return {
      bind: async selector => {
        check(); this.scenario(session.environmentId, selector);
        if (target) deny('local-workspace-target-already-bound');
        await this.confirm(record); check();
        target = Object.freeze({ ...record.identity, targetId: record.targetId, application: this.app,
          applicationVersion: record.appVersion, targetRole: 'owned-main-window' });
        return target;
      },
      targetStatus: async value => {
        assertTarget(value);
        const native = await this.confirm(record); assertTarget(value);
        const capabilities = this.targetCapabilities(await this.capabilities());
        assertTarget(value);
        const ready = native.control_ready === true;
        return { binding: target!, state: 'bound', capabilities,
          readiness: Object.fromEntries(Object.entries(capabilities).map(([key, declarations]) => [key,
            { state: !ready || key.startsWith('input.') && record.config.app === 'netease' && native.input_ready !== true ?
              'not-ready' : declarations?.every(item => item.state === 'supported') ? 'ready' : 'unknown' }])) };
      },
      requirements: async (value, action) => {
        assertTarget(value); this.scenario(session.environmentId, action);
        return { action: 'run-validated-scenario', mechanism: 'owned-hwnd-message', required: ['input.targetedWindow'] };
      },
      observe: value => exclusive(() => observe(value)),
      execute: request => exclusive(async () => {
        // Independent backend check even when the caller bypasses the Host gate.
        assertTarget(request.target); this.scenario(session.environmentId, request.action); assertGrant(request.authority);
        if (!observation || !sameSession(request.observation, observation) || request.observation.targetId !== observation.targetId ||
            request.observation.observationId !== observation.observationId) deny('fresh-observation-required');
        observation = undefined; // Consume before any await; native token is independently single-use.
        await this.admit(record, 'input.targetedWindow', 'run-validated-scenario', 'owned-hwnd-message');
        assertTarget(request.target); assertGrant(request.authority);
        await runtime!.runValidatedScenario(); // Repeats authority/readiness/freshness, then Python/native effect fence.
      }),
      verify: value => exclusive(async () => {
        if (!record.scenarioStarted) deny('local-workspace-scenario-not-dispatched');
        const before = await this.confirm(record); assertGrant(value);
        const captured = await observe(value);
        // This independent read is never the act() response or command-queue acknowledgement.
        const state = await this.confirm(record); assertGrant(value);
        const facts: Record<string, string | number | boolean> = {};
        for (const key of ['input', 'agent_progress', 'agent_total', 'text_length', 'clicks', 'human_actions', 'track_matches', 'playing']) {
          const fact = state[key];
          if (typeof fact === 'string' || typeof fact === 'number' || typeof fact === 'boolean') facts[key] = fact;
        }
        const complete = (value: LocalWorkspaceState) => value.input === 'PASS' && value.human_actions === 0 && (record.config.app === 'fixture' ?
          value.agent_progress === 26 && value.agent_total === 26 && value.text_length === 26 && value.clicks === 1 :
          value.agent_progress === 4 && value.agent_total === 4 && value.track_matches === true && value.playing === true);
        const pass = complete(before) && complete(state);
        return { verdict: pass ? 'pass' : 'pending', observation: captured.observation, facts };
      }),
      close: () => closing ??= (async () => {
        closed = true; observation = undefined;
        const portDrain = busy ? new Promise<void>(resolveDrain => { drained = resolveDrain; }) : Promise.resolve();
        const results = await Promise.allSettled([runtime?.close(), portDrain]);
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, 'local-workspace-scenario-drain-failed');
      })(),
    };
  }
  /** Creates the bounded D0 scenario runtime after an Agent grant. */
  connectRuntime(session: DesktopSession, authority: InputAuthority, artifactDir: string): LocalWorkspaceRuntime {
    const record = this.record(session); this.input.assertAuthority(session, authority);
    if (authority.owner.kind !== "agent" || record.authority !== authority) deny("agent-authority-required");
    if (record.runtime) deny("local-workspace-runtime-busy");
    let closed = false, bound = false, observationDeadline = -Infinity, observationToken: string | undefined, lastFrameSequence = -1,
      lastFrameHash: string | undefined, lastFrameHeartbeat: number | undefined,
      lastFrameDeadline = -Infinity,
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
          await confirm(); bound = true; observationDeadline = -Infinity; observationToken = undefined;
          return Object.freeze({ ...session, targetId: record.targetId,
            capabilities: this.targetCapabilities(await this.capabilities()),
            readiness: (await session.status()).readiness });
        } finally { leave(); }
      },
      observe: async () => {
        const leave = enter();
        try {
          observationToken = undefined; observationDeadline = -Infinity;
          if (!bound) deny("local-workspace-rebind-required");
          await confirm();
          await this.admit(record, "observation.pixels", "observe", "d0-local-workspace");
          const frameRequestedAt = performance.now();
          const frame = await record.backend.frame(authority);
          if (typeof frame.observationToken !== "string" || !frame.observationToken ||
              !Number.isFinite(frame.validForMs) || frame.validForMs <= 0 || frame.validForMs > 2000)
            deny("local-workspace-observation-token-invalid");
          const deadline = frameRequestedAt + frame.validForMs;
          if (typeof frame.png !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.png))
            deny("local-workspace-frame-encoding-invalid");
          const image = Buffer.from(frame.png, "base64");
          const hash = createHash("sha256").update(image).digest("hex");
          const inspected = inspectD0Png(image);
          if (!inspected) deny("local-workspace-frame-integrity-failed:png");
          if (hash !== frame.metadata.sha256) deny("local-workspace-frame-integrity-failed:hash");
          if (frame.metadata.width !== inspected.width || frame.metadata.height !== inspected.height)
            deny("local-workspace-frame-integrity-failed:dimensions");
          if (!Number.isSafeInteger(frame.metadata.sequence) || frame.metadata.sequence < 1 ||
              !Number.isFinite(frame.metadata.heartbeat)) deny("local-workspace-frame-integrity-failed:metadata");
          if (frame.metadata.sequence < lastFrameSequence) deny("local-workspace-frame-integrity-failed:sequence-regressed");
          await confirm();
          if (performance.now() >= deadline) deny("fresh-observation-required");
          if (frame.metadata.sequence === lastFrameSequence) {
            if (performance.now() >= lastFrameDeadline) deny("fresh-observation-required");
            if (hash !== lastFrameHash || frame.metadata.heartbeat !== lastFrameHeartbeat)
              deny("local-workspace-frame-integrity-failed:sequence-reused");
            // Never publish a repeated frame or retain its new backend input token.
            // Only the already-dispatched Task may retry this read within its original deadline.
            deny("local-workspace-frame-repeated");
          }
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
          await confirm();
          if (performance.now() >= deadline) deny("fresh-observation-required");
          lastFrameSequence = frame.metadata.sequence; observationDeadline = deadline;
          lastFrameHash = hash; lastFrameHeartbeat = frame.metadata.heartbeat;
          lastFrameDeadline = deadline;
          observationToken = frame.observationToken; return observation;
        } catch (error) {
          const repeatedAfterDispatch = record.scenarioStarted && error instanceof DesktopAdmissionError &&
            error.reason === "local-workspace-frame-repeated";
          if (!repeatedAfterDispatch && !(closed && record.state === "open")) this.invalidate(record);
          throw error;
        }
        finally { leave(); }
      },
      runValidatedScenario: async () => {
        const leave = enter();
        if (!bound || !observationToken || performance.now() >= observationDeadline || record.scenarioStarted) {
          leave(); deny("fresh-observation-or-single-run-required");
        }
        try {
          await confirm();
          await this.admit(record, "input.targetedWindow", "run-validated-scenario", "owned-hwnd-message");
          check();
          if (!bound || !observationToken || performance.now() >= observationDeadline || record.scenarioStarted)
            deny("fresh-observation-or-single-run-required");
          const token = observationToken;
          record.scenarioStarted = true; observationDeadline = -Infinity; observationToken = undefined;
          const state = await record.backend.act(record.runId, record.d0Epoch, authority, token);
          await confirm(); return state;
        } catch (error) { if (!(closed && record.state === "open")) this.invalidate(record); throw error; }
        finally { leave(); }
      },
      close: () => closing ??= (async () => {
        closed = true; bound = false; observationDeadline = -Infinity; observationToken = undefined;
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
    const scope = { ...item.scope, application: [application], applicationVersion: [applicationVersion] };
    // Prohibitions remain prohibitions even for an unknown target.
    return { ...item, state: item.state === "forbidden" ? "forbidden" : state, scope };
  })])) as DesktopCapabilities;
}
