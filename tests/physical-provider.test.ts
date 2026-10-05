import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PhysicalDesktopProvider, type PhysicalBackend } from "../src/desktop-provider/physical-provider.js";
import { ResourceInputControl } from "../src/desktop-provider/resource-input-control.js";
import { singleProvider } from "../src/actions/action-resolution.js";
import type { InputAuthority } from "../src/contracts/desktop-input-control.js";
import type { PhysicalInputPolicy } from "../src/runtime/desktop/desktop-runtime.js";
import { PhysicalWorkerTransportError } from "../src/runtime/desktop/desktop-runtime.js";
import { createRootAssembly } from "../src/composition/root.js";

const environment = "current-interactive-desktop";
const agent = { kind: "agent", clientId: "agent" } as const;
const human = { kind: "human", clientId: "viewer" } as const;
const action = { kind: "keypress", keys: "escape" } as const;
const resolution = singleProvider("windows.pyautogui.act", "synthetic available executor");
const policy: PhysicalInputPolicy = { windowManagement: true, executors: [resolution.selected] };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(input = new ResourceInputControl(() => 0), inputPolicy: PhysicalInputPolicy = policy) {
  const state = { instanceId: "worker-1", inputResourceId: "physical-input:synthetic", ready: true,
    grant: undefined as InputAuthority | undefined, installedInstance: "", failRevoke: false,
    foreground: true, permissions: true, effects: 0, factoryCalls: 0, observations: 0, closes: 0,
    candidates: [] as string[], hook: undefined as (() => Promise<void> | void) | undefined };
  const backend: PhysicalBackend = {
    async physicalHandshake() { return { instanceId: state.instanceId, inputResourceId: state.inputResourceId, ready: state.ready }; },
    async grantPhysical(authority) { state.grant = structuredClone(authority); state.installedInstance = state.instanceId; },
    async revokePhysical(authority) {
      if (state.failRevoke) throw new Error("synthetic revoke failure");
      if (state.grant && state.grant.grantId !== authority.grantId) throw new Error("foreign native grant");
      state.grant = undefined;
    },
    async bindPhysical() {},
    async windowsPhysical() { return []; },
    async observe() { state.observations++; return { windowHandle: 7, windowTitle: "Synthetic window", pageText: "fixture" }; },
    async probe() { return { windowClass: "Synthetic", foreground: state.foreground, elevated: false,
      targetElevated: false, permissionsCompatible: state.permissions, title: "Synthetic window", processId: 1,
      processPath: "synthetic", visible: true, minimized: false,
      rect: { left: 0, top: 0, width: 10, height: 10 }, uiaControls: true }; },
    async recoverFocus() { if (!state.foreground || !state.permissions) throw new Error("foreground/permission refused"); },
    async ground() { return { attempts: [] }; },
    async resolveAction() { return resolution; },
    async execute(_action, selected) {
      state.candidates = selected?.candidates.map(candidate => candidate.provider) ?? [];
      await state.hook?.();
      if (state.instanceId !== state.installedInstance) throw new Error("Physical Worker instance/resource changed");
      if (!state.grant || state.grant.owner.kind !== "agent") throw new Error("native authority refused");
      if (!state.foreground || !state.permissions) throw new Error("foreground/permission refused");
      state.effects++; return { ok: true, effect: "dispatched", message: "synthetic" };
    },
    async restore() {},
    async close() { state.closes++; },
  };
  const factory = async () => { state.factoryCalls++; return backend; };
  const provider = new PhysicalDesktopProvider(input, factory, inputPolicy, true);
  return { provider, input, state, factory, backend, async close() { try { await provider.close(); } catch { /* blocked fixtures asserted below */ } } };
}
async function bound(f: ReturnType<typeof fixture>) {
  const session = await f.provider.open(environment);
  const authority = await f.input.acquire(session, agent);
  const runtime = await f.provider.connectRuntime(session, authority, "synthetic-artifacts");
  await runtime.attach({ windowHandle: 7 }); const observation = await runtime.observe();
  return { session, authority, runtime, observation };
}

