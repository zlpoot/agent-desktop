import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilityContext, CapabilityDeclaration, DesktopCapabilities, DesktopEnvironmentKind,
  DesktopProvider } from "../src/contracts/desktop-environment.js";
import { assertDesktopCapabilities } from "../src/desktop-provider/admission.js";
import { FakeDesktopBackend, FakeDesktopProvider } from "../src/desktop-provider/fake-provider.js";
import { FakeInputControl } from "../src/desktop-provider/fake-input-control.js";
import { capabilities, context, declaration, definition, fixture, ready, semantic } from "./fixtures/desktop-provider.js";

test("all environment families share discover/open/lifecycle without transport or app operations", async () => {
  for (const kind of ["physical", "virtual-machine", "local-workspace"] satisfies DesktopEnvironmentKind[]) {
    const f = await fixture({ kind });
    const provider: DesktopProvider = f.provider;
    assert.deepEqual(await provider.discover(), [{ providerId: "fake", environmentId: "fixture", kind }]);
    assert.equal((await f.session.status()).state, "open");
    assert.equal(f.runtime.execute(f.request).operationId, "edit");
    for (const name of ["click", "type", "launchApp", "takeControl", "resume", "attach", "workerEndpoint"]) {
      assert.equal(name in provider, false);
    }
    assert.equal("workerEndpoint" in f.session, false);
    assert.equal(Object.isFrozen(f.session), true);
    await assert.rejects(provider.open("unknown"), /unknown-environment/);
    await f.session.close(); await f.session.close();
    assert.equal((await f.session.status()).state, "closed");
    assert.throws(() => f.backend.execute(f.request), /stale-session/);
  }
});

test("all capability layers reject missing, unsupported, not-proven and forbidden declarations", () => {
  for (const layer of ["provider", "session", "target"] as const) {
    for (const state of ["unsupported", "not-proven", "forbidden", "missing"] as const) {
      const layers = { provider: capabilities(), session: capabilities(), target: capabilities() };
      layers[layer] = state === "missing" ? {} : capabilities(state);
      assert.throws(() => assertDesktopCapabilities([semantic], context, layers,
        { session: ready(), target: ready() }), new RegExp(`${layer}:input.semantic:${state}`));
    }
  }
});

test("each application/version/role/action/mechanism/environment/provider scope dimension is enforced", () => {
  const scope = Object.fromEntries(Object.entries(context).map(([key, value]) => [key, [value]]));
  const target = { [semantic]: [declaration("supported", scope)] };
  const layers = { provider: capabilities(), session: capabilities(), target };
  assertDesktopCapabilities([semantic], context, layers, { session: ready(), target: ready() });
  for (const key of Object.keys(context) as (keyof CapabilityContext)[]) {
    const mismatched = { ...context, [key]: "other" } as CapabilityContext;
    assert.throws(() => assertDesktopCapabilities([semantic], mismatched, layers,
      { session: ready(), target: ready() }), /scope-mismatch/);
  }
});

test("evidence and scope are required; contradictory declarations and empty executor requirements fail closed", () => {
  const malformed: CapabilityDeclaration[] = [
    { state: "supported", scope: {} },
    { state: "supported", scope: { action: [] } },
    { state: "supported", scope: { typo: ["edit"] } } as CapabilityDeclaration,
    { state: "supported", scope: { action: ["edit"] } },
    { state: "supported", scope: { action: ["edit"] }, evidence: [] },
    { state: "supported", scope: { action: ["edit"] }, evidence: [{ source: "", description: "fake" }] },
  ];
  for (const value of malformed) {
    assert.throws(() => assertDesktopCapabilities([semantic], context,
      { provider: capabilities(), session: capabilities(), target: { [semantic]: [value] } },
      { session: ready(), target: ready() }), /invalid-scope|missing-evidence/);
  }
  const conflicting = { [semantic]: [declaration(), declaration("forbidden")] };
  assert.throws(() => assertDesktopCapabilities([semantic], context,
    { provider: conflicting, session: capabilities(), target: capabilities() },
    { session: ready(), target: ready() }), /forbidden/);
  assert.throws(() => assertDesktopCapabilities([], context,
    { provider: capabilities(), session: capabilities(), target: capabilities() },
    { session: ready(), target: ready() }), /missing-requirements/);
});

test("same Fake App admits supported edit but never upgrades unproven drag", async () => {
  const f = await fixture();
  f.runtime.execute(f.request);
  assert.throws(() => f.runtime.execute({ ...f.request, operationId: "drag" }), /target:input.semantic:not-proven/);
  assert.throws(() => f.backend.execute({ ...f.request, operationId: "drag" }), /not-proven/);
  assert.equal(f.backend.executed().length, 1);
});

test("transient Session and Target readiness deny execution without rewriting support", async () => {
  for (const layer of ["session", "target"] as const) {
    const f = await fixture();
    for (const state of ["not-ready", "unknown", "missing"] as const) {
      const readiness = state === "missing" ? {} : ready(state);
      if (layer === "session") f.backend.setReadiness(readiness);
      else f.backend.setTargetReadiness("editor", readiness);
      assert.throws(() => f.backend.execute(f.request), new RegExp(`${layer}:input.semantic:not-ready`));
      assert.equal((await f.session.capabilities())[semantic]![0].state, "supported");
    }
    if (layer === "session") f.backend.setReadiness(ready());
    else f.backend.setTargetReadiness("editor", ready());
    f.runtime.execute(f.request);
  }
});

test("every backend executor requirement must pass, including a forbidden fallback", async () => {
  const config = definition();
  const input = new FakeInputControl(() => 0);
  const extra: DesktopCapabilities = {
    ...capabilities(), "input.globalInput": [declaration("forbidden")],
  };
  const backend = new FakeDesktopBackend({ ...config, capabilities: extra,
    operations: { edit: { mechanism: "fake-semantic", required: [semantic, "input.globalInput"] } } }, input);
  const provider = new FakeDesktopProvider("fake", "local-workspace", new Map([["fixture", backend]]), extra);
  const session = await provider.open("fixture");
  const target = backend.bind(session, "editor");
  const authority = await input.acquire(session, { kind: "agent", clientId: "task" });
  assert.throws(() => backend.execute({ observation: backend.observe(target), operationId: "edit", authority }), /forbidden/);
  assert.equal(backend.executed().length, 0);
});

test("discovery and capability snapshots cannot mutate backend gates", async () => {
  const f = await fixture();
  const snapshot = await f.session.capabilities();
  (snapshot as Record<string, unknown>)[semantic] = [declaration("forbidden")];
  const discovered = await f.provider.discover();
  discovered[0].environmentId = "changed";
  assert.equal((await f.provider.discover())[0].environmentId, "fixture");
  f.runtime.execute(f.request);
});
