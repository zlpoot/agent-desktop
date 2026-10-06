import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ActionResult, ComputerAction, GroundingResult, Observation } from "../../actions/schema.js";
import type { ActionResolution } from "../../actions/action-resolution.js";
import type { RuntimeAdapter } from "../runtime-adapter.js";
import type { InputAuthority } from "../../contracts/desktop-input-control.js";

export interface PhysicalHandshake { instanceId: string; inputResourceId: string; ready: boolean; }
export interface PhysicalInputPolicy { readonly windowManagement: boolean; readonly executors: readonly string[]; }
export class PhysicalWorkerTransportError extends Error {}

export interface DesktopRuntimeOptions {
  windowTitle?: string;
  windowHandle?: number;
  windowClass?: string;
  processPath?: string;
  processId?: number;
  artifactDir?: string;
  pythonPath?: string;
}

export interface WindowFilter {
  windowTitle?: string;
  windowClass?: string;
  processPath?: string;
}

export interface WindowInfo {
  handle: number;
  title: string;
  windowClass: string;
  processId: number;
  processPath: string | null;
  targetElevated: boolean | null;
  visible: boolean;
  minimized: boolean;
  foreground: boolean;
  rect: { left: number; top: number; width: number; height: number };
}

export interface DesktopProbe {
  windowClass: string;
  foreground: boolean;
  elevated: boolean;
  targetElevated: boolean | null;
  permissionsCompatible: boolean;
  title: string;
  processId: number;
  processPath: string | null;
  visible: boolean;
  minimized: boolean;
  rect: WindowInfo["rect"];
  uiaControls: boolean;
}

interface WorkerResponse { id: number; result?: unknown; error?: string }

export class DesktopRuntime implements RuntimeAdapter {
  readonly name = "Windows UIA";
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly process: ChildProcessWithoutNullStreams;
  private errors = "";
  private physicalIdentity?: PhysicalHandshake;
  private inputAuthority?: InputAuthority;

