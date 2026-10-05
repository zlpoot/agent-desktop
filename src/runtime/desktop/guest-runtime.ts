import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ActionResult, ComputerAction, GroundingResult, Observation } from "../../actions/schema.js";
import type { ActionResolution } from "../../actions/action-resolution.js";
import type { DesktopProbe, DesktopRuntimeOptions, WindowFilter, WindowInfo } from "./desktop-runtime.js";
import type { VisionDesktopRuntime } from "./vision-runtime.js";
import { WorkerConnectionError, GuestAppSetupError, TargetWindowLostError } from "../../contracts/worker-error.js";
import type {DesktopFileSnapshot} from '../../verification/file-evidence.js';

type RpcReply<T> = { result?: T; error?: string; code?: string; screenshotBase64?: string };

/** One host task owns the guest's bound window. The guest accepts only named UI methods. */
export class GuestDesktopRuntime implements VisionDesktopRuntime {
  readonly name = "Agent Desktop Guest";
  private readonly id = randomUUID();
  private recoveryEpoch?: string;
  private readonly controlEpoch?: number;
  private fileRpc = false;

  private constructor(private readonly endpoint: string, private readonly token: string,
    private readonly vmId: string, private readonly artifactDir: string, controlEpoch?: number) {
    this.controlEpoch = controlEpoch;
  }