test("Physical discovery is lazy; Sessions share one Worker identity/resource and expose physical limits", async () => {
  const f = fixture();
  try {
    assert.equal((await f.provider.discover())[0]?.kind, "physical"); assert.equal(f.state.factoryCalls, 0);
    const a = await f.provider.open(environment), b = await f.provider.open(environment);
    assert.equal(f.state.factoryCalls, 1); assert.notEqual(a.sessionId, b.sessionId);
    assert.equal(a.instanceId, b.instanceId); assert.equal(a.inputResourceId, b.inputResourceId);
    const capabilities = await a.capabilities();
    assert.equal(capabilities["isolation.separateOs"]?.[0].state, "unsupported");
    assert.equal(capabilities["isolation.separateDesktop"]?.[0].state, "unsupported");
    assert.equal(capabilities["input.rawIsolated"]?.[0].state, "unsupported");
    assert.equal(capabilities["isolation.sharedUserSession"]?.[0].state, "supported");
    assert.equal(capabilities["input.globalInput"]?.[0].state, "not-proven");
    assert.equal((await a.status()).readiness["input.globalInput"]?.state, "unknown");
  } finally { await f.close(); }
});

test("default closed policy denies bind/focus and global input, with no OS mechanism fallback", async () => {
  const f = fixture(undefined, { windowManagement: false, executors: [] });
  try {
    const session = await f.provider.open(environment), authority = await f.input.acquire(session, agent);
    assert.equal((await session.capabilities())["input.globalInput"]?.[0].state, "forbidden");
    const runtime = await f.provider.connectRuntime(session, authority, "synthetic");
    await assert.rejects(runtime.attach({ windowHandle: 7 }), /window-management-forbidden/);
    await assert.rejects(runtime.recoverFocus(), /window-management-forbidden/);
    await assert.rejects(runtime.probe(true), /window-management-forbidden/); assert.equal(f.state.effects, 0);
  } finally { await f.close(); }
});

test("window-management permission alone cannot authorize any physical input executor", async () => {
  const f = fixture(undefined, { windowManagement: true, executors: [] });
  try {
    const { runtime } = await bound(f);
    await assert.rejects(runtime.execute(action, resolution), /global-input-forbidden/); assert.equal(f.state.effects, 0);
  } finally { await f.close(); }
});

test("current runtime runs through Provider; selected-only authorization and foreground/permissions stay enforced", async () => {
  const f = fixture();
  try {
    const { runtime } = await bound(f);
    f.state.foreground = false; await assert.rejects(runtime.execute(action, resolution), /foreground\/permission/);
    f.state.foreground = true; await runtime.observe(); f.state.permissions = false;
    await assert.rejects(runtime.execute(action, resolution), /foreground\/permission/);
    f.state.permissions = true; await runtime.observe();
    await runtime.execute(action, { ...resolution, candidates: [...resolution.candidates,
      { provider: "unapproved-fallback", available: true, reason: "never authorize" }] });
    assert.deepEqual(f.state.candidates, [resolution.selected]); assert.equal(f.state.effects, 1);
    await assert.rejects(runtime.execute(action, resolution), /rebind-and-observe-required/);
  } finally { await f.close(); }
});

test("resource ownership protects two Sessions; observer close does not revoke owner", async () => {
  const f = fixture();
  try {
    const { session, authority, runtime } = await bound(f), observer = await f.provider.open(environment);
    await assert.rejects(f.input.acquire(observer, agent), /input-resource-busy/);
    await observer.close(); f.input.assertAuthority(session, authority);
    await runtime.execute(action, resolution); assert.equal(f.state.effects, 1);
  } finally { await f.close(); }
});

test("Provider aliases injected with one resource arbiter cannot bypass ownership", async () => {
  const input = new ResourceInputControl(() => 0), a = fixture(input), b = fixture(input);
  try {
    const owner = await bound(a), other = await b.provider.open(environment);
    await assert.rejects(input.acquire(other, agent), /input-resource-busy/);
    await b.provider.close(); input.assertAuthority(owner.session, owner.authority);
    await owner.runtime.execute(action, resolution);
  } finally { await a.close(); await b.close(); }
});

