import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskAppFixture } from './fixtures/task-app-onboarding.js';
import { requestedApp, TaskAppOnboarding, type TaskAppRequest } from '../src/app/task-app-onboarding.js';
import { initialState } from '../src/graph/state.js';
import { readTaskBudget, runWithTaskBudget, meteredModelRequest } from '../src/runtime/model-budget.js';
import { recoverDesktopTasks } from '../src/desktop-session/recovery.js';
import { createDashboardServer } from '../src/app/server.js';

function confirmation(f: Awaited<ReturnType<typeof taskAppFixture>>, id: string): TaskAppRequest {
  const app = f.trace.load(id)!.appOnboarding!, candidate = app.candidates[0];
  return { desktopTarget: f.target, interactionId: app.interactionId, action: 'confirm',
    candidateId: candidate.candidateId, candidateRevision: candidate.candidateRevision };
}
test('pure name extraction never infers an environment, executable or command from arbitrary data', () => {
  assert.equal(requestedApp('使用 AA音乐 搜索歌曲'), 'AA音乐');
  assert.equal(requestedApp('用QQ音乐播放歌曲'), 'QQ音乐');
  assert.equal(requestedApp('open "Synthetic App" and search'), 'Synthetic App');
  assert.equal(requestedApp('VM: use Music'), undefined);
  assert.equal(requestedApp('请运行 C:\\evil.exe'), undefined);
});
test('unknown app waits without input/model, double confirmation continues same Task, reuse scans/confirms zero times', async () => {
  const f = await taskAppFixture();
  try {
    const id = f.submit(), waiting = await f.wait(id, state => state.appOnboarding?.state === 'candidates');
    await runWithTaskBudget(f.dir, id, () => meteredModelRequest('deepseek', async () => ({ usage: { total_tokens: 13 } })));
    const before = readTaskBudget(f.dir, id);
    assert.equal(waiting.status, 'waiting_user'); assert.equal(f.counters.models, 0); assert.equal(f.counters.leases, 0);
    assert.equal(f.counters.runtime, 0); assert.equal(f.counters.starts, 0);
    assert.throws(() => f.controller.resume(id, { approved: true }), /dedicated-interaction/);
    const request = confirmation(f, id);
    const [one, two] = await Promise.all([f.controller.onboardApp(id, request), f.controller.onboardApp(id, request)]);
    assert.deepEqual(one, two); assert.equal(one.state, 'ready'); assert.equal(f.counters.starts, 1);
    const resumed = await f.wait(id, state => !!state.observation && state.status === 'waiting_user');
    assert.equal(resumed.goal, waiting.goal); assert.equal(resumed.taskId, id); assert.deepEqual(resumed.desktopExecutionBinding, waiting.desktopExecutionBinding);
    assert.equal(resumed.lastAction?.kind, 'ask_user'); assert.equal(resumed.goalVerification?.ok, undefined);
    assert.deepEqual(readTaskBudget(f.dir, id), before);
    assert.equal(before!.usage.deepseek.calls, 1); assert.equal(before!.usage.deepseek.tokens, 13);
    assert.equal(f.trace.events(id).filter(e => e.node === 'queued').length, 1);
    assert.ok(f.counters.releases >= 1);
    await f.controller.onboardApp(id, request); assert.equal(f.counters.starts, 1);
    const scans = f.counters.scans;
    const second = f.submit(); await f.wait(second, state => state.appOnboarding?.state === 'ready' && !!state.observation);
    assert.equal(f.counters.scans, scans); assert.equal(f.counters.starts, 1);
    const profile = f.apps.forEnvironment(f.target).registry.list()[0]; assert.equal(profile.confirmations.length, 1);
    assert.ok(f.trace.events(second).some(e => e.node === 'app_profile_reused'));
    assert.equal(f.trace.events(second).some(e => e.state.status === 'waiting_user' && e.state.appOnboarding?.state !== 'ready'), false);
    recoverDesktopTasks(f.dir);
    assert.equal(f.trace.load(second)!.appOnboarding!.state, 'new_task_required');
    assert.throws(() => f.controller.continue(second), /new-task-required/);
    assert.equal(f.apps.forEnvironment(f.target).registry.list()[0].trust, 'verified');
  } finally { await f.close(); }
});
test('multiple candidates require selection; rejection never selects next; path and rescan invalidate previous interaction', async () => {
  const f = await taskAppFixture();
  try {
    f.setEntries([...f.entries(), { ...f.entries()[0], launchSpec: { kind: 'exe', executable: 'D:\\Synthetic\\Music.exe', args: [] } }]);
    const id = f.submit(); await f.wait(id, state => state.appOnboarding?.candidates.length === 2);
    const old = confirmation(f, id);
    await assert.rejects(f.controller.onboardApp(id, { ...old, candidateId: undefined }), /candidate-mismatch/);
    await f.controller.onboardApp(id, { ...old, action: 'reject' }); assert.equal(f.counters.starts, 0);
    await assert.rejects(f.controller.onboardApp(id, old), /interaction-mismatch/);
    let app = f.trace.load(id)!.appOnboarding!;
    assert.equal(app.state, 'rejected'); assert.equal(app.candidates.length, 0);
    await f.controller.onboardApp(id, { desktopTarget: f.target, interactionId: app.interactionId, action: 'path', path: 'D:\\Synthetic\\Music.exe' });
    app = f.trace.load(id)!.appOnboarding!; assert.equal(app.candidates.length, 1); assert.match(app.candidates[0].path, /^D:/);
    const prior = confirmation(f, id);
    await f.controller.onboardApp(id, { desktopTarget: f.target, interactionId: app.interactionId, action: 'rescan' });
    await assert.rejects(f.controller.onboardApp(id, prior), /interaction-mismatch/); assert.equal(f.counters.starts, 0);
  } finally { await f.close(); }
});
test('not found, install/rescan and unavailable remain distinct; cancellation is terminal', async () => {
  const f = await taskAppFixture();
  try {
    const saved = f.entries(); f.setEntries([]);
    const id = f.submit(); await f.wait(id, state => state.appOnboarding?.state === 'not_found');
    let app = f.trace.load(id)!.appOnboarding!;
    f.setEntries(saved);
    await f.controller.onboardApp(id, { desktopTarget: f.target, interactionId: app.interactionId, action: 'rescan' });
    const confirm = confirmation(f, id); app = f.trace.load(id)!.appOnboarding!;
    await f.controller.onboardApp(id, { desktopTarget: f.target, interactionId: app.interactionId, action: 'cancel' });
    assert.equal(f.trace.load(id)!.status, 'stopped'); await assert.rejects(f.controller.onboardApp(id, confirm), /expired|new-task-required/);
    f.setEntries([]); f.offline(); const offline = f.submit(); await f.wait(offline, state => state.appOnboarding?.state === 'unavailable');
    assert.equal(f.counters.starts, 0); assert.equal(f.counters.models, 0);
  } finally { await f.close(); }
});
test('cross Task/target, arbitrary launch fields and changed revisions are rejected directly by backend', async () => {
  const f = await taskAppFixture();
  try {
    const id = f.submit(); await f.wait(id, state => state.appOnboarding?.state === 'candidates');
    const request = confirmation(f, id);
    await assert.rejects(f.controller.onboardApp(id, { ...request, desktopTarget: { ...f.target, environmentId: 'other' } }), /target-or-interaction/);
    await assert.rejects(f.controller.onboardApp('other-task', request), /task-not-found/);
    await assert.rejects(f.controller.onboardApp(id, { ...request, candidateRevision: 999 }), /candidate-mismatch/);
    await assert.rejects(f.controller.onboardApp(id, { ...request, launchSpec: {} } as TaskAppRequest), /invalid-app-onboarding/);
    await f.discovery.scan(); await assert.rejects(f.controller.onboardApp(id, request), /stale-or-unknown/);
    assert.equal(f.counters.starts, 0);
  } finally { await f.close(); }
});
test('Host restart, session identity loss and uncertain action forbid resume/replay', async () => {
  for (const mode of ['restart', 'stale', 'uncertain', 'scope', 'forbidden'] as const) {
    const f = await taskAppFixture();
    try {
      const id = f.submit(); await f.wait(id, state => state.appOnboarding?.state === 'candidates');
      const request = confirmation(f, id);
      if (mode === 'restart') { recoverDesktopTasks(f.dir); assert.throws(() => f.controller.continue(id), /new-task-required/); }
      if (mode === 'stale') f.stale();
      if (mode === 'uncertain') f.trace.save('synthetic-uncertainty', { ...f.trace.load(id)!, recoveryUncertain: true,
        inFlightAction: { kind: 'click', target: { kind: 'coordinate', x: 1, y: 1 } } });
      if (mode === 'scope') f.store.bind({ ...f.scope, installationScopeId: 'replacement-installation' });
      if (mode === 'forbidden') f.block();
      await assert.rejects(f.controller.onboardApp(id, request)); assert.equal(f.counters.starts, 0); assert.equal(f.counters.leases, 0);
    } finally { await f.close(); }
  }
});
test('cancellation during launch drain prevents callback from resuming original Task', async () => {
  const f = await taskAppFixture(); let release!: () => void, entered!: () => void;
  const drain = new Promise<void>(done => { release = done; }); const observing = new Promise<void>(done => { entered = done; });
  try {
    f.beforeObserve(async () => { entered(); await drain; });
    const id = f.submit(); await f.wait(id, state => state.appOnboarding?.state === 'candidates');
    const request = confirmation(f, id), result = f.controller.onboardApp(id, request); const rejected = assert.rejects(result);
    await observing;
    await f.controller.onboardApp(id, { desktopTarget: f.target, interactionId: request.interactionId, action: 'cancel' });
    release(); await rejected;
    assert.equal(f.trace.load(id)!.status, 'stopped'); assert.equal(f.counters.models, 0); assert.equal(f.counters.leases, 0);
  } finally { release(); await f.close(); }
});
test('onboarding preserves fixed Workflow, plan, retries and original goal; it cannot promote business acceptance', async () => {
  const f = await taskAppFixture();
  const original = { ...initialState('pinned-task', '使用 AA音乐 搜索合成歌曲'), taskBindingVersion: 1 as const,
    desktopTarget: f.target, desktopExecutionBinding: { ...f.target, sessionId: 'frozen-session', instanceId: 'frozen-instance' },
    workflowRef: { id: 'fixed-workflow', version: 7, values: { song: 'synthetic' }, explicit: true, definitionHash: 'frozen-hash' },
    plan: ['fixed step'], retryCount: 2 };
  let saved: import('../src/graph/state.js').ComputerState = original, resumes = 0;
  const coordinator = new TaskAppOnboarding(f.apps, {
    load: () => structuredClone(saved), save: (_node, value) => { saved = structuredClone(value); },
    guard: async value => { assert.deepEqual(value.desktopTarget, f.target); }, resume: id => { assert.equal(id, original.taskId); resumes++; },
  });
  try {
    assert.equal(await coordinator.beforeRun(original.taskId), false);
    const app = saved.appOnboarding!, candidate = app.candidates[0];
    await coordinator.act(original.taskId, { action: 'confirm', desktopTarget: f.target, interactionId: app.interactionId,
      candidateId: candidate.candidateId, candidateRevision: candidate.candidateRevision });
    assert.equal(resumes, 1); assert.equal(saved.status, 'running'); assert.deepEqual(saved.workflowRef, original.workflowRef);
    assert.deepEqual(saved.plan, original.plan); assert.deepEqual(saved.desktopExecutionBinding, original.desktopExecutionBinding);
    assert.equal(saved.retryCount, 2); assert.equal(saved.goal, original.goal); assert.equal(saved.goalVerification, undefined);
    assert.equal(saved.acceptanceReport, undefined);
  } finally { await coordinator.close(); await f.close(); }
});
test('profile revision change rejects old confirmation; successful configuration survives failed Task session handoff', async () => {
  for (const mode of ['profile', 'handoff'] as const) {
    const f = await taskAppFixture();
    try {
      const id = f.submit(); await f.wait(id, state => state.appOnboarding?.state === 'candidates');
      const request = confirmation(f, id), service = f.apps.forEnvironment(f.target);
      if (mode === 'profile') {
        const prepare = service.onboarding!.prepare.bind(service.onboarding);
        service.onboarding!.prepare = async value => {
          const display = await prepare(value), app = service.registry.get(display.appBindingId)!;
          service.registry.markStale(app.appBindingId, app.revision, 'synthetic-profile-change'); return display;
        };
      } else {
        const confirm = service.onboarding!.confirm.bind(service.onboarding);
        service.onboarding!.confirm = async (value, operator) => { const result = await confirm(value, operator); f.stale(); return result; };
      }
      await assert.rejects(f.controller.onboardApp(id, request));
      assert.equal(f.counters.leases, 0); assert.equal(f.counters.models, 0);
      if (mode === 'profile') assert.equal(f.counters.starts, 0);
      else { assert.equal(service.registry.list()[0].trust, 'verified'); assert.equal(f.trace.load(id)!.appOnboarding!.state, 'new_task_required'); }
    } finally { await f.close(); }
  }
});
test('HTTP preserves local same-origin operator gate, field allowlist, bounded body and real confirmation service', async () => {
  const f = await taskAppFixture(); const server = createDashboardServer(f.dir, f.controller);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('missing address');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const id = f.submit(); await f.wait(id, state => state.appOnboarding?.state === 'candidates');
    const value = confirmation(f, id);
    const post = (path: string, body: unknown, origin?: string) => fetch(base + path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
    const path = `/api/tasks/${id}/app-onboarding`;
    assert.equal((await post(path, value)).status, 403);
    assert.equal((await post(path, value, 'http://evil.example')).status, 403);
    assert.equal((await post(path, { ...value, verified: true }, base)).status, 409);
    assert.equal((await post(path, { ...value, path: 'x'.repeat(25000) }, base)).status, 400);
    assert.equal((await post('/api/tasks', { goal: 'use Music', desktopTarget: f.target, launchSpec: {} }, base)).status, 400);
    assert.equal((await post(path, value, base)).status, 200);
    assert.equal(f.counters.starts, 1);
  } finally { await new Promise<void>(done => server.close(() => done())); await f.close(); }
});
