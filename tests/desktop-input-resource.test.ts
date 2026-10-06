import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopInputArbiter } from "../src/contracts/desktop-input-control.js";
import { FakeDesktopBackend, FakeDesktopProvider, FakeDesktopRuntime } from "../src/desktop-provider/fake-provider.js";
import { FakeInputControl } from "../src/desktop-provider/fake-input-control.js";
import { capabilities, definition, fixture } from "./fixtures/desktop-provider.js";
import { ResourceInputControl } from "../src/desktop-provider/resource-input-control.js";

test("two Sessions contend for one resource; release ACK permits the next owner and rejects old grants", async () => {
  const f = await fixture();
  const second = await f.provider.open("fixture");
  assert.notEqual(second.sessionId, f.session.sessionId);
  assert.equal(second.instanceId, f.session.instanceId);
  assert.equal(second.inputResourceId, f.session.inputResourceId);
  await assert.rejects(f.input.acquire(second, { kind: "agent", clientId: "task-2" }), /input-resource-busy/);
  const queued = f.backend.queue(f.request);
  await f.input.release(f.authority);
  await assert.rejects(queued.result, /input-revoked/);
  const next = await f.input.acquire(second, { kind: "agent", clientId: "task-2" });
  assert.ok(next.epoch > f.authority.epoch);
  assert.throws(() => f.input.assertAuthority(f.session, f.authority), /invalid-input-authority/);
  assert.throws(() => f.input.assertAuthority(second, { ...next, grantId: f.authority.grantId }), /invalid-input-authority/);
  const runtime = new FakeDesktopRuntime(second, f.backend);
  runtime.execute({ observation: runtime.observe(runtime.bind("editor")), operationId: "edit", authority: next });
});

test("resource arbitration also covers aliases in different Providers/backends", async () => {
  const input = new FakeInputControl(() => 0);
  const f = await fixture({ input });
  const otherBackend = new FakeDesktopBackend(definition(), input);
  const other = new FakeDesktopProvider("other", "physical", new Map([["alias", otherBackend]]), capabilities());
  const otherSession = await other.open("alias");
  await assert.rejects(input.acquire(otherSession, { kind: "human", clientId: "viewer" }), /input-resource-busy/);
  await f.session.close();
  const authority = await input.acquire(otherSession, { kind: "human", clientId: "viewer" });
  input.assertAuthority(otherSession, authority);
});

test("multiple Viewer clients observe the same arbiter and cannot obtain independent authority", async () => {
  const f = await fixture();
  await f.input.release(f.authority);
  const second = await f.provider.open("fixture");
  const viewers = [
    { session: f.session, owner: { kind: "human" as const, clientId: "viewer-1" } },
    { session: second, owner: { kind: "human" as const, clientId: "viewer-2" } },
  ];
  const attempts = await Promise.allSettled(viewers.map(viewer => f.input.acquire(viewer.session, viewer.owner)));
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  const first = attempts[0]; assert.equal(first.status, "fulfilled");
  if (first.status !== "fulfilled") throw new Error("Expected first Viewer grant");
  assert.deepEqual(f.input.view(f.session), f.input.view(second));
  assert.equal("grantId" in f.input.view(second), false);
  assert.throws(() => f.input.assertAuthority(second, first.value), /invalid-input-authority/);
  // Disconnecting an observer must not revoke the active controller.
  await second.close(); f.input.assertAuthority(f.session, first.value);
  await f.session.close();
  assert.throws(() => f.backend.execute({ ...f.request, authority: first.value }), /stale-session/);
});

test("Agent -> Human -> Agent transfers reject both old epochs and drain before ACK", async () => {
  const f = await fixture();
  const pending = f.backend.queue(f.request);
  const human = await f.input.transfer(f.authority, { kind: "human", clientId: "viewer" });
  await assert.rejects(pending.result, /input-revoked/);
  assert.throws(() => f.backend.execute(f.request), /invalid-input-authority/);
  f.runtime.execute({ ...f.request, authority: human });
  const agent = await f.input.transfer(human, { kind: "agent", clientId: "task-1" });
  assert.ok(agent.epoch > human.epoch && human.epoch > f.authority.epoch);
  assert.throws(() => f.backend.execute({ ...f.request, authority: human }), /invalid-input-authority/);
  f.runtime.execute({ ...f.request, authority: agent });
});