test("managed Human takeover drains Agent, rejects old grant and requires new runtime bind/observe", async () => {
  const f = fixture();
  try {
    const { session, authority, runtime, observation } = await bound(f);
    const humanGrant = await f.input.transfer(authority, human);
    await assert.rejects(runtime.execute(action, resolution), /runtime-closed/);
    assert.throws(() => f.provider.connectRuntime(session, humanGrant, "synthetic"), /agent-authority-required/);
    const next = await f.input.transfer(humanGrant, agent);
    assert.throws(() => f.input.assertAuthority(session, authority), /invalid-input-authority/);
    const resumed = await f.provider.connectRuntime(session, next, "synthetic");
    await assert.rejects(resumed.restore(observation), /stale-physical-observation/);
    await assert.rejects(resumed.execute(action, resolution), /rebind-and-observe-required/);
    await resumed.attach({ windowHandle: 7 }); await resumed.observe(); await resumed.execute(action, resolution);
  } finally { await f.close(); }
});

test("instance/resource replacement is terminal even if the original identity returns", async () => {
  for (const field of ["instanceId", "inputResourceId"] as const) {
    const f = fixture();
    try {
      const { session, runtime } = await bound(f); const previous = f.state[field]; f.state[field] = "replacement";
      assert.equal((await session.status()).state, "stale"); f.state[field] = previous;
      assert.equal((await session.status()).state, "stale");
      await assert.rejects(runtime.observe(), /runtime-closed|stale-session/);
      assert.throws(() => f.provider.connectRuntime(session, {} as InputAuthority, "synthetic"), /stale-session/);
    } finally { await f.close(); }
  }
});

test("backend independently refuses instance changed between Host check and dispatch", async () => {
  const f = fixture();
  try {
    const { session, runtime } = await bound(f);
    f.state.hook = () => { f.state.instanceId = "changed-at-dispatch"; };
    await assert.rejects(runtime.execute(action, resolution), /instance\/resource changed/);
    assert.equal((await session.status()).state, "stale"); assert.equal(f.state.effects, 0);
  } finally { await f.close(); }
});

test("not-ready can recover observation readiness but does not authorize input while blocked", async () => {
  const f = fixture();
  try {
    const { session, runtime } = await bound(f); f.state.ready = false;
    await assert.rejects(runtime.execute(action, resolution), /physical-not-ready/);
    assert.equal((await session.status()).state, "open");
    assert.equal((await session.status()).readiness["observation.pixels"]?.state, "not-ready");
    f.state.ready = true; await runtime.observe(); await runtime.execute(action, resolution);
  } finally { await f.close(); }
});

test("transfer cancels queued work and waits in-flight effect before new authority ACK", async () => {
  const f = fixture(), started = deferred(), release = deferred();
  try {
    const { authority, runtime } = await bound(f);
    f.state.hook = async () => { started.resolve(); await release.promise; };
    const inFlight = runtime.execute(action, resolution); await started.promise;
    const queued = assert.rejects(runtime.observe(), /runtime-closed/);
    let acknowledged = false;
    const transfer = f.input.transfer(authority, human).then(value => { acknowledged = true; return value; });
    await new Promise<void>(done => setImmediate(done)); assert.equal(acknowledged, false);
    release.resolve(); await inFlight; await queued; await transfer;
    assert.equal(f.state.effects, 1); assert.equal(f.state.observations, 1);
  } finally { release.resolve(); await f.close(); }
});

test("expired grant is refused at dispatch; lifecycle close still forces revoke", async () => {
  let now = 0; const f = fixture(new ResourceInputControl(() => now, 100));
  try {
    const { session, runtime } = await bound(f); now = 101;
    await assert.rejects(runtime.execute(action, resolution), /invalid-input-authority/);
    await session.close(); assert.equal(f.state.grant, undefined); assert.equal(f.state.effects, 0);
  } finally { await f.close(); }
});

