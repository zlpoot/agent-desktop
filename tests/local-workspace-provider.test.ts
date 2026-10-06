import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, mock } from "node:test";
import { LocalWorkspaceDesktopProvider, type LocalWorkspaceBackend, type LocalWorkspaceAppConfig,
  localWorkspaceTargetCapabilities,
  type LocalWorkspaceConnection, type LocalWorkspaceFrame, type LocalWorkspaceState } from "../src/desktop-provider/local-workspace-provider.js";
import { ResourceInputControl } from "../src/desktop-provider/resource-input-control.js";
import type { InputAuthority } from "../src/contracts/desktop-input-control.js";
import { assertDesktopCapabilities } from "../src/desktop-provider/admission.js";
import { createRootAssembly } from "../src/composition/root.js";

const agent = { kind: "agent", clientId: "p4-agent" } as const;
const human = { kind: "human", clientId: "p4-viewer" } as const;
const validPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const runId = "p4-run-1", desktopName = "AgentD0_p4-run-1", targetId = "p4-target-pid-hwnd-session-desktop";

function state(overrides: Partial<LocalWorkspaceState> = {}): LocalWorkspaceState {
  return { status: "ready", app: "fixture", run_id: runId, owner: "agent", epoch: 1, control_ready: true,
    desktop: desktopName, app_version: undefined, cleanup: undefined, ...overrides };
}
function frame(bytes = validPng): LocalWorkspaceFrame {
  return { observationToken: "synthetic-observation", validForMs: 2000, png: bytes.toString("base64"), metadata: { sequence: 1, width: 1, height: 1,
    sha256: createHash("sha256").update(bytes).digest("hex"), heartbeat: 1 }, uia: [] };
}
class FakeWorkspace implements LocalWorkspaceBackend {
  current = state();
  target = targetId;
  windowsSession = 7;
  instance = "bridge-worker-job-instance-1";
  image = frame();
  failStop = false;
  failTransition = false;
  onFrame?: () => void;
  acts = 0;
  stopCalls = 0;
  closeCalls = 0;
  sequence = 1;
  frameGate?: Promise<void>;
  handler?: (event: Record<string, unknown>) => Promise<unknown>;
  async start(_config: LocalWorkspaceAppConfig): Promise<LocalWorkspaceConnection> {
    return { state: structuredClone(this.current), targetId: this.target, viewerPort: 19101,
      viewerToken: "local-test-token", windowsSessionId: this.windowsSession, backendInstanceId: this.instance };
  }
  async state() { this.onState?.(); return { state: structuredClone(this.current), targetId: this.target, windowsSessionId: this.windowsSession,
    backendInstanceId: this.instance }; }
  grant?: InputAuthority;
  failClose = false;
  throwStop = false;
  onState?: () => void;
  async activateGrant(_id: string, authority: InputAuthority) {
    if (this.failTransition || this.grant) throw new Error("unconfirmed D0 grant activation");
    this.grant = authority;
    this.current = { ...this.current, owner: authority.owner.kind, epoch: (this.current.epoch ?? 0) + 1 };
    return this.current;
  }
  async revokeGrant(_id: string, authority: InputAuthority) {
    if (this.failTransition || this.grant !== authority) throw new Error("unconfirmed D0 owner transition");
    this.grant = undefined;
    this.current = { ...this.current, owner: "none", epoch: (this.current.epoch ?? 0) + 1 };
    return this.current;
  }
  async frame() {
    if (this.frameGate) await this.frameGate;
    const result = { ...this.image, metadata: { ...this.image.metadata, sequence: this.sequence++ } };
    this.onFrame?.(); return result;
  }
  async act(_id: string, epoch: number) {
    if (this.current.status !== "ready" || this.current.owner !== "agent" || this.current.epoch !== epoch)
      throw new Error("backend owner epoch denied");
    this.acts++; return { ...this.current, agent_progress: 1 };
  }
  async ping() {}
  async stop() {
    this.stopCalls++; if (this.throwStop) throw new Error("native stop threw");
    return { ...this.current, status: "stopped", cleanup: this.failStop ?
      { status: "FAIL", job_active: 1, desktop_absent: false } :
      { status: "PASS", job_active: 0, desktop_absent: true } };
  }
  viewerUrl() { return "http://127.0.0.1:19101/#local-test-token"; }
  setEventHandler(handler: (event: Record<string, unknown>) => Promise<unknown>) { this.handler = handler; }
  async close() { this.closeCalls++; if (this.failClose) throw new Error("bridge close failed"); }
}
function fixture(config: LocalWorkspaceAppConfig = { app: "fixture" }, arbiter = new ResourceInputControl(() => 0)) {
  const root = mkdtempSync(join(tmpdir(), "local-workspace-p4-"));
  const backend = new FakeWorkspace();
  if (config.app === "netease") backend.current = state({ app: "netease", app_version: "3.1.40.205461", input_ready: true });
  const provider = new LocalWorkspaceDesktopProvider(arbiter, config,
    join(root, "artifacts"), process.cwd(), () => backend, true);
  return { root, arbiter, backend, provider, async dispose() {
    try { await provider.close(); } catch { /* asserted at the call site */ }
    rmSync(root, { recursive: true, force: true });
  } };
}
async function opened(f: ReturnType<typeof fixture>) {
  const session = await f.provider.open("local-workspace:" + (f.backend.current.app === "netease" ? "netease" : "fixture"));
  const authority = await f.arbiter.acquire(session, agent);
  const runtime = f.provider.connectRuntime(session, authority, join(f.root, "artifacts"));
  await runtime.bind();
  return { session, authority, runtime };
}

