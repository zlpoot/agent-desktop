import assert from 'node:assert/strict';
import { test } from 'node:test';
import { producerReferenceFixture, SyntheticRevokeManagement } from './fixtures/app-producer-fence.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

test('reference producer: 0/1 earlier effects survive; revoke ACK precedes release and blocks search/play/focus/restore', async () => {
  for (const prior of [0, 1]) {
    const f = producerReferenceFixture(), queued = deferred();
    if (prior) await f.producer.dispatch('earlier', f.binding, 'search', 'fixed-search');
    const retained = structuredClone(f.producer.effects);
    const blocked = (['search', 'play', 'focus', 'restore'] as const).map(action => {
      const role = action === 'search' ? 'fixed-search' : action === 'play' ? 'fixed-play' : 'original-window';
      return assert.rejects(f.producer.dispatch(`queued-${action}`, f.binding, action, role, queued.promise), /app-revoked/);
    });
    const ack = await f.management.revoke(async request => f.producer.revoke(request));
    assert.equal(ack.lastCommitSequence, prior); assert.equal(f.management.phase, 'confirmed');
    queued.resolve(); await Promise.all(blocked);
    assert.deepEqual(f.producer.effects, retained);
    await assert.rejects(f.producer.dispatch('new', f.binding, 'play', 'fixed-play'), /app-revoked/);
    assert.equal('appTrustFence' in f.producer, false);
  }
});

test('reference counterexample: local admission denial and a queued script ACK do not establish remote effect denial', async () => {
  const f = producerReferenceFixture(), delivery = deferred(), queued = deferred();
  const pending = f.producer.dispatch('already-queued', f.binding, 'play', 'fixed-play', queued.promise);
  const revoking = f.management.revoke(async request => { await delivery.promise; return f.producer.revoke(request); });
  assert.equal(f.management.localDenied, true); assert.equal(f.management.phase, 'denied-pending');
  assert.equal(f.management.registryRevoked, false);
  // Producer has not received revoke yet; an earlier accepted operation can still commit.
  queued.resolve(); await pending; assert.equal(f.producer.effects.length, 1);
  delivery.resolve(); const ack = await revoking; assert.equal(ack.lastCommitSequence, 1);
  assert.equal(f.management.registryRevoked, true);
  await assert.rejects(f.producer.dispatch('after-ack', f.binding, 'play', 'fixed-play'), /app-revoked/);
});

test('reference producer rechecks exact identity and authority after queueing, not just before it', async () => {
  const changes = { providerId: 'other', environmentId: 'other', installationScopeId: 'other', appBindingId: 'other',
    profileRevision: 2, profileDigest: 'changed', installationFingerprint: 'replaced', applicationVersion: 'changed',
    launchDefinitionDigest: 'changed-argv-cwd', issuerIncarnation: 'restarted', targetToken: 'other',
    processIncarnation: 'replaced-process', windowIncarnation: 'recreated-window', windowsSession: 8,
    desktop: 'other-desktop', taskSession: 'other-session', taskInstance: 'other-instance', inputLease: 'other-lease',
    inputEpoch: 2, scenario: 'other-scenario' };
  for (const [key, value] of Object.entries(changes)) {
    const f = producerReferenceFixture(), queued = deferred();
    const rejected = assert.rejects(f.producer.dispatch('queued', f.binding, 'play', 'fixed-play', queued.promise), /target-or-grant-changed/);
    Object.assign(f.producer.current, { [key]: value }); queued.resolve(); await rejected;
    assert.deepEqual(f.producer.effects, []);
  }
});

test('reference producer refuses expired deadline, input revoke and unsupported roles without effects or replay', async () => {
  for (const mode of ['deadline', 'input', 'readiness', 'role', 'action']) {
    const f = producerReferenceFixture();
    if (mode === 'deadline') f.producer.deadline = 0;
    if (mode === 'input') f.producer.inputCurrent = false;
    if (mode === 'readiness') f.producer.ready = false;
    await assert.rejects(f.producer.dispatch('once', f.binding, mode === 'action' ? '__proto__' as 'play' : 'play',
      mode === 'role' ? 'arbitrary-control' : 'fixed-play'), /unavailable/);
    await assert.rejects(f.producer.dispatch('once', f.binding, 'play', 'fixed-play'), /replay/);
    assert.deepEqual(f.producer.effects, []);
  }
});