test("failed native revoke permanently blocks subsequent grants including expiry and Session close", async () => {
  let now = 0; const f = fixture(new ResourceInputControl(() => now, 100));
  try {
    const { session, authority } = await bound(f), other = await f.provider.open(environment);
    f.state.failRevoke = true; await assert.rejects(f.input.release(authority), /drain failed/);
    f.state.failRevoke = false; now = 1000;
    await assert.rejects(session.close(), /resource-drain-unconfirmed/);
    await assert.rejects(f.input.acquire(other, agent), /resource-drain-unconfirmed/);
  } finally { await f.close(); }
});

test("unsupported platform never starts backend; root registers dormant Physical without changing Task route", async () => {
  const f = fixture();
  const unavailable = new PhysicalDesktopProvider(new ResourceInputControl(), f.factory, policy, false);
  const dir = mkdtempSync(join(tmpdir(), "physical-root-"));
  try {
    assert.deepEqual(await unavailable.discover(), []);
    await assert.rejects(unavailable.open(environment), /physical-unavailable/); assert.equal(f.state.factoryCalls, 0);
    const root = await createRootAssembly({ rootDir: dir, physicalBackendFactory: f.factory, physicalInputPolicy: policy,
      model: { createModel() { throw new Error("no model"); } } });
    try {
      const common = root.environmentProviders.find(provider => provider.kind === "physical")!;
      assert.ok(common); assert.equal(f.state.factoryCalls, 0);
      const session = await common.open(environment);
      const authority = await root.root.physicalCompatibility.inputControl.acquire(session, agent);
      const runtime = await root.root.physicalCompatibility.connectRuntime(session, authority, dir);
      await runtime.attach({ windowHandle: 7 }); await runtime.observe(); await runtime.execute(action, resolution);
    } finally { await root.dispose(); }
    assert.equal(f.state.closes, 1);
  } finally { await f.close(); await unavailable.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("initial not-ready handshake retains identity and can be opened after readiness recovers", async () => {
  const f = fixture();
  try {
    f.state.ready = false; await assert.rejects(f.provider.open(environment), /physical-not-ready/);
    f.state.ready = true; const session = await f.provider.open(environment);
    assert.equal(session.instanceId, "worker-1"); assert.equal(f.state.factoryCalls, 1);
  } finally { await f.close(); }
});

test("new open observing backend identity failure also permanently invalidates established Sessions", async () => {
  const f = fixture();
  try {
    const session = await f.provider.open(environment), original = f.backend.physicalHandshake;
    f.backend.physicalHandshake = async () => { throw new Error("Physical Worker instance/resource changed"); };
    await assert.rejects(f.provider.open(environment), /instance\/resource changed/);
    f.backend.physicalHandshake = original; assert.equal((await session.status()).state, "stale");
  } finally { await f.close(); }
});

test("Provider shutdown is idempotent and closes one shared backend once", async () => {
  const f = fixture();
  const session = await f.provider.open(environment);
  await Promise.all([f.provider.close(), f.provider.close()]);
  assert.equal(f.state.closes, 1); assert.equal((await session.status()).state, "closed");
  await f.provider.close(); assert.equal(f.state.closes, 1);
});

test("unconfirmed transport during dispatch immediately stales Session and drains old runtime", async () => {
  const f = fixture();
  try {
    const { session, runtime } = await bound(f);
    f.state.hook = () => { throw new PhysicalWorkerTransportError("synthetic lost transport"); };
    await assert.rejects(runtime.execute(action, resolution), /lost transport/);
    assert.throws(() => f.provider.connectRuntime(session, {} as InputAuthority, "synthetic"), /stale-session/);
    await assert.rejects(runtime.observe(), /runtime-closed|stale-session/);
    assert.equal((await session.status()).state, "stale"); assert.equal(f.state.effects, 0);
  } finally { await f.close(); }
});