test("capabilities remain exact-app scoped and preserve D0 historical boundaries", async () => {
  const fixtureProvider = fixture();
  const neteaseProvider = fixture({ app: "netease", path: "synthetic/cloudmusic.exe", song: "我怀念的", artist: "孙燕姿" });
  try {
    const fSession = await fixtureProvider.provider.open("local-workspace:fixture");
    const fCaps = await fSession.capabilities();
    assert.equal(fCaps["input.rawIsolated"]?.[0].state, "not-proven");
    assert.equal(fCaps["input.globalInput"]?.[0].state, "forbidden");
    assert.equal(fCaps["input.semantic"]?.[0].state, "not-proven");
    assert.deepEqual(fCaps["input.semantic"]?.[0].scope.application, ["netease-cloud-music"]);
    assert.deepEqual(fCaps["observation.pixels"]?.[0].scope.application, ["d0-synthetic-fixture"]);
    const nSession = await neteaseProvider.provider.open("local-workspace:netease");
    const nCaps = await nSession.capabilities();
    assert.equal(nCaps["observation.accessibility"]?.[0].state, "supported");
    assert.deepEqual(nCaps["observation.accessibility"]?.[0].scope.applicationVersion, ["3.1.40.205461"]);
    assert.deepEqual(nCaps["input.semantic"]?.[0].scope.application, ["netease-cloud-music"]);
    assert.throws(() => new LocalWorkspaceDesktopProvider(new ResourceInputControl(),
      { app: "chrome" } as unknown as LocalWorkspaceAppConfig, ".", process.cwd(), () => new FakeWorkspace(), true),
    /supports only the validated fixture or NetEase/);
    const matrix = JSON.parse(readFileSync(resolve("spikes/local-workspace/capability-matrix.json"), "utf8")) as {
      capabilities: Array<{ capability: string; result: string }> };
    assert.equal(matrix.capabilities.find(item => item.capability === "RAW_ISOLATED_INPUT")?.result, "NOT_PROVEN");
    assert.equal(matrix.capabilities.find(item => item.capability === "GLOBAL_INPUT")?.result, "FORBIDDEN");
    assert.equal(matrix.capabilities.find(item => item.capability === "PACKAGED_NOTEPAD")?.result, "UNSUPPORTED");
  } finally { await fixtureProvider.dispose(); await neteaseProvider.dispose(); }
});

