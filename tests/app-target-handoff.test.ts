import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appTaskBridgeFixture } from './fixtures/app-task-bridge.js';
import { ControlledAppLauncher } from '../src/environment-apps/launcher.js';
import { installAppAdmissionGate } from '../src/environment-apps/admission-gate.js';

test('opaque handoff binds the original Registry and exact Task Session object; serialization carries no proof', async () => {
  const f = await appTaskBridgeFixture(), other = await appTaskBridgeFixture();
  try {
    const issuer = f.service.launcher as ControlledAppLauncher;
    const handle = await issuer.handoffIssuedTarget(f.service.registry, f.profile, f.outcome.target!, f.session);
    issuer.assertIssuedTargetHandoff(handle, f.session);
    assert.equal(JSON.stringify(handle), '{}'); assert.deepEqual(Object.keys(handle), []);
    assert.equal(Object.isFrozen(handle), true);
    assert.throws(() => issuer.assertIssuedTargetHandoff(structuredClone(handle), f.session), /handoff-unavailable/);
    assert.throws(() => (other.service.launcher as ControlledAppLauncher).assertIssuedTargetHandoff(handle, f.session), /handoff-unavailable/);
    await assert.rejects(issuer.handoffIssuedTarget(f.service.registry, f.profile, f.outcome.target!, f.session), /unavailable-or-consumed/);
    // Equal Session strings do not establish original object/lifecycle ownership.
    assert.throws(() => issuer.assertIssuedTargetHandoff(handle, { ...f.session }), /session-mismatch/);
    assert.throws(() => issuer.assertIssuedTargetHandoff(handle, f.session), /handoff-unavailable/);
    assert.equal(f.counters.starts, 0); assert.equal(f.counters.cleanups, 0);
    assert.equal('appTrustFence' in f.bridge, false);
  } finally { await f.close(); await other.close(); }
});

test('a separately hooked identical Registry facade cannot replace the launch authorization source', async () => {
  const f = await appTaskBridgeFixture();
  try {
    const issuer = f.service.launcher as ControlledAppLauncher;
    const copy = { ...f.service.registry };
    installAppAdmissionGate(copy, () => {});
    await assert.rejects(issuer.handoffIssuedTarget(copy, f.profile, f.outcome.target!, f.session), /unavailable-or-consumed/);
    const handle = await issuer.handoffIssuedTarget(f.service.registry, f.profile, f.outcome.target!, f.session);
    issuer.assertIssuedTargetHandoff(handle, f.session);
  } finally { await f.close(); }
});

test('two concurrent handoffs cannot consume one issuance while Task status is blocked', async () => {
  const f = await appTaskBridgeFixture(); let release!: () => void;
  try {
    let entered!: () => void; const arrived = new Promise<void>(done => { entered = done; });
    f.hooks.status = async () => { entered(); await new Promise<void>(done => { release = done; }); return { state: 'open', readiness: {} }; };
    const issuer = f.service.launcher as ControlledAppLauncher;
    const first = issuer.handoffIssuedTarget(f.service.registry, f.profile, f.outcome.target!, f.session);
    await arrived;
    await assert.rejects(issuer.handoffIssuedTarget(f.service.registry, f.profile, f.outcome.target!, f.session), /unavailable-or-consumed/);
    release(); const handle = await first;
    issuer.assertIssuedTargetHandoff(handle, f.session);
    assert.equal(f.counters.sessionStatus, 1); assert.equal(f.counters.opens, 1);
  } finally { release?.(); await f.close(); }
});

