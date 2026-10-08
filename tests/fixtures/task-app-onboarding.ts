import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollectedApp } from '../../src/contracts/app-discovery.js';
import type { AppLaunchExecution, AppInstanceEvidence, ManagedAppLaunchBackend } from '../../src/contracts/app-launch.js';
import type { EnvironmentAppBinding } from '../../src/contracts/environment-apps.js';
import type { DesktopProvider } from '../../src/contracts/desktop-environment.js';
import type { WorkerClient } from '../../src/contracts/worker-client.js';
import type { PlanningModel } from '../../src/contracts/model-provider.js';
import type { ComputerAction } from '../../src/actions/schema.js';
import type { DesktopTaskExecutor, TaskAppRuntimeBinding } from '../../src/app/task-desktop-sessions.js';
import { composeEnvironmentApps } from '../../src/composition/environment-apps.js';
import { ScopedAppDiscovery } from '../../src/environment-apps/discovery.js';
import { SqliteEnvironmentAppStore } from '../../src/environment-apps/sqlite-registry.js';
import { DesktopTaskController } from '../../src/app/task-runner.js';
import { TaskDesktopSessions } from '../../src/app/task-desktop-sessions.js';
import { FakeModel } from '../../src/agent/model-adapter.js';
import { SqliteTrace } from '../../src/trace/sqlite-trace.js';