test("target, desktop, process target, instance and owner epoch drift permanently stale old bindings", async () => {
  for (const drift of ["target", "desktop", "process", "instance", "worker-job", "epoch", "owner"] as const) {
    const f = fixture();
    try {
      const { session, runtime } = await opened(f);
      await runtime.observe();
      if (drift === "target" || drift === "process") f.backend.target = "replacement-target-pid-hwnd";
      if (drift === "desktop") f.backend.current = { ...f.backend.current, desktop: "AgentD0_replacement" };
      if (drift === "instance") f.backend.current = { ...f.backend.current, run_id: "replacement-run" };
      if (drift === "worker-job") f.backend.instance = "replacement-worker-job";
      if (drift === "epoch") f.backend.current = { ...f.backend.current, epoch: (f.backend.current.epoch ?? 0) + 1 };
      if (drift === "owner") f.backend.current = { ...f.backend.current, owner: "human" };
      assert.equal((await session.status()).state, "stale", drift);
      // Reverting the backend must not revive a Session, its runtime, or its old observation.
      f.backend.current = state(); f.backend.target = targetId; f.backend.instance = "bridge-worker-job-instance-1";
      await assert.rejects(runtime.observe(), /stale-session|runtime-closed/);
      await assert.rejects(runtime.runValidatedScenario(), /stale-session|runtime-closed/);
      await assert.rejects(session.capabilities(), /stale-session/);
    } finally { await f.dispose(); }
  }
});

test("truncated/incomplete PNGs and identity changes during capture fail closed", async () => {
  for (const bytes of [validPng.subarray(0, validPng.length - 12), validPng.subarray(0, 28)]) {
    const f = fixture();
    try {
      const { runtime } = await opened(f); f.backend.image = frame(bytes);
      await assert.rejects(runtime.observe(), /frame-integrity-failed/);
      assert.equal(f.backend.acts, 0);
    } finally { await f.dispose(); }
  }
  const f = fixture();
  try {
    const { runtime } = await opened(f);
    f.backend.onFrame = () => { f.backend.target = "replacement-process-window"; };
    await assert.rejects(runtime.observe(), /identity-drift/);
    assert.equal(f.backend.acts, 0);
  } finally { await f.dispose(); }
});

test("shared InputControl gates Agent to Human takeover and requires fresh observation after resume", async () => {
  const f = fixture();
  try {
    const { session, authority, runtime } = await opened(f);
    const oldObservation = await runtime.observe();
    await runtime.runValidatedScenario();
    assert.equal(f.backend.acts, 1);
    const humanAuthority = await f.arbiter.transfer(authority, human);
    assert.equal(f.backend.current.owner, "human");
    assert.match(f.provider.viewerUrl(session, humanAuthority), /local-test-token/);
    await assert.rejects(runtime.runValidatedScenario(), /invalid-input-authority|runtime-closed/);
    f.arbiter.renewAuthority!(humanAuthority);
    const resumedAuthority = await f.arbiter.transfer(humanAuthority, agent);
    assert.equal(f.backend.current.owner, "agent");
    const resumed = f.provider.connectRuntime(session, resumedAuthority, join(f.root, "artifacts"));
    await assert.rejects(resumed.runValidatedScenario(), /fresh-observation/);
    await resumed.bind();
    assert.equal(f.backend.acts, 1);
    const newObservation = await resumed.observe();
    assert.equal(newObservation.capture?.sequence, (oldObservation.capture?.sequence ?? 0) + 1);
    await assert.rejects(resumed.runValidatedScenario(), /single-run-required/);
    assert.equal(f.backend.acts, 1);
  } finally { await f.dispose(); }
});