for (const mode of ['pending', 'revoke', 'availability', 'instance', 'resource', 'stale', 'lost-status', 'issuer-close'] as const) {
  test(`${mode} wins a blocked private handoff; no failed attempt is rearmed`, async () => {
    const f = await appTaskBridgeFixture(); let release!: () => void;
    try {
      let entered!: () => void; const arrived = new Promise<void>(done => { entered = done; });
      f.hooks.status = async () => {
        entered(); await new Promise<void>(done => { release = done; });
        if (mode === 'lost-status') throw new Error('synthetic-lost-status');
        return { state: mode === 'stale' ? 'stale' : 'open', readiness: {} };
      };
      const issuer = f.service.launcher as ControlledAppLauncher;
      const connecting = issuer.handoffIssuedTarget(f.service.registry, f.profile, f.outcome.target!, f.session);
      const rejected = assert.rejects(connecting, mode === 'pending' ? /denied-pending/ : mode === 'revoke' || mode === 'availability' ? /profile-no-longer-current/ :
        mode === 'issuer-close' ? /issuer-closed/ : mode === 'lost-status' ? /lost-status/ : mode === 'stale' ? /session-stale/ : /session-mismatch/);
      await arrived;
      if (mode === 'pending') f.store.beginAppDenial(f.scope, f.profile.appBindingId, f.profile.revision, 'synthetic-denial');
      if (mode === 'revoke') f.service.onboarding!.revoke({ appBindingId: f.profile.appBindingId, expectedRevision: f.profile.revision }, 'synthetic-revoke');
      if (mode === 'availability') f.service.registry.setAvailability(f.profile.appBindingId, f.profile.revision, false, 'synthetic-unavailable');
      if (mode === 'instance') Object.assign(f.session, { instanceId: 'synthetic-replacement' });
      if (mode === 'resource') Object.assign(f.session, { inputResourceId: 'synthetic-replacement' });
      if (mode === 'issuer-close') await f.apps.close();
      release(); await rejected;
      f.hooks.status = undefined;
      await assert.rejects(issuer.handoffIssuedTarget(f.service.registry, f.profile, f.outcome.target!, f.session),
        mode === 'issuer-close' ? /issuer-closed/ : /unavailable-or-consumed/);
      assert.equal(f.counters.starts, 0); assert.equal(f.counters.cleanups, 0);
    } finally { release?.(); await f.close(); }
  });
}

test('after handoff, observed identity loss is terminal even if the Session fields are restored', async () => {
  const f = await appTaskBridgeFixture();
  try {
    const issuer = f.service.launcher as ControlledAppLauncher;
    const handle = await issuer.handoffIssuedTarget(f.service.registry, f.profile, f.outcome.target!, f.session);
    const original = f.session.instanceId;
    Object.assign(f.session, { instanceId: 'synthetic-new-instance' });
    assert.throws(() => issuer.assertIssuedTargetHandoff(handle, f.session), /session-mismatch/);
    Object.assign(f.session, { instanceId: original });
    assert.throws(() => issuer.assertIssuedTargetHandoff(handle, f.session), /handoff-unavailable/);
  } finally { await f.close(); }
});

for (const failOpen of [false, true]) {
  test(`a ${failOpen ? 'failed' : 'successful'} later reservation retires the original handoff and receipt`, async () => {
    const f = await appTaskBridgeFixture();
    try {
      const issuer = f.service.launcher as ControlledAppLauncher;
      const handle = await issuer.handoffIssuedTarget(f.service.registry, f.profile, f.outcome.target!, f.session);
      if (failOpen) f.backend.open = async () => { throw new Error('synthetic-reserve-ack-lost'); };
      else Object.assign(f.instance, { targetToken: 'synthetic-new-target' });
      await f.service.onboarding!.reuse({ appBindingId: f.profile.appBindingId,
        expectedRevision: f.profile.revision, operationId: 'synthetic-next-reservation' }, 'synthetic-operator');
      assert.throws(() => issuer.assertIssuedTargetHandoff(handle, f.session), /handoff-unavailable/);
      assert.throws(() => issuer.consumeIssuedTarget(f.profile, f.outcome.target!), /unavailable-or-consumed/);
      assert.equal(f.counters.starts, 0); assert.equal(f.counters.cleanups, 0);
    } finally { await f.close(); }
  });
}