test("no input executes during an outstanding drain; another Session cannot overtake transfer", async () => {
  const f = await fixture();
  const second = await f.provider.open("fixture");
  let signalDrain!: () => void; let finishDrain!: () => void;
  const draining = new Promise<void>(resolve => { signalDrain = resolve; });
  const gate = new Promise<void>(resolve => { finishDrain = resolve; });
  f.input.registerBackend(() => false, async () => { signalDrain(); await gate; });
  const transfer = f.input.transfer(f.authority, { kind: "human", clientId: "viewer" });
  await draining;
  assert.equal(f.input.view(f.session).state, "revoking");
  assert.throws(() => f.backend.execute(f.request), /invalid-input-authority/);
  const contender = f.input.acquire(second, { kind: "agent", clientId: "other" });
  const rejected = assert.rejects(contender, /input-resource-busy/);
  finishDrain();
  const human = await transfer; await rejected;
  f.input.assertAuthority(f.session, human);
});

test("a failed drain leaves the resource blocked rather than issuing a success ACK", async () => {
  const f = await fixture();
  f.input.registerBackend(() => false, async () => { throw new Error("drain failed"); });
  await assert.rejects(f.input.transfer(f.authority, { kind: "human", clientId: "viewer" }), /drain failed/);
  assert.throws(() => f.backend.execute(f.request), /invalid-input-authority/);
  const second = await f.provider.open("fixture");
  await assert.rejects(f.input.acquire(second, { kind: "agent", clientId: "other" }), /resource-drain-unconfirmed/);
});

test("an early drain failure still cancels backend queues and never unlocks on expiry or close", async () => {
  let now = 0;
  const input = new FakeInputControl(() => now, 100);
  // Register the failing participant BEFORE the backend registers its queue cancellation.
  const failure = new Error("early drain failed");
  input.registerBackend(() => false, async () => { throw failure; });
  const f = await fixture({ input });
  let tailDrained = false;
  input.registerBackend(() => false, async () => { tailDrained = true; });
  const pending = f.backend.queue(f.request);
  await assert.rejects(input.transfer(f.authority, { kind: "human", clientId: "viewer" }),
    (error: unknown) => error instanceof AggregateError && error.errors.includes(failure));
  await assert.rejects(pending.result, /input-revoked/);
  assert.equal(tailDrained, true);
  assert.equal(input.view(f.session).state, "revoking");
  assert.throws(() => f.backend.execute(f.request), /invalid-input-authority/);
  assert.throws(() => f.backend.dispatch(pending.actionId), /unknown-or-cancelled-action/);
  now = 200;
  const other = await f.provider.open("fixture");
  await assert.rejects(input.acquire(other, { kind: "agent", clientId: "other" }), /resource-drain-unconfirmed/);
  await assert.rejects(f.session.close(), /resource-drain-unconfirmed/);
  await assert.rejects(f.session.close(), /resource-drain-unconfirmed/);
  await assert.rejects(input.acquire(other, { kind: "agent", clientId: "other" }), /resource-drain-unconfirmed/);
  assert.equal(input.view(other).state, "revoking");
  assert.equal(f.backend.executed().length, 0);
});

