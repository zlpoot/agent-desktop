import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopObservationBinding } from "../src/contracts/desktop-environment.js";
import { FakeDesktopBackend, FakeDesktopProvider, FakeDesktopRuntime } from "../src/desktop-provider/fake-provider.js";
import { FakeInputControl } from "../src/desktop-provider/fake-input-control.js";
import { capabilities, definition, fixture, ready } from "./fixtures/desktop-provider.js";

test("backend replacement makes old Sessions stale, cancels pending actions and rejects backend bypass", async () => {
  const f = await fixture();
  const pending = f.backend.queue(f.request);
  const replacement = f.backend.replaceInstance();
  // This rejection happens before replacement's asynchronous revoke ACK.
  assert.throws(() => f.backend.execute(f.request), /stale-session/);
  await replacement;
  await assert.rejects(pending.result, /instance-replaced/);
  assert.equal((await f.session.status()).state, "stale");
  assert.throws(() => f.runtime.execute(f.request), /stale-session/);
  assert.throws(() => f.backend.dispatch(pending.actionId), /unknown-or-cancelled-action/);
  assert.throws(() => f.backend.observe(f.target), /stale-session/);
  assert.throws(() => f.input.assertAuthority(f.session, f.authority), /stale-session/);
  await assert.rejects(f.session.capabilities(), /stale-session/);
  assert.equal(f.backend.executed().length, 0);
  assert.equal(f.session.instanceId, f.authority.instanceId);
});

test("replacement opens a new Session/instance and requires explicit rebind + observation", async () => {
  const f = await fixture();
  await f.backend.replaceInstance();
  const session = await f.provider.open("fixture");
  assert.notEqual(session.sessionId, f.session.sessionId);
  assert.notEqual(session.instanceId, f.session.instanceId);
  const runtime = new FakeDesktopRuntime(session, f.backend);
  const authority = await f.input.acquire(session, { kind: "agent", clientId: "task-1" });
  assert.throws(() => runtime.observe(f.target), /foreign-session/);
  const forged = { ...f.observation, ...session };
  assert.throws(() => f.backend.execute({ observation: forged, operationId: "edit", authority }), /invalid-target/);
  const target = runtime.bind("editor");
  const unobserved: DesktopObservationBinding = { ...target, observationId: "old-or-invented-frame" };
  assert.throws(() => f.backend.execute({ observation: unobserved, operationId: "edit", authority }), /reobserve-required/);
  const observation = runtime.observe(target);
  runtime.execute({ observation, operationId: "edit", authority });
  // Closing an old handle cannot revoke replacement authority.
  await f.session.close(); f.input.assertAuthority(session, authority);
});

test("backend does not trust a Host-supplied instance or Session identity", async () => {
  const f = await fixture();
  for (const field of ["providerId", "environmentId", "sessionId", "instanceId", "inputResourceId"] as const) {
    const observation = { ...f.observation, [field]: "other" };
    assert.throws(() => f.backend.execute({ ...f.request, observation }), /stale-session/);
  }
  assert.throws(() => f.backend.execute({ ...f.request, authority: { ...f.authority, epoch: f.authority.epoch + 1 } }),
    /invalid-input-authority/);
  assert.equal(f.backend.executed().length, 0);
});

test("dispatch rechecks current readiness/observation and never trusts admission at queue time", async () => {
  const f = await fixture();
  const queued = f.backend.queue(f.request);
  f.backend.setReadiness(ready("not-ready"));
  f.backend.dispatch(queued.actionId);
  await assert.rejects(queued.result, /not-ready/);
  f.backend.setReadiness(ready());
  const staleFrame = f.backend.queue(f.request);
  const newFrame = f.runtime.observe(f.target);
  f.backend.dispatch(staleFrame.actionId);
  await assert.rejects(staleFrame.result, /reobserve-required/);
  const successful = f.backend.queue({ ...f.request, observation: newFrame });
  f.backend.dispatch(successful.actionId);
  assert.equal((await successful.result).operationId, "edit");
  assert.equal(f.backend.executed().length, 1);
});

test("closing cancels queued actions and stale/unknown targets never fall back to another environment", async () => {
  const f = await fixture();
  const queued = f.backend.queue(f.request);
  assert.throws(() => f.runtime.bind("unlisted-app"), /unknown-target/);
  await f.session.close();
  await assert.rejects(queued.result, /session-closed/);
  assert.throws(() => f.backend.execute(f.request), /stale-session/);
  assert.throws(() => f.backend.queue(f.request), /stale-session/);
  assert.equal(f.backend.executed().length, 0);
});

test("observation-only Sessions cannot acquire input authority", async () => {
  const input = new FakeInputControl(() => 0);
  const backend = new FakeDesktopBackend({ ...definition(), inputResourceId: null }, input);
  const provider = new FakeDesktopProvider("fake", "physical", new Map([["observer", backend]]), capabilities());
  const session = await provider.open("observer");
  assert.equal(session.inputResourceId, null);
  backend.observe(backend.bind(session, "editor"));
  await assert.rejects(input.acquire(session, { kind: "human", clientId: "viewer" }), /observation-only/);
});