export async function taskAppFixture(options: { bridge?: boolean; actions?: ComputerAction[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'task-app-synthetic-'));
  const target = { providerId: 'synthetic-provider', environmentId: 'selected-environment' };
  const scope = { ...target, installationScopeId: 'synthetic-installation' };
  const identity = { productId: 'synthetic-app', version: '1', fingerprint: 'synthetic-binary' };
  const counters = { scans: 0, inspections: 0, starts: 0, leases: 0, releases: 0, models: 0, runtime: 0, resumes: 0,
    genericRuntime: 0, businessEffects: 0, attaches: 0 };
  let offline = false, stale = false, blocked = false, running = false;
  let beforeObserve: (() => Promise<void>) | undefined;
  let beforePlan: (() => void) | undefined, beforeDispatch: (() => Promise<void>) | undefined;
  const context = { scope, sessionId: 'managed-reservation', instanceId: 'launch-helper', windowsSessionId: 1, desktop: 'SyntheticDesktop' };
  let live = { birth: 1, windowBirth: 1, identity, executable: 'C:\\Synthetic\\Music.exe', args: [] as readonly string[],
    workingDirectory: undefined as string | undefined, windowsSessionId: 1, desktop: context.desktop };
  // Issuer-private records include lifetimes, not just recycled PID/HWND/path.
  const targets = new Map<string, typeof live>();
  let entries: CollectedApp[] = [{ displayName: 'AA音乐', aliases: ['QQ音乐'], launchSpec: {
    kind: 'exe', executable: 'C:\\Synthetic\\Music.exe', args: [] }, source: 'synthetic-menu',
    version: '1', publisher: 'Synthetic Publisher', contentFingerprint: identity.fingerprint }];
  const collection = () => ({ scope, entries, coverage: [{ source: 'synthetic-menu',
    status: offline ? 'unavailable' as const : 'complete' as const, inspected: entries.length, rejected: 0 }] });
  const discovery = new ScopedAppDiscovery(scope, { scope, collect: async () => { counters.scans++; return collection(); },
    inspectPath: async path => ({ ...collection(), entries: entries.filter(item => item.launchSpec.kind === 'exe' && item.launchSpec.executable === path) }) });
  const backend: ManagedAppLaunchBackend = { scope, inspect: async launchSpec => { counters.inspections++;
    return { scope, launchSpec, identity }; }, async open(signal): Promise<AppLaunchExecution> {
    const instance = (profile: EnvironmentAppBinding): AppInstanceEvidence[] => profile.launchSpec.kind === 'package' || !running ? [] : [{
      ...context, targetToken: issueTarget(), identity: live.identity, executable: live.executable, args: live.args, workingDirectory: live.workingDirectory,
      processOwnedByInstallation: true, windowOwnedByProcess: true, sameUser: true, permissionsCompatible: true }];
    return { context, assertCurrent: async () => { if (signal.aborted || stale) throw new Error('synthetic-cancelled-or-stale'); },
      inspect: launchSpec => backend.inspect(launchSpec, signal), instances: async profile => instance(profile),
      start: async profile => { counters.starts++; running = true;
        if (profile.launchSpec.kind !== 'package') live = { ...live, executable: profile.launchSpec.executable,
          args: profile.launchSpec.args, workingDirectory: profile.launchSpec.workingDirectory };
        return 'synthetic-owned'; },
      observe: async profile => { await beforeObserve?.(); return instance(profile); },
      cleanupOwned: async () => { running = false; }, close: async () => {} };
  } };
  function issueTarget() {
    const token = `synthetic-target-${live.birth}-${live.windowBirth}`;
    if (!targets.has(token)) targets.set(token, structuredClone(live));
    return token;
  }
  const store = new SqliteEnvironmentAppStore(join(dir, 'environment-apps.sqlite'));
  const apps = composeEnvironmentApps(store, [{ scope, discovery, launchBackend: backend }]);
  const provider: DesktopProvider = { id: target.providerId, kind: 'virtual-machine', capabilities: async () => ({}),
    discover: async () => [{ ...target, kind: 'virtual-machine' }], open: async () => ({ ...target,
      sessionId: 'task-session', instanceId: 'task-instance', inputResourceId: 'synthetic-input', capabilities: async () => ({}),
      status: async () => ({ state: stale ? 'stale' : 'open', readiness: {} }), close: async () => {} }) };
  function assertBound(binding: TaskAppRuntimeBinding) {
    const record = targets.get(binding.target.targetToken), spec = binding.profile.launchSpec;
    if (!running || stale || !record || JSON.stringify(record) !== JSON.stringify(live) ||
        JSON.stringify(binding.target.scope) !== JSON.stringify(scope) ||
        JSON.stringify(binding.profile.scope) !== JSON.stringify(scope) ||
        binding.target.sessionId !== context.sessionId || binding.target.instanceId !== context.instanceId ||
        binding.target.windowsSessionId !== live.windowsSessionId || binding.target.desktop !== live.desktop ||
        JSON.stringify(binding.target.identity) !== JSON.stringify(record.identity) ||
        JSON.stringify(binding.profile.identity) !== JSON.stringify(record.identity) || spec.kind === 'package' ||
        spec.executable !== record.executable || JSON.stringify(spec.args) !== JSON.stringify(record.args) ||
        spec.workingDirectory !== record.workingDirectory) throw new Error('synthetic-app-target-substituted');
  }
  const executor: DesktopTaskExecutor = {
    assertAvailable() { if (blocked) throw new Error('synthetic-generic-task-forbidden'); },
    taskControl: () => ({ workerEndpoint: () => 'synthetic', assertTaskAllowed() {},
      beginTask: async () => { counters.leases++; }, finishTask: async () => { counters.releases++; return false; } }),
    connectRuntime: async () => {
      counters.genericRuntime++;
      return makeWorker();
    },
    ...(options.bridge === false ? {} : { connectAppRuntime: async (session, _dir, binding) => {
      // Trusted fixture maps Provider Session to this Windows session/desktop.
      if (session.sessionId !== 'task-session' || session.instanceId !== 'task-instance' ||
          session.providerId !== scope.providerId || session.environmentId !== scope.environmentId) throw new Error('synthetic-session-mismatch');
      assertBound(binding);
      const worker = makeWorker();
      return new Proxy(worker, { get(object, key: keyof WorkerClient) {
        if (typeof object[key] !== 'function') return object[key];
        if (key === 'close') return object.close.bind(object);
        if (key === 'attach' || key === 'ensureApp') return async () => { throw new Error('synthetic-target-rebind-forbidden'); };
        return async (...args: unknown[]) => {
          if (key === 'execute') await beforeDispatch?.();
          // Atomic identity fence immediately before the simulated effect; all
          // observation/grounding/focus operations are also scoped to this target.
          assertBound(binding);
          return (object[key] as (...values: unknown[]) => unknown).apply(object, args);
        };
      } });
    } } satisfies Pick<DesktopTaskExecutor, 'connectAppRuntime'>),
  };
  function makeWorker(): WorkerClient {
      counters.runtime++;
      const window = { handle: 42, title: 'Synthetic Music', windowClass: 'Synthetic', processId: 7,
        processPath: 'C:\\Synthetic\\Music.exe', visible: true, minimized: false, foreground: true,
        targetElevated: false, rect: { left: 0, top: 0, width: 100, height: 100 } };
      return { listWindows: async () => [window], ensureApp: async () => { throw new Error('legacy-launch-forbidden'); },
        attach: async () => { counters.attaches++; }, probe: async () => ({ ...window, elevated: false, permissionsCompatible: true, uiaControls: true }),
        observe: async () => ({ windowHandle: 42, windowTitle: window.title, pageText: 'Synthetic original task continues',
          textEvidence: [{ source: 'uia', text: 'Synthetic original task continues' }], structured: { source: 'uia', complete: true, items: [] } }),
        close: async () => {}, restore: async () => {},
        recoverFocus: async () => {},
        ground: async () => ({ target: { kind: 'coordinate', x: 1, y: 1 }, attempts: [{ strategy: 'coordinate', matched: true, selected: true, detail: 'synthetic' }] }),
        resolveAction: async () => ({ selected: 'synthetic', reason: 'synthetic coordinate', candidates: [{ provider: 'synthetic', available: true, reason: 'synthetic' }] }),
        execute: async () => { counters.businessEffects++; return { ok: true, message: 'synthetic effect' }; },
      } as unknown as WorkerClient;
  }
  const sessions = new TaskDesktopSessions([provider], new Map([[provider.id, executor]]));
  const model = () => Object.assign(new FakeModel(options.actions ?? [{ kind: 'ask_user', question: 'synthetic-business-question' }]), {
    planTask: async () => { beforePlan?.(); return { task: { environment: 'windows' as const, windowHandle: 42, plan: ['original task'], completionCriteria: {} } }; },
    planStage: async () => ({ goal: 'original task', successCondition: 'business result', isFinal: true }),
    verifyStage: async () => ({ ok: false, confidence: 1, evidence: 'synthetic-business-not-complete', source: 'uia' as const }),
  }) as unknown as PlanningModel;
  const controller = new DesktopTaskController(dir, { environmentApps: apps, desktopSessions: sessions,
    modelProvider: { createModel: () => { counters.models++; return model(); } } });
  const trace = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
  const submit = () => controller.submit('使用 AA音乐 搜索合成歌曲', { desktopTarget: target,
    budget: { deepseek: { maxCalls: 7, maxTokens: 5000 } } });
  const wait = async (id: string, predicate: (state: NonNullable<ReturnType<typeof trace.load>>) => boolean) => {
    for (let i = 0; i < 500; i++) {
      const state = trace.load(id); if (state && predicate(state)) return state;
      await new Promise(done => setTimeout(done, 10));
    }
    throw new Error(`synthetic task timeout: ${JSON.stringify(trace.load(id))}`);
  };
  return { dir, target, scope, counters, trace, apps, store, controller, discovery, submit, wait,
    setEntries: (value: CollectedApp[]) => { entries = value; }, entries: () => structuredClone(entries),
    offline: () => { offline = true; }, stale: () => { stale = true; }, block: () => { blocked = true; },
    restoreEnvironment: () => { offline = stale = blocked = false; },
    replaceTarget: (kind: 'process' | 'window' | 'binary' | 'args' | 'cwd' | 'desktop' = 'process') => {
      live = { ...live, ...(kind === 'process' ? { birth: live.birth + 1 } : kind === 'window' ? { windowBirth: live.windowBirth + 1 } :
        kind === 'binary' ? { identity: { ...identity, fingerprint: 'replacement-binary' } } : kind === 'args' ? { args: ['--replacement'] } :
        kind === 'cwd' ? { workingDirectory: 'C:\\Replacement' } : { desktop: 'ReplacementDesktop' }) };
    },
    beforePlan: (hook: () => void) => { beforePlan = hook; },
    beforeDispatch: (hook: () => Promise<void>) => { beforeDispatch = hook; },
    beforeObserve: (hook: () => Promise<void>) => { beforeObserve = hook; },
    close: async () => { await controller.close(); await apps.close(); trace.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
