import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalWorkspaceDesktopProvider, type LocalWorkspaceBackend, type LocalWorkspaceFrame, type LocalWorkspaceState } from '../src/desktop-provider/local-workspace-provider.js';
import { LocalWorkspaceTaskExecutor } from '../src/desktop-provider/local-workspace-task-executor.js';
import { ResourceInputControl } from '../src/desktop-provider/resource-input-control.js';
import { TaskDesktopSessions } from '../src/app/task-desktop-sessions.js';
import { desktopTarget } from '../src/contracts/task-desktop.js';
import type { InputAuthority } from '../src/contracts/desktop-input-control.js';
import type { ComputerAction } from '../src/actions/schema.js';
import type { WindowInfo } from '../src/runtime/desktop/desktop-runtime.js';
import { FakeModel } from '../src/agent/model-adapter.js';
import { createRootAssembly } from '../src/composition/root.js';
import { SqliteTrace } from '../src/trace/sqlite-trace.js';
import { loadDesktopEnvironmentConfig } from '../src/composition/desktop-environment-config.js';
import { LocalWorkspaceAgentRuntime } from '../src/desktop-provider/local-workspace-agent-runtime.js';

const path = 'C:\\synthetic\\cloudmusic.exe';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const window: WindowInfo = { handle: 42, title: 'synthetic NetEase', windowClass: 'OrpheusBrowserHost', processId: 7,
  processPath: path, targetElevated: false, visible: true, minimized: false, foreground: false,
  rect: { left: 0, top: 0, width: 1, height: 1 } };
const row = (role: number, name: string) => ({ role, name, auto_id: name, class: 'synthetic', enabled: true,
  runtime_id: [7, role],
  offscreen: false, rect: [0, 0, 1, 1] as [number, number, number, number] });
class SyntheticWorkspace implements LocalWorkspaceBackend {
  current: LocalWorkspaceState = { status: 'ready', app: 'netease', app_version: '3.1.40.205461',
    run_id: 'synthetic', owner: 'agent', epoch: 1, control_ready: true, input_ready: true,
    desktop: 'AgentD0_synthetic', task_window: window };
  grant?: InputAuthority;
  starts = 0; stops = 0; fixedScripts = 0; effects: ComputerAction[] = []; sequence = 0;
  query = ''; result = ''; uncertain = false; failCleanup = false;
  rows = [row(50004, '搜索'), row(50000, 'search'), row(50019, '单曲')];
  async start() { this.starts++; return { state: this.current, targetId: 'original-target', viewerPort: 19991,
    viewerToken: 'synthetic-only', windowsSessionId: 1, backendInstanceId: 'original-instance' }; }
  async state() { return { state: this.current, targetId: 'original-target', windowsSessionId: 1, backendInstanceId: 'original-instance' }; }
  async activateGrant(_run: string, authority: InputAuthority) {
    this.grant = authority; return this.current = { ...this.current, owner: authority.owner.kind, epoch: this.current.epoch! + 1 };
  }
  async revokeGrant() { this.grant = undefined; return this.current = { ...this.current, owner: 'none', epoch: this.current.epoch! + 1 }; }
  async frame(): Promise<LocalWorkspaceFrame> {
    return { window, observationToken: `fresh-${++this.sequence}`, validForMs: 2000, png: png.toString('base64'),
      metadata: { sequence: this.sequence, width: 1, height: 1, sha256: createHash('sha256').update(png).digest('hex'), heartbeat: this.sequence },
      uia: [...this.rows.map(item => item.role === 50004 ? { ...item, value: this.query, value_complete: true } : item),
        ...(this.result ? [row(50007, this.result)] : [])] };
  }
  async act(): Promise<never> { this.fixedScripts++; throw Error('fixed script must never be used'); }
  async taskAction(_run: string, epoch: number, authority: InputAuthority, token: string, action: ComputerAction) {
    assert.equal(authority, this.grant); assert.equal(epoch, this.current.epoch); assert.equal(token, `fresh-${this.sequence}`);
    this.effects.push(action);
    if (this.uncertain) return { ok: false, effect: 'uncertain' as const, message: 'synthetic lost effect ACK' };
    if (action.kind === 'type') this.query = action.text;
    if (action.kind === 'click') this.result = this.query;
    return { ok: true, effect: 'dispatched' as const, message: 'synthetic only' };
  }
  async ping() {}
  async stop() { this.stops++; return { ...this.current, status: 'stopped', cleanup:
    { status: this.failCleanup ? 'UNKNOWN' : 'PASS', job_active: this.failCleanup ? 1 : 0, desktop_absent: !this.failCleanup } }; }
  async close() {}
  viewerUrl() { return 'http://127.0.0.1:19991/#synthetic-only'; }
  setEventHandler() {}
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'issue97-agent-'));
  const backend = new SyntheticWorkspace(), arbiter = new ResourceInputControl();
  const provider = new LocalWorkspaceDesktopProvider(arbiter, { app: 'netease', path, taskMode: 'agent' }, dir, process.cwd(), () => backend, true);
  const executor = new LocalWorkspaceTaskExecutor(provider);
  const sessions = new TaskDesktopSessions([provider], new Map([[provider.id, executor]]));
  const target = desktopTarget(provider.id, 'local-workspace:netease');
  return { dir, backend, arbiter, provider, executor, sessions, target,
    async open() { const entry = await sessions.acquire('task', { taskBindingVersion: 1, desktopTarget: target }, () => {});
      await entry.control.beginTask('task'); const runtime = await executor.connectRuntime(entry.session, dir);
      await runtime.attach({ windowHandle: 42 }); await runtime.observe(); return { ...entry, runtime }; },
    async close() { try { await sessions.close(); } catch {} try { await provider.close(); } catch {}
      assert.equal(resolve(dir).startsWith(resolve(tmpdir()) + sep), true); rmSync(dir, { recursive: true, force: true }); } };
}