test("discover/open expose backend-bound identities, target narrowing and fail-closed admission", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.provider.discover(), [{ providerId: "windows-local-workspace",
      environmentId: "local-workspace:fixture", kind: "local-workspace" }]);
    const { session, runtime } = await opened(f);
    assert.equal(session.instanceId, f.backend.instance);
    assert.equal(session.providerId, "windows-local-workspace");
    assert.equal(Object.isFrozen(session), true);
    assert.match(session.inputResourceId!, /^local-workspace-input:/);
    const target = await runtime.bind();
    assert.equal(target.instanceId, session.instanceId);
    const provider = await f.provider.capabilities(), sessionCaps = await session.capabilities();
    const context = { providerId: session.providerId, environmentKind: "local-workspace" as const,
      application: "d0-synthetic-fixture", applicationVersion: "d0-synthetic-fixture-v1",
      targetRole: "owned-main-window", action: "run-validated-scenario", mechanism: "owned-hwnd-message" };
    const ready = { "input.targetedWindow": { state: "ready" as const } };
    const layers = { provider, session: sessionCaps, target: target.capabilities };
    assertDesktopCapabilities(["input.targetedWindow"], context, layers, { session: ready, target: ready });
    assert.throws(() => assertDesktopCapabilities(["input.targetedWindow"], { ...context, action: "viewer-click" },
      layers, { session: ready, target: ready }), /scope-mismatch/);
    for (const [application, expected] of [["arbitrary-app", "not-proven"], ["packaged-notepad", "unsupported"]]) {
      const caps = localWorkspaceTargetCapabilities(provider, application!, "unknown");
      assert.equal(caps["input.targetedWindow"]?.[0].state, expected);
      assert.equal(caps["input.globalInput"]?.[0].state, "forbidden");
      assert.throws(() => assertDesktopCapabilities(["input.targetedWindow"], { ...context, application: application!,
        applicationVersion: "unknown" }, { ...layers, target: caps }, { session: ready, target: ready }), /scope-mismatch/);
    }
    for (const capability of ["input.rawIsolated", "input.globalInput"] as const) {
      const mechanism = capability === "input.globalInput" ? "system-input" : "raw-hidden-desktop-input";
      assert.throws(() => assertDesktopCapabilities([capability], { ...context, mechanism }, layers,
        { session: ready, target: ready }), /not-proven|forbidden/);
    }
  } finally { await f.dispose(); }
});

test("fresh frames expire and old/replayed frame sequences cannot authorize input", async () => {
  const f = fixture();
  let clock = 0;
  const timer = mock.method(performance, "now", () => clock);
  try {
    const { runtime } = await opened(f);
    await runtime.observe(); clock = 2001;
    await assert.rejects(runtime.runValidatedScenario(), /fresh-observation/);
    assert.equal(f.backend.acts, 0);
    await runtime.observe();
    f.backend.sequence = 1;
    await assert.rejects(runtime.observe(), /frame-integrity/);
    assert.equal(f.backend.acts, 0);
  } finally { timer.mock.restore(); await f.dispose(); }
});

test("Viewer events share the resource arbiter and stale epochs cannot take authority", async () => {
  const f = fixture();
  try {
    const { session, authority } = await opened(f);
    const viewerHandler = f.backend.handler!;
    const second = await f.provider.open("local-workspace:fixture");
    await assert.rejects(f.arbiter.acquire(second, human), /input-resource-busy/);
    await viewerHandler({ event: "viewer_transfer", run_id: runId, epoch: f.backend.current.epoch, owner: "human", authority });
    assert.throws(() => f.arbiter.assertAuthority(session, authority), /invalid-input-authority/);
    await assert.rejects(viewerHandler({ event: "viewer_transfer", run_id: runId, epoch: 1, owner: "agent", authority }), /stale/);
    await viewerHandler({ event: "viewer_heartbeat", run_id: runId, epoch: f.backend.current.epoch, owner: "human", authority: f.backend.grant });
    assert.equal(await viewerHandler({ event: "viewer_input_authority", run_id: runId, epoch: f.backend.current.epoch, owner: "human", authority: f.backend.grant,
      targetId, context: { capability: "input.targetedWindow", action: "viewer-click",
        targetRole: "fixture-editor", mechanism: "owned-hwnd-message" } }), true);
    assert.deepEqual(f.arbiter.view(session), f.arbiter.view(second));
    await second.close();
  } finally { await f.dispose(); }
});