  static async connect(endpoint: string, token: string, vmId: string,
    artifactDir: string, controlEpoch?: number, expectedRecoveryEpoch?: string): Promise<GuestDesktopRuntime> {
    if (!token || !vmId) throw new Error("Guest Worker Token 和 VM ID 必填");
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error("Guest Worker 地址无效");
    const runtime = new GuestDesktopRuntime(url.origin, token, vmId, artifactDir, controlEpoch);
    let state: Response;
    try { state = await fetch(`${url.origin}/state`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) }); }
    catch (error) { throw new WorkerConnectionError(`Guest Worker 不可达：${String(error)}`); }
    const worker = state.ok ? await state.json() as { vm_id?: string; action_rpc?: boolean;
      recovery_epoch?: string; file_rpc?: boolean; control_epoch_rpc?: boolean; action_id_rpc?: boolean } : undefined;
    if (!worker || worker.vm_id !== vmId) {
      throw new WorkerConnectionError("Guest Worker 身份校验失败");
    }
    // Compatibility adapters pin the Session handshake across runtime connection races.
    // The unchanged RPC recoveryEpoch field remains independently checked by the Guest lock.
    if (expectedRecoveryEpoch !== undefined && (!expectedRecoveryEpoch || worker.recovery_epoch !== expectedRecoveryEpoch)) {
      throw new WorkerConnectionError("Guest Worker instance changed; reopen Session and reobserve");
    }
    if (!worker.action_rpc) throw new Error("Guest Worker 尚未启用 D2 Action RPC");
    if (controlEpoch !== undefined && (!worker.control_epoch_rpc || !worker.action_id_rpc))
      throw new WorkerConnectionError("Guest Worker 协议不兼容，需要 ControlEpoch/ActionId RPC；请更新 Worker");
    runtime.recoveryEpoch = worker.recovery_epoch;
    runtime.fileRpc = worker.file_rpc === true;
    return runtime;
  }

  private async call<T>(method: string, args: Record<string, unknown> = {}, timeoutMs=30000): Promise<T> {
    let response: Response;
    try { response = await fetch(`${this.endpoint}/rpc`, {
      method: "POST", headers: { Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: this.id, vmId: this.vmId, recoveryEpoch: this.recoveryEpoch,
        controlEpoch: this.controlEpoch, method, args }),
      signal: AbortSignal.timeout(timeoutMs),
    }); } catch (error) { throw new WorkerConnectionError(`Guest RPC 连接中断：${String(error)}`); }
    let reply: RpcReply<T>;
    try { reply = await response.json() as RpcReply<T>; }
    catch { throw new WorkerConnectionError("Guest RPC 响应中断或格式无效"); }
    if (method === 'ensure_app' && reply.error && (reply.code === 'APP_SETUP_FAILED' || reply.error === 'Guest app did not become a visible foreground window')) {
      throw new GuestAppSetupError(reply.error);
    }
    // An action can close its original dialog. Keep this separate from a lost
    // Worker connection so recovery retains the pending action and its evidence.
    if (reply.error?.includes('绑定的窗口已关闭')) throw new TargetWindowLostError(reply.error);
    if (response.status >= 500 || [401, 403].includes(response.status) || /Worker session changed/i.test(reply.error ?? "")) {
      throw new WorkerConnectionError(reply.error ?? `Guest RPC HTTP ${response.status}`);
    }
    if (!response.ok || reply.error) throw new Error(reply.error ?? `Guest RPC HTTP ${response.status}`);
    if (reply.result === undefined) throw new Error("Guest RPC 缺少结果");
    if (reply.screenshotBase64 && reply.result && typeof reply.result === "object") {
      const png = Buffer.from(reply.screenshotBase64, "base64");
      if (png.length > 8_000_000 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
        throw new Error("Guest 截图无效");
      }
      await mkdir(this.artifactDir, { recursive: true });
      const file = resolve(this.artifactDir, `${randomUUID()}.png`);
      await writeFile(file, png);
      const value = reply.result as Record<string, unknown>;
      const hash = createHash("sha256").update(png).digest("hex");
      if (value.observation && typeof value.observation === "object") {
        (value.observation as Record<string, unknown>).screenshot = file;
        (value.observation as Record<string, unknown>).screenshotHash = hash;
      } else { value.screenshot = file; value.screenshotHash = hash; }
    }
    return reply.result;
  }

  listWindows(filter: WindowFilter = {}): Promise<WindowInfo[]> {
    return this.call("list_windows", { ...filter });
  }
  ensureApp(appId: string): Promise<{ handle: number; title: string }> {
    return this.call("ensure_app", { appId });
  }
  async attach(options: DesktopRuntimeOptions): Promise<void> {
    await this.call("init", { windowTitle: options.windowTitle,
      windowHandle: options.windowHandle, windowClass: options.windowClass,
      processPath: options.processPath, processId: options.processId });
  }
  async observe(screenCapture = true): Promise<Observation> {
    const observation = await this.call<Observation>("observe", { screenCapture });
    // Keep the RPC screenshot window-relative for grounding. /frame is an existing read-only API.
    // Captures are sequential, not an atomic snapshot; retain the desktop capture timestamp.
    try {
      const response = await fetch(`${this.endpoint}/frame`, {
        headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`Desktop frame HTTP ${response.status}`);
      const png = Buffer.from(await response.arrayBuffer());
      if (png.length > 8_000_000 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
        throw new Error('Invalid desktop frame');
      await mkdir(this.artifactDir, {recursive:true});
      const file = resolve(this.artifactDir, `${randomUUID()}-desktop.png`);
      await writeFile(file, png);
      observation.desktopScreenshot = file;
      observation.desktopScreenshotHash = createHash('sha256').update(png).digest('hex');
      observation.desktopCapturedAt = new Date().toISOString();
    } catch (error) {
      // Preserve window evidence and explicitly report missing desktop context.
      observation.desktopCaptureError = error instanceof Error ? error.message : 'Desktop capture failed';
    }
    return observation;
  }
  probe(focus = false): Promise<DesktopProbe> { return this.call("probe", { focus }); }
  async recoverFocus(): Promise<void> {
    const state = await this.probe(true);
    if (!state.foreground || !state.permissionsCompatible) throw new Error("Guest 目标窗口前台或权限检查失败");
  }
  ground(action: ComputerAction): Promise<GroundingResult> { return this.call("ground", { action }); }
  resolveAction(action: ComputerAction): Promise<ActionResolution> {
    return this.call("resolve_action", { action });
  }
  execute(action: ComputerAction, resolution?: ActionResolution, actionId: string = randomUUID()): Promise<ActionResult> {
    if (!resolution?.selected || !resolution.candidates.some(item =>
      item.provider === resolution.selected && item.available)) {
      throw new Error("Guest 动作缺少可用执行器授权");
    }
    return this.call("execute", { action, allowedProviders: [resolution.selected], actionId });
  }
  inspectFile(path:string):Promise<DesktopFileSnapshot> {
    if(!this.fileRpc)throw new Error('Guest file evidence unavailable');
    return this.call('inspect_file',{path},1500);
  }
  async restore(observation: Observation): Promise<void> {
    if (observation.windowHandle === undefined || !observation.windowTitle) {
      throw new Error("保存的 Guest 窗口身份不完整");
    }
    const restored = await this.call<{ handle: number; title: string }>("restore", {
      windowHandle: observation.windowHandle, windowTitle: observation.windowTitle });
    if (restored.handle !== observation.windowHandle || restored.title !== observation.windowTitle) {
      throw new Error("Guest 窗口身份已改变");
    }
  }
  async close(): Promise<void> { try { await this.call("release"); } catch { /* Guest may be offline. */ } }
}