test('opt-in connector is lazy; legacy fixed scenario and app-only routes remain disabled for generic Tasks', async () => {
  const f = fixture();
  try {
    assert.equal((await f.sessions.discover())[0].executable, true); assert.equal(f.backend.starts, 0);
    assert.deepEqual(f.provider.scenarios('local-workspace:netease'), []);
    assert.equal((await f.provider.capabilities())['control.humanTakeover']?.[0].state, 'not-proven');
    assert.equal((await f.provider.capabilities())['input.semantic']?.[0].state, 'not-proven');
    assert.throws(() => f.provider.scenario('local-workspace:netease', 'd0-netease-fixed-track-v1'), /scenario-not-proven/);
    writeFileSync(join(f.dir, 'operator.json'), JSON.stringify({ localWorkspace: { app: 'netease', path, taskMode: 'agent' } }));
    assert.equal(loadDesktopEnvironmentConfig(join(f.dir, 'operator.json')).localWorkspace?.app, 'netease');
    const legacy = new LocalWorkspaceDesktopProvider(new ResourceInputControl(), { app: 'netease', path, song: '我怀念的', artist: '孙燕姿' }, f.dir, '.', () => f.backend, true);
    assert.throws(() => new LocalWorkspaceTaskExecutor(legacy).assertAvailable(), /executor-unavailable/); await legacy.close();
  } finally { await f.close(); }
});

test('Task owns one app launch, dynamic semantic input and original binding; no fixed script or focus fallback', async () => {
  const f = fixture();
  try {
    const { runtime, control } = await f.open();
    await runtime.ensureApp('netease'); assert.equal(f.backend.starts, 1);
    await runtime.observe();
    await runtime.execute({ kind: 'type', target: { kind: 'role', role: 'edit' }, text: '周杰伦 晴天' });
    await runtime.observe(); await runtime.execute({ kind: 'click', target: { kind: 'role', role: 'button', name: 'search' } });
    assert.equal(f.backend.result, '周杰伦 晴天'); assert.equal(f.backend.fixedScripts, 0);
    await assert.rejects(runtime.attach({ windowHandle: 99 }), /target-mismatch/);
    await assert.rejects(runtime.recoverFocus(), /focus-forbidden/);
    await control.finishTask('task'); assert.ok(f.backend.stops > 0);
  } finally { await f.close(); }
});