  private constructor(options: DesktopRuntimeOptions) {
    if (process.platform !== "win32") throw new Error("桌面运行时仅支持 Windows");
    this.process = spawn(options.pythonPath ?? "python", [resolve("src/runtime/desktop/worker.py")], {
      cwd: resolve("."), stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => {
      let message: WorkerResponse;
      try { message = JSON.parse(line) as WorkerResponse; } catch { return; }
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error));
      else waiting.resolve(message.result);
    });
    this.process.stderr.on("data", (chunk: Buffer) => { this.errors = (this.errors + chunk.toString()).slice(-4000); });
    this.process.on("exit", (code) => {
      const ErrorType = this.physicalIdentity ? PhysicalWorkerTransportError : Error;
      for (const waiting of this.pending.values()) waiting.reject(new ErrorType(
        `桌面运行时已退出（${code}）：${this.errors}`));
      this.pending.clear();
    });
    this.process.on("error", error => {
      for (const waiting of this.pending.values()) waiting.reject(this.physicalIdentity ?
        new PhysicalWorkerTransportError(error.message) : error);
      this.pending.clear();
    });
  }

  static async attach(options: DesktopRuntimeOptions): Promise<DesktopRuntime> {
    if (!options.windowTitle && options.windowHandle === undefined &&
        !(options.windowClass && options.processPath)) {
      throw new Error("必须提供窗口标题、句柄，或窗口类名与进程路径");
    }
    const runtime = new DesktopRuntime(options);
    try {
      await runtime.call("init", { windowTitle: options.windowTitle,
        windowHandle: options.windowHandle, windowClass: options.windowClass,
        processPath: options.processPath,
        artifactDir: resolve(options.artifactDir ?? ".artifacts/desktop") });
      return runtime;
    } catch (error) { await runtime.close(); throw error; }
  }

  static async listWindows(filter: WindowFilter = {}, pythonPath?: string): Promise<WindowInfo[]> {
    const runtime = new DesktopRuntime({ pythonPath });
    try { return await runtime.call("list_windows", { ...filter }); }
    finally { await runtime.close(); }
  }

  private call<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const managed = !!this.physicalIdentity || method.startsWith("physical_");
      const timer = managed ? setTimeout(() => {
        this.pending.delete(id); reject(new PhysicalWorkerTransportError("Physical Worker RPC timeout; instance unconfirmed"));
        this.process.kill();
      }, 30000) : undefined;
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value as T); },
        reject: error => { clearTimeout(timer); reject(error); } });
      this.process.stdin.write(JSON.stringify({ id, method, args,
        ...(this.physicalIdentity ? { physicalIdentity: this.physicalIdentity, inputAuthority: this.inputAuthority } : {}) }) + "\n", (error) => {
        if (error) { this.pending.delete(id); clearTimeout(timer); reject(managed ? new PhysicalWorkerTransportError(error.message) : error); }
      });
    });
  }

  observe(screenCapture = false): Promise<Observation> { return this.call("observe", { screenCapture }); }
  /** Managed Provider path; legacy attach/listWindows do not opt into this protocol extension. */
  static async connectPhysical(policy: PhysicalInputPolicy, options: DesktopRuntimeOptions = {}): Promise<DesktopRuntime> {
    const runtime = new DesktopRuntime(options);
    try {
      runtime.physicalIdentity = await runtime.physicalHandshake(policy);
      return runtime;
    } catch (error) { await runtime.close(); throw error; }
  }
  async physicalHandshake(policy: PhysicalInputPolicy): Promise<PhysicalHandshake> {
    const value = await this.call<PhysicalHandshake>("physical_hello", { policy });
    if (this.physicalIdentity && (value.instanceId !== this.physicalIdentity.instanceId ||
      value.inputResourceId !== this.physicalIdentity.inputResourceId)) throw new Error("Physical Worker instance/resource changed");
    return value;
  }
  async grantPhysical(authority: InputAuthority, expiresAt: number): Promise<void> {
    await this.call("physical_grant", { authority, expiresAt }); this.inputAuthority = authority;
  }
  async revokePhysical(authority: InputAuthority): Promise<void> {
    await this.call("physical_revoke", { authority }); this.inputAuthority = undefined;
  }
  async bindPhysical(options: DesktopRuntimeOptions): Promise<void> {
    await this.call("init", { ...options, artifactDir: resolve(options.artifactDir ?? ".artifacts/desktop") });
  }
  windowsPhysical(filter: WindowFilter = {}): Promise<WindowInfo[]> { return this.call("list_windows", { ...filter }); }
  probe(focus = false): Promise<DesktopProbe> { return this.call("probe", { focus }); }
  async recoverFocus(): Promise<void> {
    const state = await this.probe(true);
    if (!state.permissionsCompatible) throw new Error("目标窗口权限高于当前工程");
    if (!state.foreground) throw new Error("目标窗口仍未处于前台");
  }
  ground(action: ComputerAction): Promise<GroundingResult> { return this.call("ground", { action }); }
  resolveAction(action: ComputerAction): Promise<ActionResolution> { return this.call("resolve_action", { action }); }
  execute(action: ComputerAction, resolution?: ActionResolution): Promise<ActionResult> {
    return this.call("execute", { action,
      allowedProviders: resolution?.candidates.filter((item) => item.available).map((item) => item.provider) });
  }

  async restore(observation: Observation): Promise<void> {
    if (observation.windowHandle === undefined || !observation.windowTitle) {
      throw new Error("保存的观察缺少桌面窗口身份");
    }
    const restored = await this.call<{ title: string; handle: number }>("restore", {
      windowTitle: observation.windowTitle, windowHandle: observation.windowHandle,
    });
    if (restored.handle !== observation.windowHandle || restored.title !== observation.windowTitle) {
      throw new Error("恢复的桌面窗口与保存的窗口不一致");
    }
  }

  async close(): Promise<void> {
    if (this.process.exitCode !== null) return;
    try { await this.call("close"); } finally { this.process.kill(); }
  }
}
