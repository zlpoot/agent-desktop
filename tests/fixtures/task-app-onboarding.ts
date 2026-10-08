import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollectedApp } from '../../src/contracts/app-discovery.js';
import type { AppLaunchExecution, AppInstanceEvidence, ManagedAppLaunchBackend } from '../../src/contracts/app-launch.js';
import type { EnvironmentAppBinding } from '../../src/contracts/environment-apps.js';
import type { DesktopProvider } from '../../src/contracts/desktop-environment.js';
import type { WorkerClient } from '../../src/contracts/worker-client.js';
import type { PlanningModel } from '../../src/contracts/model-provider.js';
import { composeEnvironmentApps } from '../../src/composition/environment-apps.js';
import { ScopedAppDiscovery } from '../../src/environment-apps/discovery.js';
import { SqliteEnvironmentAppStore } from '../../src/environment-apps/sqlite-registry.js';
import { DesktopTaskController } from '../../src/app/task-runner.js';
import { TaskDesktopSessions } from '../../src/app/task-desktop-sessions.js';
import { FakeModel } from '../../src/agent/model-adapter.js';
import { SqliteTrace } from '../../src/trace/sqlite-trace.js';

export async function taskAppFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'task-app-synthetic-'));
  const target = { providerId: 'synthetic-provider', environmentId: 'selected-environment' };
  const scope = { ...target, installationScopeId: 'synthetic-installation' };
  const identity = { productId: 'synthetic-app', version: '1', fingerprint: 'synthetic-binary' };
  const counters = { scans: 0, inspections: 0, starts: 0, leases: 0, releases: 0, models: 0, runtime: 0, resumes: 0 };
  let offline = false, stale = false, blocked = false, running = false;
  let beforeObserve: (() => Promise<void>) | undefined;
  let entries: CollectedApp[] = [{ displayName: 'AA音乐', aliases: ['QQ音乐'], launchSpec: {
    kind: 'exe', executable: 'C:\\Synthetic\\Music.exe', args: [] }, source: 'synthetic-menu',
    version: '1', publisher: 'Synthetic Publisher', contentFingerprint: identity.fingerprint }];
  const collection = () => ({ scope, entries, coverage: [{ source: 'synthetic-menu',
    status: offline ? 'unavailable' as const : 'complete' as const, inspected: entries.length, rejected: 0 }] });
  const discovery = new ScopedAppDiscovery(scope, { scope, collect: async () => { counters.scans++; return collection(); },
    inspectPath: async path => ({ ...collection(), entries: entries.filter(item => item.launchSpec.kind === 'exe' && item.launchSpec.executable === path) }) });
  const backend: ManagedAppLaunchBackend = { scope, inspect: async launchSpec => { counters.inspections++;
    return { scope, launchSpec, identity }; }, async open(signal): Promise<AppLaunchExecution> {
    const context = { scope, sessionId: 'managed-reservation', instanceId: 'launch-helper', windowsSessionId: 1, desktop: 'SyntheticDesktop' };
    const instance = (profile: EnvironmentAppBinding): AppInstanceEvidence[] => profile.launchSpec.kind === 'package' || !running ? [] : [{
      ...context, targetToken: 'synthetic-target', identity, executable: profile.launchSpec.executable, args: profile.launchSpec.args,
      processOwnedByInstallation: true, windowOwnedByProcess: true, sameUser: true, permissionsCompatible: true }];
    return { context, assertCurrent: async () => { if (signal.aborted || stale) throw new Error('synthetic-cancelled-or-stale'); },
      inspect: launchSpec => backend.inspect(launchSpec, signal), instances: async profile => instance(profile),
      start: async () => { counters.starts++; running = true; return 'synthetic-owned'; },
      observe: async profile => { await beforeObserve?.(); return instance(profile); },
      cleanupOwned: async () => { running = false; }, close: async () => {} };
  } };
  const store = new SqliteEnvironmentAppStore(join(dir, 'environment-apps.sqlite'));
  const apps = composeEnvironmentApps(store, [{ scope, discovery, launchBackend: backend }]);
  const provider: DesktopProvider = { id: target.providerId, kind: 'virtual-machine', capabilities: async () => ({}),
    discover: async () => [{ ...target, kind: 'virtual-machine' }], open: async () => ({ ...target,
      sessionId: 'task-session', instanceId: 'task-instance', inputResourceId: 'synthetic-input', capabilities: async () => ({}),
      status: async () => ({ state: stale ? 'stale' : 'open', readiness: {} }), close: async () => {} }) };
  const sessions = new TaskDesktopSessions([provider], new Map([[provider.id, {
    assertAvailable() { if (blocked) throw new Error('synthetic-generic-task-forbidden'); },
    taskControl: () => ({ workerEndpoint: () => 'synthetic', assertTaskAllowed() {},
      beginTask: async () => { counters.leases++; }, finishTask: async () => { counters.releases++; return false; } }),
    connectRuntime: async () => {
      counters.runtime++;
      const window = { handle: 42, title: 'Synthetic Music', windowClass: 'Synthetic', processId: 7,
        processPath: 'C:\\Synthetic\\Music.exe', visible: true, minimized: false, foreground: true,
        targetElevated: false, rect: { left: 0, top: 0, width: 100, height: 100 } };
      return { listWindows: async () => [window], ensureApp: async () => { throw new Error('legacy-launch-forbidden'); },
        attach: async () => {}, probe: async () => ({ ...window, elevated: false, permissionsCompatible: true, uiaControls: true }),
        observe: async () => ({ windowHandle: 42, windowTitle: window.title, pageText: 'Synthetic original task continues',
          textEvidence: [{ source: 'uia', text: 'Synthetic original task continues' }], structured: { source: 'uia', complete: true, items: [] } }),
        close: async () => {}, restore: async () => {},
      } as unknown as WorkerClient;
    },
  }]]));
  const model = () => Object.assign(new FakeModel([{ kind: 'ask_user', question: 'synthetic-business-question' }]), {
    planTask: async () => ({ task: { environment: 'windows' as const, windowHandle: 42, plan: ['original task'], completionCriteria: {} } }),
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
    beforeObserve: (hook: () => Promise<void>) => { beforeObserve = hook; },
    close: async () => { await controller.close(); await apps.close(); trace.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
