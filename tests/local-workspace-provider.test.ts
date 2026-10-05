import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { LocalWorkspaceDesktopProvider, type LocalWorkspaceBackend, type LocalWorkspaceAppConfig,
  type LocalWorkspaceConnection, type LocalWorkspaceFrame, type LocalWorkspaceState } from "../src/desktop-provider/local-workspace-provider.js";
import { ResourceInputControl } from "../src/desktop-provider/resource-input-control.js";
import type { InputAuthority } from "../src/contracts/desktop-input-control.js";

const agent = { kind: "agent", clientId: "p4-agent" } as const;
const human = { kind: "human", clientId: "p4-viewer" } as const;
const validPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const runId = "p4-run-1", desktopName = "AgentD0_p4-run-1", targetId = "p4-target-pid-hwnd-session-desktop";

function state(overrides: Partial<LocalWorkspaceState> = {}): LocalWorkspaceState {
  return { status: "ready", app: "fixture", run_id: runId, owner: "agent", epoch: 1, control_ready: true,
    desktop: desktopName, app_version: undefined, cleanup: undefined, ...overrides };
}
function frame(bytes = validPng): LocalWorkspaceFrame {
  return { png: bytes.toString("base64"), metadata: { sequence: 1, width: 1, height: 1,
    sha256: createHash("sha256").update(bytes).digest("hex"), heartbeat: 1 }, uia: [] };
}
class FakeWorkspace implements LocalWorkspaceBackend {
  current = state();
  target = targetId;
  windowsSession = 7;
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
      viewerToken: "local-test-token", windowsSessionId: this.windowsSession };
  }
  async state() { return { state: structuredClone(this.current), targetId: this.target, windowsSessionId: this.windowsSession }; }
  async setOwner(_id: string, owner: "agent" | "human") {
    if (this.failTransition) throw new Error("unconfirmed D0 owner transition");
    if (this.current.owner !== owner) this.current = { ...this.current, owner, epoch: (this.current.epoch ?? 0) + 1 };
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
    this.stopCalls++;
    return { ...this.current, status: "stopped", cleanup: this.failStop ?
      { status: "FAIL", job_active: 1, desktop_absent: false } :
      { status: "PASS", job_active: 0, desktop_absent: true } };
  }
  viewerUrl() { return "http://127.0.0.1:19101/#local-test-token"; }
  setEventHandler(handler: (event: Record<string, unknown>) => Promise<unknown>) { this.handler = handler; }
  async close() { this.closeCalls++; }
}
function fixture(config: LocalWorkspaceAppConfig = { app: "fixture" }, arbiter = new ResourceInputControl(() => 0)) {
  const root = mkdtempSync(join(tmpdir(), "local-workspace-p4-"));
  const backend = new FakeWorkspace();
  if (config.app === "netease") backend.current = state({ app: "netease", app_version: "3.1.40.205461" });
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
  return { session, authority, runtime };
}

test("capabilities remain exact-app scoped and preserve D0 historical boundaries", async () => {
  const fixtureProvider = fixture();
  const neteaseProvider = fixture({ app: "netease", path: "C:\\validated\\cloudmusic.exe", song: "title", artist: "artist" });
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
  for (const drift of ["target", "desktop", "process", "instance", "epoch", "owner"] as const) {
    const f = fixture();
    try {
      const { session, runtime } = await opened(f);
      await runtime.observe();
      if (drift === "target" || drift === "process") f.backend.target = "replacement-target-pid-hwnd";
      if (drift === "desktop") f.backend.current = { ...f.backend.current, desktop: "AgentD0_replacement" };
      if (drift === "instance") f.backend.current = { ...f.backend.current, run_id: "replacement-run" };
      if (drift === "epoch") f.backend.current = { ...f.backend.current, epoch: 2 };
      if (drift === "owner") f.backend.current = { ...f.backend.current, owner: "human" };
      assert.equal((await session.status()).state, "stale", drift);
      // Reverting the backend must not revive a Session, its runtime, or its old observation.
      f.backend.current = state(); f.backend.target = targetId;
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
    assert.equal(f.backend.acts, 1);
    const newObservation = await resumed.observe();
    assert.equal(newObservation.capture?.sequence, (oldObservation.capture?.sequence ?? 0) + 1);
    await assert.rejects(resumed.runValidatedScenario(), /single-run-required/);
    assert.equal(f.backend.acts, 1);
  } finally { await f.dispose(); }
});

test("handoff drains a pending observation before changing the backend owner epoch", async () => {
  const f = fixture();
  let releaseFrame!: () => void;
  try {
    const { session, authority, runtime } = await opened(f);
    f.backend.frameGate = new Promise<void>(resolveFrame => { releaseFrame = resolveFrame; });
    const observing = runtime.observe();
    const transferring = f.arbiter.transfer(authority, human);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(f.backend.current.owner, "agent");
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