test('reference producer freezes submitted context; caller mutations cannot retarget a queued operation', async () => {
  const f = producerReferenceFixture(), queued = deferred(), submitted = structuredClone(f.binding);
  const dispatch = f.producer.dispatch('snapshot', submitted, 'play', 'fixed-play', queued.promise);
  submitted.windowIncarnation = 'caller-replacement'; submitted.inputEpoch = 99;
  queued.resolve(); await dispatch; assert.deepEqual(f.producer.effects, [{ sequence: 1, action: 'play' }]);
});

test('reference ACK rejects wrong nonce/epoch/version/context, incomplete drain, sequence rollback and extra fields', async () => {
  for (const mode of ['nonce', 'epoch', 'version', 'context', 'deny', 'drain', 'rollback', 'fraction', 'extra']) {
    const f = producerReferenceFixture(); await f.producer.dispatch('before', f.binding, 'search', 'fixed-search');
    const management = new SyntheticRevokeManagement(f.binding, () => f.producer.current, 1);
    await assert.rejects(management.revoke(async request => {
      const ack = f.producer.revoke(request);
      if (mode === 'nonce') ack.nonce = 'late-other-request';
      if (mode === 'epoch') ack.appEpoch--;
      if (mode === 'version') ack.version = 'legacy-v1';
      if (mode === 'context') ack.binding.issuerIncarnation = 'other-issuer';
      if (mode === 'deny') Object.assign(ack, { denied: false });
      if (mode === 'drain') Object.assign(ack, { drained: false });
      if (mode === 'rollback') ack.lastCommitSequence = 0;
      if (mode === 'fraction') ack.lastCommitSequence = 1.5;
      if (mode === 'extra') Object.assign(ack, { capability: true });
      return ack;
    }), /ack-unconfirmed/);
    assert.equal(management.phase, 'unknown'); assert.equal(management.localDenied, true);
    await assert.rejects(f.producer.dispatch('after', f.binding, 'play', 'fixed-play'), /app-revoked/);
    assert.deepEqual(f.producer.effects, [{ sequence: 1, action: 'search' }]);
  }
});

test('reference lost/late ACK never restores authorization or retries an uncertain operation', async () => {
  const f = producerReferenceFixture(), network = deferred<unknown>();
  let messages = 0;
  const revoking = f.management.revoke(async request => { messages++; f.producer.revoke(request); return network.promise; });
  const failed = assert.rejects(revoking, /synthetic-ack-lost/); network.reject(new Error('synthetic-ack-lost')); await failed;
  network.resolve({ denied: true }); await Promise.resolve(); // stale completion cannot restore state
  assert.equal(f.management.phase, 'unknown'); assert.equal(f.management.localDenied, true);
  await assert.rejects(f.management.revoke(async () => { messages++; return {}; }), /no-retry-or-recovery/);
  assert.equal(messages, 1);
  await assert.rejects(f.producer.dispatch('after-loss', f.binding, 'focus', 'original-window'), /app-revoked/);
});

test('reference ACK bound to the original peer cannot complete after producer restart; identical revoke request is read-only idempotent', async () => {
  const f = producerReferenceFixture();
  await assert.rejects(f.management.revoke(async request => {
    const ack = f.producer.revoke(request);
    assert.deepEqual(f.producer.revoke(request), ack);
    f.producer.current.issuerIncarnation = 'restarted'; return ack;
  }), /ack-unconfirmed/);
  assert.equal(f.management.phase, 'unknown'); assert.deepEqual(f.producer.effects, []);
});

test('reference persists Registry revoke only after producer ACK; failed write or peer replacement cannot restore input', async () => {
  for (const mode of ['write-failure', 'peer-change']) {
    const f = producerReferenceFixture();
    let writes = 0;
    const management = new SyntheticRevokeManagement(f.binding, () => f.producer.current, 0, () => {
      writes++;
      if (mode === 'write-failure') throw new Error('synthetic-persist-failure');
      f.producer.current.issuerIncarnation = 'replacement-during-write';
    });
    await assert.rejects(management.revoke(async request => {
      assert.equal(writes, 0); assert.equal(management.registryRevoked, false);
      return f.producer.revoke(request);
    }), mode === 'write-failure' ? /persist-failure/ : /peer-changed-during-persist/);
    assert.equal(writes, 1); assert.equal(management.phase, 'unknown');
    assert.equal(management.localDenied, true); assert.equal(management.registryRevoked, mode === 'peer-change');
    await assert.rejects(f.producer.dispatch('after-failed-write', f.binding, 'play', 'fixed-play'), /app-revoked/);
    await assert.rejects(management.revoke(async () => ({})), /no-retry-or-recovery/);
  }
});