test("Root exposes dormant Local Workspace with no Task routing or native startup", async () => {
  const root = mkdtempSync(join(tmpdir(), "p4-root-"));
  try {
    const assembly = await createRootAssembly({ rootDir: root,
      model: { createModel() { throw new Error("no model execution"); } } });
    try {
      assert.deepEqual(assembly.environmentProviders.map(provider => provider.kind),
        ["virtual-machine", "physical", "local-workspace"]);
      const workspace = assembly.environmentProviders[2]!;
      assert.deepEqual(await workspace.discover(), []);
      await assert.rejects(workspace.open("local-workspace:fixture"), /unavailable/);
    } finally { await assembly.dispose(); }
    assert.throws(() => new LocalWorkspaceDesktopProvider(new ResourceInputControl(),
      { app: "netease", path: "synthetic", song: "other-song", artist: "孙燕姿" }, root, process.cwd()), /validated song/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Provider shutdown waits for pending startup and never returns a live late Session", async () => {
  const f = fixture();
  let release!: () => void, started!: () => void;
  const reachedStart = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = f.backend.start.bind(f.backend);
  f.backend.start = async config => { started(); await gate; return original(config); };
  try {
    const opening = f.provider.open("local-workspace:fixture");
    const rejected = assert.rejects(opening, /provider-closed/);
    await reachedStart;
    let closed = false;
    const closing = f.provider.close().then(() => { closed = true; });
    await Promise.resolve(); assert.equal(closed, false);
    release(); await rejected; await closing;
    assert.equal(f.backend.closeCalls, 1);
    assert.ok(f.backend.stopCalls > 0);
  } finally { release(); await f.dispose(); }
});

test("handoff revokes backend generation before awaiting pending observation drain", async () => {
  const f = fixture();
  let releaseFrame!: () => void;
  try {
    const { session, authority, runtime } = await opened(f);
    f.backend.frameGate = new Promise<void>(resolveFrame => { releaseFrame = resolveFrame; });
    const observing = runtime.observe();
    const transferring = f.arbiter.transfer(authority, human);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(f.backend.current.owner, "none");
    releaseFrame();
    await assert.rejects(observing, /transition-in-progress|runtime-closed/);
    const humanAuthority = await transferring;
    assert.equal(f.backend.current.owner, "human");
    assert.equal((await session.status()).state, "open");
    assert.equal(humanAuthority.owner.kind, "human");
  } finally { await f.dispose(); }
});

test("unconfirmed owner revoke and cleanup permanently block aliased input resources", async () => {
  const arbiter = new ResourceInputControl(() => 0);
  const first = fixture({ app: "fixture" }, arbiter), alias = fixture({ app: "fixture" }, arbiter);
  try {
    const { session, authority } = await opened(first);
    first.backend.failTransition = true;
    await assert.rejects(arbiter.transfer(authority, human), /Input resource drain failed/);
    const aliasSession = await alias.provider.open("local-workspace:fixture");
    await assert.rejects(arbiter.acquire(aliasSession, agent), /resource-drain-unconfirmed/);
    assert.equal(arbiter.view(aliasSession).state, "revoking");
    await assert.rejects(session.close(), /cleanup was not confirmed/);
  } finally { await first.dispose(); await alias.dispose(); }

  const cleanupArbiter = new ResourceInputControl(() => 0);
  const dirty = fixture({ app: "fixture" }, cleanupArbiter), cleanAlias = fixture({ app: "fixture" }, cleanupArbiter);
  try {
    const { session } = await opened(dirty);
    dirty.backend.failStop = true;
    await assert.rejects(session.close(), /cleanup was not confirmed/);
    const aliasSession = await cleanAlias.provider.open("local-workspace:fixture");
    await assert.rejects(cleanupArbiter.acquire(aliasSession, agent), /resource-drain-unconfirmed/);
  } finally { await dirty.dispose(); await cleanAlias.dispose(); }
});

test("D0 provider paths contain no system-input or default-desktop fallback calls", () => {
  const files = ["src/desktop-provider/local-workspace-provider.ts", "spikes/local-workspace/provider_worker.py",
    "spikes/local-workspace/host.py", "spikes/local-workspace/win32.py", "spikes/local-workspace/worker.py",
    "spikes/local-workspace/netease_worker.py", "spikes/local-workspace/input_engine.py"];
  const forbidden = /\b(?:SendInput|SetCursorPos|SwitchDesktop)\s*\(|\bPyAutoGUI\b|\bpyautogui\b/i;
  for (const file of files) assert.doesNotMatch(readFileSync(resolve(file), "utf8"), forbidden, file);
});


test("R1 same-kind successor receives a new backend epoch and old Viewer grant is denied", async () => {
  const f = fixture();
  try {
    const { session, authority, runtime } = await opened(f);
    const initialEpoch = f.backend.current.epoch!;
    await runtime.observe();
    const successor = await f.arbiter.transfer(authority, { ...agent, clientId: "agent-B" });
    assert.ok(f.backend.current.epoch! > initialEpoch);
    await assert.rejects(runtime.runValidatedScenario(), /runtime-closed|invalid-input-authority/);
    const next = f.provider.connectRuntime(session, successor, join(f.root, "artifacts"));
    await next.bind(); await next.observe(); await next.runValidatedScenario();
    assert.equal(f.backend.acts, 1);
    const a = await f.arbiter.transfer(successor, human), oldEpoch = f.backend.current.epoch!;
    const b = await f.arbiter.transfer(a, { ...human, clientId: "human-B" });
    const event = { event: "viewer_input_authority", run_id: runId, epoch: f.backend.current.epoch,
      owner: "human", targetId, context: { capability: "input.targetedWindow", action: "viewer-click",
        targetRole: "fixture-editor", mechanism: "owned-hwnd-message" } };
    await assert.rejects(f.backend.handler!({ ...event, epoch: oldEpoch, authority: a }), /stale/);
    await assert.rejects(f.backend.handler!({ ...event, authority: a }), /stale/);
    assert.equal(await f.backend.handler!({ ...event, authority: b }), true);
  } finally { await f.dispose(); }
});

test("R2 valid Human grant still requires Target scope and native readiness", async () => {
  for (const config of [{ app: "fixture" } as const,
    { app: "netease", path: "synthetic", song: "我怀念的", artist: "孙燕姿" } as const]) {
    const f = fixture(config);
    try {
      const { authority } = await opened(f);
      const humanAuthority = await f.arbiter.transfer(authority, human);
      const event = { event: "viewer_input_authority", run_id: runId, epoch: f.backend.current.epoch,
        owner: "human", authority: humanAuthority, targetId,
        context: { capability: "input.targetedWindow", action: "viewer-click",
          targetRole: config.app === "fixture" ? "fixture-editor" : "playback-button", mechanism: "owned-hwnd-message" } };
      assert.equal(await f.backend.handler!(event), true);
      const targetHook = f.provider as unknown as { targetCapabilities(caps: Awaited<ReturnType<typeof f.provider.capabilities>>): Awaited<ReturnType<typeof f.provider.capabilities>> };
      const original = targetHook.targetCapabilities.bind(f.provider);
      const narrowed = mock.method(targetHook, "targetCapabilities", (caps: Awaited<ReturnType<typeof f.provider.capabilities>>) => {
        const result = original(caps);
        return { ...result, "input.targetedWindow": result["input.targetedWindow"]!.filter(d => !d.scope.action?.includes("viewer-click")) };
      });
      await assert.rejects(f.backend.handler!(event), /target:.*scope-mismatch/);
      narrowed.mock.restore();
      assert.equal(await f.backend.handler!(event), true);
      if (config.app === "netease") {
        f.backend.current.input_ready = false;
        await assert.rejects(f.backend.handler!(event), /input-not-ready/);
      }
    } finally { await f.dispose(); }
  }
});

test("R3 async final confirmation cannot dispatch an expired observation", async () => {
  const f = fixture(); let clock = 0;
  const timer = mock.method(performance, "now", () => clock);
  try {
    const { runtime } = await opened(f); await runtime.observe();
    const original = f.backend.state.bind(f.backend);
    f.backend.state = async () => { await Promise.resolve(); clock = 2001; return original(); };
    await assert.rejects(runtime.runValidatedScenario(), /fresh-observation/);
    assert.equal(f.backend.acts, 0);
  } finally { timer.mock.restore(); await f.dispose(); }
});

test("R3 capture processing cannot renew the original frame TTL", async () => {
  const f = fixture(); let clock = 0;
  const timer = mock.method(performance, "now", () => clock);
  try {
    const { runtime } = await opened(f);
    f.backend.onFrame = () => { clock = 2001; };
    await assert.rejects(runtime.observe(), /fresh-observation/);
    assert.equal(f.backend.acts, 0);
  } finally { timer.mock.restore(); await f.dispose(); }
});

test("R5 every cleanup stage runs despite native or transport failure and resource remains blocked", async () => {
  for (const failure of ["failStop", "throwStop", "failClose"] as const) {
    const input = new ResourceInputControl(() => 0), f = fixture({ app: "fixture" }, input), alias = fixture({ app: "fixture" }, input);
    try {
      const { session, authority } = await opened(f);
      f.backend[failure] = true;
      await assert.rejects(session.close(), AggregateError);
      await assert.rejects(f.provider.close(), AggregateError);
      assert.ok(f.backend.stopCalls >= 1); assert.ok(f.backend.closeCalls >= 1);
      assert.throws(() => input.assertAuthority(session, authority), /invalid-input-authority|stale-session/);
      const other = await alias.provider.open("local-workspace:fixture");
      await assert.rejects(input.acquire(other, agent), /resource-drain-unconfirmed/);
    } finally { await f.dispose(); await alias.dispose(); }
  }
});


test("R1 late old-generation confirmation cannot stale the successor during immediate revoke", async () => {
  const f = fixture(); let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(done => { release = done; }), started = new Promise<void>(done => { reached = done; });
  try {
    const { session, authority, runtime } = await opened(f), original = f.backend.state.bind(f.backend);
    f.backend.state = async () => { reached(); await gate; return original(); };
    const observing = runtime.observe(); await started;
    const transfer = f.arbiter.transfer(authority, human);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(f.backend.current.owner, "none");
    f.backend.state = original; release();
    await assert.rejects(observing, /transition-in-progress|runtime-closed/);
    await transfer;
    assert.equal((await session.status()).state, "open");
  } finally { release(); await f.dispose(); }
});

test("R1 late rejected Agent heartbeat cannot invalidate the new Human generation", async () => {
  const f = fixture(); let reject!: (error: Error) => void, reached!: () => void;
  const started = new Promise<void>(done => { reached = done; });
  const gate = new Promise<void>((_, fail) => { reject = fail; });
  try {
    const { session, authority } = await opened(f);
    f.backend.ping = async () => { reached(); await gate; };
    await started;
    await f.arbiter.transfer(authority, human);
    reject(new Error("old backend grant revoked"));
    await Promise.resolve(); await Promise.resolve();
    assert.equal((await session.status()).state, "open");
    assert.equal(f.backend.current.owner, "human");
  } finally { await f.dispose(); }
});