test("interface-only lifecycle arbitration can revoke expired grants on close and instance replacement", async () => {
  for (const lifecycle of ["close", "replace"] as const) {
    let now = 0; let forcedRevocations = 0;
    const input = new FakeInputControl(() => now, 100);
    // Exposes only the public arbiter contract, not FakeInputControl.view or its concrete class.
    const arbiter: DesktopInputArbiter = {
      acquire: (binding, owner) => input.acquire(binding, owner),
      transfer: (authority, owner) => input.transfer(authority, owner),
      release: authority => input.release(authority),
      assertAuthority: (binding, authority) => input.assertAuthority(binding, authority),
      registerBackend: (validate, drain) => input.registerBackend(validate, drain),
      revokeSession: binding => { forcedRevocations++; return input.revokeSession(binding); },
      blockResource: binding => input.blockResource(binding),
    };
    const backend = new FakeDesktopBackend(definition(), arbiter);
    const provider = new FakeDesktopProvider("fake", "local-workspace", new Map([["fixture", backend]]), capabilities());
    const session = await provider.open("fixture");
    const observation = backend.observe(backend.bind(session, "editor"));
    const authority = await arbiter.acquire(session, { kind: "agent", clientId: "task" });
    const pending = backend.queue({ observation, authority, operationId: "edit" });
    now = 100;
    await assert.rejects(arbiter.release(authority), /invalid-input-authority/);
    if (lifecycle === "close") await session.close();
    else await backend.replaceInstance();
    await assert.rejects(pending.result, /session-closed|instance-replaced/);
    assert.equal(forcedRevocations, 1);
    const replacement = await provider.open("fixture");
    const next = await arbiter.acquire(replacement, { kind: "agent", clientId: "next" });
    assert.ok(next.epoch > authority.epoch);
    arbiter.assertAuthority(replacement, next);
    assert.throws(() => backend.execute({ observation, authority, operationId: "edit" }), /stale-session/);
  }
});

test("lease expiration rejects input and queued actions; reacquisition drains without resetting authority", async () => {
  let now = 10;
  const f = await fixture({ input: new FakeInputControl(() => now, 100) });
  const expired = f.backend.queue(f.request);
  const drained = f.backend.queue(f.request);
  now = 110;
  assert.equal(f.input.view(f.session).state, "expired");
  assert.throws(() => f.backend.execute(f.request), /invalid-input-authority/);
  f.backend.dispatch(expired.actionId);
  await assert.rejects(expired.result, /invalid-input-authority/);
  const second = await f.provider.open("fixture");
  const next = await f.input.acquire(second, { kind: "agent", clientId: "next" });
  await assert.rejects(drained.result, /input-revoked/);
  assert.ok(next.epoch > f.authority.epoch);
  assert.equal(f.backend.executed().length, 0);
});

test("closing one Session does not destroy another input resource", async () => {
  const input = new FakeInputControl(() => 0);
  const first = await fixture({ input });
  const second = await fixture({ input, definition: { ...definition(), inputResourceId: "second-input" } });
  await first.session.close();
  second.input.assertAuthority(second.session, second.authority);
  second.runtime.execute(second.request);
});

test("closed Session or terminal block during backend activation cannot receive a late grant ACK", async () => {
  for (const failure of ["closed", "blocked"] as const) {
    const input = new ResourceInputControl(() => 0);
    const identity = { providerId: "test", environmentId: "test", sessionId: "s", instanceId: "i", inputResourceId: "r" };
    let live = true, entered!: () => void, finish!: () => void, drains = 0;
    const activated = new Promise<void>(done => { entered = done; });
    const gate = new Promise<void>(done => { finish = done; });
    input.registerBackend(() => live, async () => { drains++; }, async () => { entered(); await gate; });
    const acquiring = input.acquire(identity, { kind: "agent", clientId: "a" });
    await activated;
    if (failure === "closed") live = false;
    else input.blockResource(identity);
    finish();
    await assert.rejects(acquiring, /activation unconfirmed/);
    live = true;
    await assert.rejects(input.acquire(identity, { kind: "agent", clientId: "b" }), /resource-drain-unconfirmed/);
    assert.equal(drains, 1);
  }
});

test("terminal block during drain is not cleared by a late successful revoke ACK", async () => {
  const input = new ResourceInputControl(() => 0);
  const identity = { providerId: "test", environmentId: "test", sessionId: "s", instanceId: "i", inputResourceId: "r" };
  let entered!: () => void, finish!: () => void;
  const draining = new Promise<void>(done => { entered = done; });
  const gate = new Promise<void>(done => { finish = done; });
  input.registerBackend(() => true, async () => { entered(); await gate; });
  const authority = await input.acquire(identity, { kind: "agent", clientId: "a" });
  const releasing = input.release(authority); await draining;
  input.blockResource(identity); finish();
  await assert.rejects(releasing, /resource-drain-unconfirmed/);
  await assert.rejects(input.acquire(identity, { kind: "agent", clientId: "b" }), /resource-drain-unconfirmed/);
});