test('late extraction of an earlier launch outcome cannot mint provenance after a newer reservation', async () => {
  const f = await appTaskBridgeFixture();
  try {
    const issuer = f.service.launcher as ControlledAppLauncher;
    const issue = async () => {
      const grant = issuer.authorize(f.service.registry, f.profile.appBindingId, f.profile.revision, new AbortController().signal, () => {});
      await issuer.verify(grant.profile, grant.permission); return grant.permission;
    };
    Object.assign(f.instance, { targetToken: 'synthetic-delayed-outcome' });
    const old = await issue();
    Object.assign(f.instance, { targetToken: 'synthetic-current-outcome' });
    const current = await issue();
    const historical = issuer.outcome(old), fresh = issuer.outcome(current);
    assert.equal(historical.verification.result, 'verified');
    assert.throws(() => issuer.consumeIssuedTarget(f.profile, historical.target!), /unavailable-or-consumed/);
    const handle = await issuer.handoffIssuedTarget(f.service.registry, f.profile, fresh.target!, f.session);
    issuer.assertIssuedTargetHandoff(handle, f.session);
  } finally { await f.close(); }
});

test('late historical outcome with the same token also retires a newer matching receipt', async () => {
  const f = await appTaskBridgeFixture();
  try {
    const issuer = f.service.launcher as ControlledAppLauncher;
    const issue = async () => {
      const grant = issuer.authorize(f.service.registry, f.profile.appBindingId, f.profile.revision, new AbortController().signal, () => {});
      await issuer.verify(grant.profile, grant.permission); return grant.permission;
    };
    Object.assign(f.instance, { targetToken: 'synthetic-duplicate-delayed' });
    const old = await issue(), newer = await issue();
    const fresh = issuer.outcome(newer);
    const handle = await issuer.handoffIssuedTarget(f.service.registry, f.profile, fresh.target!, f.session);
    const historical = issuer.outcome(old);
    assert.deepEqual(historical.target, fresh.target);
    assert.throws(() => issuer.assertIssuedTargetHandoff(handle, f.session), /handoff-unavailable/);
    assert.throws(() => issuer.consumeIssuedTarget(f.profile, historical.target!), /unavailable-or-consumed/);
  } finally { await f.close(); }
});

test('issuer invalidation precedes asynchronous backend close; old handles and direct authorizations are refused', async () => {
  const f = await appTaskBridgeFixture(); let release!: () => void;
  try {
    const issuer = f.service.launcher as ControlledAppLauncher;
    const handle = await issuer.handoffIssuedTarget(f.service.registry, f.profile, f.outcome.target!, f.session);
    let entered!: () => void; const arrived = new Promise<void>(done => { entered = done; });
    f.backend.close = async () => { entered(); await new Promise<void>(done => { release = done; }); };
    const closing = f.apps.close(); await arrived;
    assert.throws(() => issuer.assertIssuedTargetHandoff(handle, f.session), /issuer-closed/);
    assert.throws(() => issuer.authorize(f.service.registry, f.profile.appBindingId, f.profile.revision, new AbortController().signal, () => {}), /issuer-closed/);
    release(); await closing;
    f.backend.close = async () => {};
  } finally { release?.(); f.backend.close = async () => {}; await f.close(); }
});

test('backend installation scope loss retires provenance permanently', async () => {
  const f = await appTaskBridgeFixture();
  try {
    const issuer = f.service.launcher as ControlledAppLauncher;
    const handle = await issuer.handoffIssuedTarget(f.service.registry, f.profile, f.outcome.target!, f.session);
    const original = f.scope.installationScopeId;
    f.scope.installationScopeId = 'synthetic-replaced-os';
    assert.throws(() => issuer.assertIssuedTargetHandoff(handle, f.session), /issuer-scope-changed/);
    f.scope.installationScopeId = original;
    assert.throws(() => issuer.consumeIssuedTarget(f.profile, f.outcome.target!), /cleanup-unconfirmed/);
  } finally { await assert.rejects(f.apps.close(), /drain-unconfirmed/); f.store.close(); }
});
