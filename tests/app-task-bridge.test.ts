import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appTaskBridgeFixture } from './fixtures/app-task-bridge.js';
import { ControlledAppLauncher } from '../src/environment-apps/launcher.js';
import { createUnavailableAppTaskBridge, appTaskBridgeReadiness, appBridgeCandidatePreview } from '../src/composition/app-task-bridge.js';

const unavailable = /app-task-native-issuer-resolution-and-revoke-fence-unavailable/;
test('structural bridge consumes only this launcher issued receipt once; no Worker or native effect proof is advertised', async () => {
  const f = await appTaskBridgeFixture(), other = await appTaskBridgeFixture();
  try {
    assert.equal(f.outcome.verification.result, 'verified');
    assert.equal('appTrustFence' in f.bridge, false);
    await assert.rejects(other.bridge.connectAppRuntime(f.session, '.', f.binding()), /profile-no-longer-current/);
    assert.throws(() => (other.service.launcher as ControlledAppLauncher).consumeIssuedTarget(f.profile, f.outcome.target!), /issued-target-unavailable-or-consumed/);
    const before = { ...f.counters };
    await assert.rejects(f.bridge.connectAppRuntime(f.session, '.', f.binding()), unavailable);
    await assert.rejects(f.bridge.connectAppRuntime(f.session, '.', f.binding()), /issued-target-unavailable-or-consumed/);
    assert.deepEqual({ ...f.counters, sessionStatus: before.sessionStatus }, before);
    assert.equal(f.counters.starts, 0); assert.equal(f.counters.cleanups, 0);
    assert.throws(() => createUnavailableAppTaskBridge({ ...f.service, launcher: undefined }), /controlled-issuer-unavailable/);
    assert.equal(JSON.stringify(f.service.registry.list()).includes(f.outcome.target!.targetToken), false);
    assert.equal(JSON.stringify(appBridgeCandidatePreview).includes('targetToken'), false);
  } finally { await f.close(); await other.close(); }
});

test('issued record rejects copied profile, installation, launch definition and original context substitution before consumption', async () => {
  const f = await appTaskBridgeFixture();
  try {
    const issuer = f.service.launcher as ControlledAppLauncher;
    for (const mutate of [
      (b: ReturnType<typeof f.binding>) => { b.target.instanceId += '-replacement'; },
      (b: ReturnType<typeof f.binding>) => { b.target.sessionId += '-replacement'; },
      (b: ReturnType<typeof f.binding>) => { b.target.desktop += '-other'; },
      (b: ReturnType<typeof f.binding>) => { b.target.windowsSessionId++; },
      (b: ReturnType<typeof f.binding>) => { b.target.scope.installationScopeId += '-other'; },
      (b: ReturnType<typeof f.binding>) => { b.target.identity.fingerprint += '-binary-replaced'; },
      (b: ReturnType<typeof f.binding>) => { b.target.identity.version += '-other'; },
      (b: ReturnType<typeof f.binding>) => { b.profile.installationId += '-other'; },
      (b: ReturnType<typeof f.binding>) => { b.profile.profileRevision++; },
      (b: ReturnType<typeof f.binding>) => { b.profile.profileDigest += '-other'; },
      (b: ReturnType<typeof f.binding>) => { b.profile.identity!.fingerprint += '-other'; },
      (b: ReturnType<typeof f.binding>) => { if (b.profile.launchSpec.kind !== 'package') b.profile.launchSpec.args = ['--other']; },
      (b: ReturnType<typeof f.binding>) => { if (b.profile.launchSpec.kind !== 'package') b.profile.launchSpec.workingDirectory = 'C:\\Other'; },
    ]) { const binding = f.binding(); mutate(binding); assert.throws(() => issuer.consumeIssuedTarget(binding.profile, binding.target), /mismatch/); }
    await assert.rejects(f.bridge.connectAppRuntime(f.session, '.', f.binding()), unavailable);
    assert.equal(f.counters.starts, 0); assert.equal(f.counters.cleanups, 0);
  } finally { await f.close(); }
});

test('Registry revoke wins a blocked connection after the awaited status; no late receipt can enable native work', async () => {
  const f = await appTaskBridgeFixture(); let release!: () => void;
  try {
    let entered!: () => void; const arrived = new Promise<void>(done => { entered = done; });
    f.hooks.status = async () => { entered(); await new Promise<void>(done => { release = done; }); return { state: 'open', readiness: {} }; };
    const before = { ...f.counters }, audit = f.service.registry.history(f.profile.appBindingId);
    const connecting = f.bridge.connectAppRuntime(f.session, '.', f.binding());
    const rejected = assert.rejects(connecting, /profile-no-longer-current/);
    await arrived;
    const revoked = f.service.onboarding!.revoke({ appBindingId: f.profile.appBindingId, expectedRevision: f.profile.revision }, 'synthetic-revoke');
    assert.equal(revoked.validity, 'revoked'); release(); await rejected;
    assert.deepEqual(f.service.registry.history(f.profile.appBindingId).slice(0, audit.length), audit);
    assert.deepEqual({ ...f.counters, sessionStatus: before.sessionStatus }, before);
    await assert.rejects(f.bridge.connectAppRuntime(f.session, '.', f.binding()), /profile-no-longer-current/);
  } finally { release?.(); await f.close(); }
});

test('late status, stale Provider incarnation and caller mutation cannot manufacture a Session-to-launch mapping', async () => {
  for (const mode of ['stale', 'instance', 'snapshot']) {
    const f = await appTaskBridgeFixture(); let release!: () => void;
    try {
      let entered!: () => void; const arrived = new Promise<void>(done => { entered = done; });
      f.hooks.status = async () => { entered(); await new Promise<void>(done => { release = done; }); return { state: mode === 'stale' ? 'closed' : 'open', readiness: {} }; };
      const binding = f.binding(), connecting = f.bridge.connectAppRuntime(f.session, '.', binding);
      const rejected = assert.rejects(connecting, mode === 'stale' ? /session-stale/ : mode === 'instance' ? /session-mismatch/ : unavailable);
      await arrived;
      if (mode === 'instance') Object.assign(f.session, { instanceId: 'synthetic-replacement' });
      if (mode === 'snapshot') { binding.target.instanceId = 'caller-mutated'; binding.profile.profileDigest = 'caller-mutated'; }
      release(); await rejected;
      assert.equal(f.counters.starts, 0); assert.equal(f.counters.cleanups, 0);
    } finally { release?.(); await f.close(); }
  }
});

test('lost launch drain ACK never yields an issuer receipt or a bridge; readiness is a fixed unavailable projection', async () => {
  const f = await appTaskBridgeFixture({ close: async () => { throw new Error('synthetic-lost-ack'); } });
  try {
    assert.equal(f.outcome.target, undefined); assert.equal(f.outcome.failureKind, 'unknown');
    assert.match(f.outcome.verification.reason!, /cleanup-unconfirmed/);
    for (const providerId of ['physical', 'hyper-v', 'local-workspace', 'unknown', '__proto__', 'constructor']) {
      const view = appTaskBridgeReadiness({ providerId, environmentId: 'synthetic' });
      assert.equal(view.state, 'unavailable'); assert.equal(typeof view.reason, 'string'); assert.equal(view.nativeTargetProof, 'not-proven');
      assert.equal(view.registryEffectFence, 'unavailable'); assert.equal(view.liveAction, 'forbidden');
      assert.doesNotMatch(JSON.stringify(view), /targetToken|executable|grantId/);
    }
  } finally { await assert.rejects(f.apps.close(), /drain-unconfirmed/); f.store.close(); }
});