test('ambiguous targets and coordinates produce zero native effects', async () => {
  const f = fixture();
  try {
    const { runtime } = await f.open();
    f.backend.rows.push(row(50000, 'search')); await runtime.observe();
    const action: ComputerAction = { kind: 'click', target: { kind: 'role', role: 'button', name: 'search' } };
    assert.equal((await runtime.ground(action)).target, undefined); assert.equal((await runtime.execute(action)).effect, 'none');
    assert.equal((await runtime.execute({ kind: 'click', target: { kind: 'coordinate', x: 0, y: 0 } })).effect, 'none');
    assert.equal(f.backend.effects.length, 0);
  } finally { await f.close(); }
});

test('lost ownership, version drift and unknown effects prohibit the next dispatch', async () => {
  for (const failure of ['owner', 'version', 'unknown'] as const) {
    const f = fixture();
    try {
      const { runtime, session } = await f.open();
      const action: ComputerAction = { kind: 'click', target: { kind: 'role', role: 'button', name: 'search' } };
      if (failure === 'owner') await f.arbiter.revokeSession(session);
      if (failure === 'version') f.backend.current.app_version = 'other';
      if (failure === 'unknown') { f.backend.uncertain = true; assert.equal((await runtime.execute(action)).effect, 'uncertain'); }
      await assert.rejects(runtime.execute(action)); assert.equal(f.backend.effects.length, failure === 'unknown' ? 1 : 0);
    } finally { await f.close(); }
  }
});

test('fresh already-checked state is a no-op; false/UNKNOWN never dispatch a favorite toggle', async () => {
  for (const checked of [true, false, undefined]) {
    let effects = 0;
    const observation = { windowHandle: 42, structured: { source: 'uia' as const, complete: true,
      items: [{ role: 'checkbox', name: 'synthetic track favorite', checked, complete: true }] } };
    const runtime = new LocalWorkspaceAgentRuntime({ bind: async () => assert.fail(), observe: async () => observation,
      inspectWindow: async () => window, runValidatedScenario: async () => assert.fail(), close: async () => {},
      executeAction: async () => { effects++; return { ok: true, message: 'must not execute' }; } }, () => {});
    await runtime.attach({ windowHandle: 42 }); await runtime.observe();
    const result = await runtime.execute({ kind: 'set_checked', target: { kind: 'role', role: 'checkbox', name: 'synthetic track favorite' }, checked: true });
    assert.equal(result.ok, checked === true); assert.equal(effects, 0); assert.equal(result.effect, 'none'); await runtime.close();
  }
});

