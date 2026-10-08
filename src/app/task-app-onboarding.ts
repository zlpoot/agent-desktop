import { randomUUID } from 'node:crypto';
import type { ComputerState } from '../graph/state.js';
import type { EnvironmentAppServices, EnvironmentAppBinding } from '../contracts/environment-apps.js';
import type { ReadonlyAppDiscovery, DiscoveredApp } from '../contracts/app-discovery.js';
import type { AppLaunchOutcome } from '../contracts/app-launch.js';
import { sameDesktopTarget } from '../contracts/task-desktop.js';
import { sameAppScope, textValue } from '../environment-apps/validation.js';

import type { TaskAppInteraction, TaskAppRequest } from '../contracts/task-app-onboarding.js';
export type { TaskAppInteraction, TaskAppRequest } from '../contracts/task-app-onboarding.js';
/** Conservative, zero-model name extraction. Quoted names support spaces; no path or command inference. */
export function requestedApp(goal: string): string | undefined {
  const match = goal.match(/^(?:请\s*)?(?:使用|用|打开|启动|use\s+|open\s+)(?:\s*)[“"]([^”"\n]{1,120})[”"]/i)
    ?? goal.match(/^(?:请\s*)?(?:使用|用|打开|启动)\s*([\p{L}\p{N}_.+-]{1,80}?(?:音乐|浏览器|记事本))(?=\s|[，,。]|搜索|播放|打开|来|帮|$)/u)
    ?? goal.match(/^(?:请\s*)?(?:使用|用|打开|启动)\s*([\p{L}\p{N}_.+-]{1,80})(?=\s|[，,。]|$)/u)
    ?? goal.match(/^(?:请\s*)?在\s*([\p{L}\p{N}_.+-]{1,80}?)\s*(?:中|里)(?=搜索|播放|打开|\s)/u)
    ?? goal.match(/^(?:use|open)\s+([a-z\d_.+-]{1,80})(?=\s|[,.:]|$)/i);
  return match?.[1];
}
type Ports = {
  load(taskId: string): ComputerState;
  save(node: string, state: ComputerState): void;
  guard(state: ComputerState): Promise<void>;
  resume(taskId: string): void;
};
/** Setup-only coordinator. It never owns input, calls a model, or resumes a dispatched graph. */
export class TaskAppOnboarding {
  private readonly busy = new Map<string, Promise<TaskAppInteraction>>();
  private readonly receipts = new Map<string, AppLaunchOutcome>();
  private readonly cancellations = new Map<string, () => void>();
  private closed = false;
  constructor(private readonly apps: EnvironmentAppServices | undefined, private readonly ports: Ports) {}
  private service(state: ComputerState) {
    if (!state.desktopTarget || state.desktopScenario || state.desktopCompatibility) throw new Error('app-onboarding-task-ineligible');
    const service = this.apps?.forEnvironment(state.desktopTarget);
    if (!service?.onboarding || typeof (service.discovery as ReadonlyAppDiscovery)?.query !== 'function') {
      throw new Error('app-onboarding-service-unavailable');
    }
    service.registry.list();
    if (!sameDesktopTarget(state.desktopTarget, service.registry.scope) ||
        !sameAppScope(service.registry.scope, service.discovery!.scope) ||
        state.appOnboarding?.scope && !sameAppScope(state.appOnboarding.scope, service.registry.scope)) {
      throw new Error('app-onboarding-scope-changed');
    }
    return service as typeof service & { discovery: ReadonlyAppDiscovery; onboarding: NonNullable<typeof service.onboarding> };
  }
  private eligible(state: ComputerState): void {
    if (this.closed || ['done', 'failed', 'stopped'].includes(state.status) || state.recoveryRequired || state.recoveryUncertain || state.inFlightAction || state.verificationPending ||
        state.step !== 0 || state.observation || state.desktopBinding || state.desktopScenario) {
      throw new Error('app-onboarding-new-task-required');
    }
  }
  private write(state: ComputerState, app: TaskAppInteraction, node = 'app_onboarding'): TaskAppInteraction {
    this.ports.save(node, { ...state, appOnboarding: app,
      status: app.state === 'cancelled' ? 'stopped' : ['ready', 'reusing'].includes(app.state) ? 'running' : 'waiting_user',
      summary: app.state === 'ready' ? '应用配置已验证，继续原任务；业务结果仍需独立验收' :
        app.state === 'cancelled' ? '用户取消应用接入与原任务' : `应用接入：${app.appName} · ${app.reason ?? app.state}` });
    return structuredClone(app);
  }
  private display(item: DiscoveredApp): TaskAppInteraction['candidates'][number] {
    const spec = item.candidate.launchSpec;
    return { candidateId: item.candidateId, candidateRevision: item.revision, displayName: item.candidate.displayName,
      path: spec.kind === 'package' ? spec.applicationUserModelId : spec.kind === 'shortcut' ? spec.shortcutPath : spec.executable,
      args: spec.kind === 'package' ? [] : spec.args, workingDirectory: spec.kind === 'package' ? undefined : spec.workingDirectory,
      sources: item.sources, version: item.version, publisher: item.publisher, limitation: item.limitation };
  }
  private async current(taskId: string, interactionId: string): Promise<ComputerState> {
    let state = this.ports.load(taskId);
    this.eligible(state);
    if (!state.appOnboarding || state.appOnboarding.taskId !== taskId || state.appOnboarding.interactionId !== interactionId ||
        state.status !== 'waiting_user' && !(state.status === 'running' && state.appOnboarding.state === 'reusing')) {
      throw new Error('app-onboarding-interaction-expired');
    }
    await this.ports.guard(state);
    state = this.ports.load(taskId); this.eligible(state);
    if (state.appOnboarding?.interactionId !== interactionId ||
        state.status !== 'waiting_user' && !(state.status === 'running' && state.appOnboarding.state === 'reusing')) throw new Error('app-onboarding-interaction-expired');
    return state;
  }
  async beforeRun(taskId: string): Promise<EnvironmentAppBinding | false | undefined> {
    let state = this.ports.load(taskId);
    if (!state.desktopTarget) return undefined;
    const name = state.appOnboarding?.appName ?? requestedApp(state.goal);
    if (!name) return undefined;
    this.eligible(state);
    if (state.appOnboarding?.state === 'ready') {
      await this.ports.guard(state);
      const profile = this.service(state).registry.get(state.appOnboarding.appBindingId!);
      const receipt = this.receipts.get(state.appOnboarding.interactionId);
      if (!profile || profile.validity !== 'current' || profile.availability !== 'available' || profile.trust !== 'verified' ||
          profile.profileRevision !== state.appOnboarding.profileRevision || profile.profileDigest !== state.appOnboarding.profileDigest ||
          !receipt?.target || !sameAppScope(receipt.target.scope, profile.scope)) throw new Error('app-onboarding-new-task-required');
      return profile;
    }
    const app: TaskAppInteraction = { taskId, interactionId: randomUUID(), appName: name,
      desktopTarget: state.desktopTarget, state: 'discovering', candidates: [] };
    try {
      await this.ports.guard(state); state = this.ports.load(taskId);
      this.eligible(state);
      const service = this.service(state); app.scope = service.registry.scope;
      const known = service.registry.resolveName(name);
      if (known.kind === 'unique' && known.app.validity === 'current' && known.app.trust !== 'discovered') {
        app.state = 'reusing'; this.write(state, app, 'app_profile_reuse_started');
        const operationId = `task-app:${taskId}:${app.interactionId}`;
        this.cancellations.set(taskId, () => service.onboarding.cancel({ operationId }));
        const result = await service.onboarding.reuse({ appBindingId: known.app.appBindingId,
          expectedRevision: known.app.revision, operationId }, 'task-controller');
        await this.finish(taskId, app.interactionId, known.app.appBindingId, result, false);
        return this.ports.load(taskId).appOnboarding?.state === 'ready' ? this.beforeRun(taskId) : false;
      }
      this.write(state, app);
      await this.scan(taskId, app.interactionId);
    } catch (error) {
      const current = this.ports.load(taskId);
      if ((!current.appOnboarding || current.appOnboarding.interactionId === app.interactionId) && ['running', 'waiting_user'].includes(current.status)) {
        this.write(current, { ...(current.appOnboarding ?? app),
          state: /binding|scope-changed|new-task-required/.test(String(error)) ? 'new_task_required' : 'unavailable', reason: String(error) });
      }
    } finally { this.cancellations.delete(taskId); }
    return false;
  }
  private async scan(taskId: string, id: string, path?: string): Promise<TaskAppInteraction> {
    const state = await this.current(taskId, id), service = this.service(state);
    let matches: readonly DiscoveredApp[], status: TaskAppInteraction['state'], reason: string | undefined;
    if (path !== undefined) {
      const result = await service.discovery.inspectPath(path);
      matches = result.snapshot ? [result.snapshot] : []; status = matches.length ? 'candidates' : 'unavailable'; reason = result.reason;
    } else {
      const result = await service.discovery.query(state.appOnboarding!.appName);
      matches = result.matches; status = matches.length ? 'candidates' : result.kind === 'unavailable' ? 'unavailable' : 'not_found';
      reason = result.report.reason;
    }
    const current = await this.current(taskId, id); this.service(current);
    return this.write(current, { ...current.appOnboarding!, scope: service.registry.scope, state: status,
      candidates: matches.map(item => this.display(item)), reason, interactionId: randomUUID() });
  }
  async act(taskId: string, value: TaskAppRequest): Promise<TaskAppInteraction> {
    const allowed = ['interactionId', 'desktopTarget', 'action', ...(value?.action === 'confirm' || value?.action === 'reject'
      ? ['candidateId', 'candidateRevision'] : value?.action === 'path' ? ['path'] : [])];
    if (!value || Object.keys(value).some(key => !allowed.includes(key)) ||
        !['confirm', 'reject', 'rescan', 'path', 'cancel'].includes(value.action)) throw new Error('invalid-app-onboarding-request');
    textValue(value.interactionId);
    const state = this.ports.load(taskId), app = state.appOnboarding;
    if (!app || app.taskId !== taskId || !value.desktopTarget || Object.keys(value.desktopTarget).some(key => !['providerId', 'environmentId'].includes(key)) ||
        !sameDesktopTarget(value.desktopTarget, app.desktopTarget) || !sameDesktopTarget(value.desktopTarget, state.desktopTarget!) ||
        app.interactionId !== value.interactionId) throw new Error('app-onboarding-task-target-or-interaction-mismatch');
    if (value.action === 'cancel') {
      if (state.status !== 'waiting_user' || app.state === 'cancelled') throw new Error('app-onboarding-interaction-expired');
      this.cancellations.get(taskId)?.();
      return this.write(state, { ...app, state: 'cancelled', candidates: [] });
    }
    const key = JSON.stringify([taskId, value]);
    const old = this.busy.get(taskId);
    if (old) {
      if (value.action === 'confirm' && this.confirmKeys.get(taskId) === key) return old;
      throw new Error('app-onboarding-operation-busy');
    }
    if (value.action === 'confirm' && app.state === 'ready' && this.confirmKeys.get(taskId) === key) return structuredClone(app);
    this.confirmKeys.set(taskId, key);
    const operation = this.actBody(taskId, value).catch(error => {
      const current = this.ports.load(taskId);
      const reason = String(error);
      if (current.status === 'waiting_user' && current.appOnboarding?.interactionId === value.interactionId &&
          !/candidate-mismatch|invalid-app-text|app-path-too-long/.test(reason)) {
        this.write(current, { ...current.appOnboarding, candidates: [], interactionId: randomUUID(),
          state: /binding|scope-changed|new-task-required|forbidden|task-ineligible/.test(reason) ? 'new_task_required' : 'unavailable', reason });
      }
      throw error;
    }).finally(() => this.busy.delete(taskId));
    this.busy.set(taskId, operation);
    return operation;
  }
  private readonly confirmKeys = new Map<string, string>();
  private async actBody(taskId: string, value: TaskAppRequest): Promise<TaskAppInteraction> {
    let state = await this.current(taskId, value.interactionId);
    const app = state.appOnboarding!;
    if (value.action === 'rescan' || value.action === 'path') {
      if (value.action === 'path') { textValue(value.path); if (value.path.length > 1024) throw new Error('app-path-too-long'); }
      return this.scan(taskId, app.interactionId, value.action === 'path' ? value.path : undefined);
    }
    const selected = app.candidates.find(item => item.candidateId === value.candidateId && item.candidateRevision === value.candidateRevision);
    if (!selected || app.state !== 'candidates') throw new Error('app-onboarding-candidate-mismatch');
    if (value.action === 'reject') return this.write(state, { ...app, state: 'rejected', candidates: [], interactionId: randomUUID(),
      reason: '已拒绝；请重新扫描或指定路径，不会自动采用其他候选' });
    const service = this.service(state);
    const display = await service.onboarding.prepare({ candidateId: selected.candidateId, candidateRevision: selected.candidateRevision });
    state = await this.current(taskId, app.interactionId); this.service(state);
    this.write(state, { ...state.appOnboarding!, state: 'launching', appBindingId: display.appBindingId, profileRevision: display.profileRevision });
    this.cancellations.set(taskId, () => service.onboarding.cancel({ operationId: display.confirmationId }));
    try {
      const result = await service.onboarding.confirm({ confirmationId: display.confirmationId, digest: display.digest }, 'dashboard-local-operator');
      return await this.finish(taskId, app.interactionId, display.appBindingId, result, true);
    } finally { this.cancellations.delete(taskId); }
  }
  private async finish(taskId: string, id: string, appBindingId: string, result: AppLaunchOutcome, resume: boolean) {
    const state = await this.current(taskId, id), service = this.service(state);
    if (!result.target || result.verification.result !== 'verified' || !sameAppScope(result.target.scope, service.registry.scope)) {
      return this.write(state, { ...state.appOnboarding!, state: 'unavailable', candidates: [],
        reason: result.verification.reason ?? 'app-launch-unavailable', interactionId: randomUUID() });
    }
    const profile = service.registry.get(appBindingId)!;
    if (profile.profileRevision !== result.verification.profileRevision || profile.profileDigest !== result.verification.profileDigest ||
        profile.trust !== 'verified' || profile.validity !== 'current') throw new Error('app-onboarding-profile-changed');
    this.receipts.set(id, result);
    const app = this.write(state, { ...state.appOnboarding!, state: 'ready', appBindingId, profileRevision: profile.profileRevision,
      profileDigest: profile.profileDigest, reason: undefined, candidates: [] }, resume ? 'app_onboarding_confirmed' : 'app_profile_reused');
    if (resume) this.ports.resume(taskId);
    return app;
  }
  async close() {
    this.closed = true;
    for (const cancel of this.cancellations.values()) cancel();
    await Promise.allSettled([...this.busy.values()]);
    this.receipts.clear();
  }
}