test('normal Controller → Task-owned Provider → Agent Loop searches two dynamic songs and persists cleanup; synthetic only', async () => {
  for (const [artist, song] of [['周杰伦', '晴天'], ['陈奕迅', '十年']]) {
    const f = fixture(); let planCalls = 0;
    const query = `${artist} ${song}`, goal = `打开网易云搜索${artist}的《${song}》并收藏`;
    const criteria = { structuredStates: [{ target: { role: 'listitem', name: query }, field: 'text' as const, equals: query }] };
    const model = Object.assign(new FakeModel([
      { kind: 'type', target: { kind: 'role', role: 'edit', name: '搜索' }, text: query },
      { kind: 'click', target: { kind: 'role', role: 'button', name: 'search' } }, { kind: 'done', summary: '合成搜索结果' },
    ]), {
      async planTask(actual: string, windows?: readonly WindowInfo[]) {
        planCalls++; assert.equal(actual, goal); assert.equal(windows?.[0].handle, 42);
        return { task: { environment: 'windows' as const, windowHandle: 42, plan: ['动态搜索'],
          completionCriteria: criteria, verificationContract: { goal,
            successConditions: criteria, evidenceSources: { structuredStates: 'uia' as const }, verifierStrategy: 'rules_then_jev' as const } } };
      },
      async transcribeScreenshot() { return { text: '' }; }, async locateVisualTarget() { throw Error('visual fallback forbidden'); },
      async planStage() { return { goal: '搜索结果可见', successCondition: query, isFinal: true,
        verification: { requirements: [{ id: 'search-result', field: 'accessibility' as const, source: 'uia' as const }] } }; },
      async verifyStage(_stage: unknown, observation: import('../src/actions/schema.js').Observation) {
        const ok = observation.structured?.items.some(item => item.role === 'listitem' && item.name === query) === true;
        return { ok, confidence: ok ? 1 : 0, evidence: observation.accessibility ?? '', source: 'uia' as const }; },
      takeVisualUsage() { return undefined; },
    });
    const root = await createRootAssembly({ rootDir: f.dir, localWorkspace: { app: 'netease', path, taskMode: 'agent' },
      localWorkspaceBackendFactory: () => f.backend, model: { createModel: () => model } });
    try {
      const id = root.controller.submit(goal, { desktopTarget: f.target });
      const trace = new SqliteTrace(join(f.dir, 'web-tasks.sqlite'));
      try {
        const until = Date.now() + 10000;
        while (!trace.events(id).some(event => event.node === 'desktop_task_cleanup_done') && Date.now() < until) await new Promise(done => setTimeout(done, 20));
        assert.equal(planCalls, 1); assert.equal(f.backend.starts, 1); assert.equal(f.backend.fixedScripts, 0);
        assert.equal(f.backend.query, query, JSON.stringify({ error: trace.load(id)?.error, status: trace.load(id)?.status,
          events: trace.events(id).map(event => ({ node: event.node, summary: event.state.summary })) }));
        assert.equal(f.backend.result, query, JSON.stringify({ error: trace.load(id)?.error, events: trace.events(id).map(e => e.node) }));
        const nodes = trace.events(id).map(event => event.node);
        for (const node of ['desktop_bound', 'plan', 'observe', 'decide', 'ground', 'execute', 'verify', 'desktop_task_cleanup_done']) assert.ok(nodes.includes(node), `${node}: ${JSON.stringify(nodes)}`);
        assert.ok(trace.load(id)?.desktopExecutionBinding);
        assert.equal(trace.load(id)?.contractCoverage?.covered, false);
        assert.equal(trace.load(id)?.contractCoverage?.reviewRequired, true);
        assert.equal(trace.load(id)?.status, 'paused');
        assert.notEqual(trace.load(id)?.status, 'done', 'Search evidence cannot certify an unsupported favorite goal');
        assert.ok(trace.events(id).some(event => event.node === 'acceptance_task' &&
          event.state.acceptanceReport?.checks.some(check => check.criterion === 'frozen_goal_coverage' && check.verdict === 'unknown')));
      } finally { trace.close(); }
    } finally { await root.dispose(); await f.close(); }
  }
});

test('unconfirmed owned cleanup stays failed and never records cleanup PASS', async () => {
  const f = fixture();
  let cleanupError: unknown;
  const executor = new LocalWorkspaceTaskExecutor(f.provider, (_id, error) => { cleanupError = error; });
  try {
    const session = await f.provider.open('local-workspace:netease'); const control = executor.taskControl(session);
    await control.beginTask('task'); await executor.connectRuntime(session, f.dir); f.backend.failCleanup = true;
    await assert.rejects(control.finishTask('task'), /cleanup-unconfirmed/); assert.ok(cleanupError);
  } finally { await f.close(); }
});
