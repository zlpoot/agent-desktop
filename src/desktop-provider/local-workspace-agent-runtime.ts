import { randomUUID } from 'node:crypto';
import type { ComputerAction, GroundingResult, Observation, Target } from '../actions/schema.js';
import { singleProvider } from '../actions/action-resolution.js';
import type { WorkerClient } from '../contracts/worker-client.js';
import type { DesktopRuntimeOptions, WindowInfo } from '../runtime/desktop/desktop-runtime.js';
import type { LocalWorkspaceRuntime } from './local-workspace-provider.js';

/** Same Task-owned D0 window only. No P7 receipt, second launch, global input or visual fallback. */
export class LocalWorkspaceAgentRuntime implements WorkerClient {
  readonly name = 'Local Workspace NetEase · dynamic UIA';
  private attached = false;
  private closed = false;
  private window?: WindowInfo;
  private observation?: Observation;
  private busy = false;
  constructor(private readonly runtime: LocalWorkspaceRuntime, private readonly allowed: () => void) {}
  private check() { if (this.closed) throw Error('local-workspace-agent-closed'); this.allowed(); }
  async listWindows() {
    this.check();
    this.window = await this.runtime.inspectWindow!(); this.check();
    return [structuredClone(this.window)];
  }
  async ensureApp(id: string) {
    if (id !== 'netease') throw Error('local-workspace-agent-app-mismatch');
    const [window] = await this.listWindows(); // Provider.open already launched this exact owned instance.
    return { handle: window.handle, title: window.title };
  }
  async attach(options: DesktopRuntimeOptions) {
    const [window] = await this.listWindows();
    if (options.windowHandle === undefined && options.windowTitle === undefined && options.windowClass === undefined ||
        options.windowHandle !== undefined && options.windowHandle !== window.handle ||
        options.windowTitle !== undefined && options.windowTitle !== window.title ||
        options.windowClass !== undefined && options.windowClass !== window.windowClass ||
        options.processId !== undefined && options.processId !== window.processId ||
        options.processPath !== undefined && options.processPath !== window.processPath) throw Error('local-workspace-agent-target-mismatch');
    this.attached = true; this.observation = undefined;
  }
  async observe() {
    this.check(); if (!this.attached) throw Error('local-workspace-agent-not-attached');
    this.observation = undefined;
    const observation = await this.runtime.observe(); this.check();
    if (!this.window || observation.windowHandle !== this.window.handle) throw Error('local-workspace-agent-window-changed');
    this.observation = observation; return observation;
  }
  async probe(_focus = false) {
    const [window] = await this.listWindows();
    return { ...window, title: window.title, elevated: false, permissionsCompatible: window.targetElevated === false,
      uiaControls: true };
  }
  async recoverFocus() {
    this.check(); throw Error('local-workspace-agent-global-focus-forbidden');
  }
  async restore(observation: Observation) {
    await this.attach({ windowHandle: observation.windowHandle });
    await this.observe(); // Fresh observation, never replay the saved action.
  }
  private target(action: ComputerAction): Target | undefined {
    if (!('target' in action) || !action.target || action.target.kind !== 'role' || !this.observation ||
        !action.target.name && !(action.kind === 'type' && action.target.role === 'edit')) return;
    const target = action.target;
    const matches = this.observation.structured?.items.filter(item => item.role === target.role &&
      (target.name === undefined || item.name === target.name));
    return matches?.length === 1 ? target : undefined;
  }
  async ground(action: ComputerAction): Promise<GroundingResult> {
    this.check();
    const target = this.target(action);
    return { target, attempts: [{ strategy: 'role', matched: !!target, selected: !!target,
      detail: target ? 'Unique control in the current owned UIA observation' : 'Missing/ambiguous semantic control; coordinates and fallback forbidden' }] };
  }
  async resolveAction(action: ComputerAction) {
    this.check();
    const supported = ['type', 'click', 'set_checked'].includes(action.kind) && !!this.target(action);
    const reason = supported ? 'Owned-window semantic input only; native effect fence remains mandatory' : 'Action outside the bounded NetEase connector';
    return supported ? singleProvider('local-workspace.netease', reason) :
      { selected: '', reason, candidates: [{ provider: 'local-workspace.netease', available: false, reason }] };
  }
  async execute(action: ComputerAction, _resolution?: unknown, actionId = randomUUID()) {
    this.check();
    if (this.busy) throw Error('local-workspace-agent-dispatch-busy');
    const target = this.target(action);
    if (!target) return { ok: false, effect: 'none' as const, message: 'local-workspace-agent-target-missing-or-ambiguous' };
    this.busy = true;
    try {
      // Model latency never renews an old token. Reobserve, uniquely locate again, then dispatch once.
      await this.observe();
      if (!this.target(action)) return { ok: false, effect: 'none' as const, message: 'local-workspace-agent-target-changed' };
      if (action.kind === 'set_checked') {
        if (!action.checked) return { ok: false, effect: 'none' as const, message: 'netease-unfavorite-forbidden' };
        // No toggle on "already true"; missing native state is UNKNOWN, not false.
        const item = this.observation!.structured!.items.find(item => item.role === (target as { role: string }).role && item.name === (target as { name?: string }).name)!;
        if (item.checked === true && item.complete === true) return { ok: true, effect: 'none' as const, message: 'Native state already checked; no toggle dispatched' };
        return { ok: false, effect: 'none' as const, message: 'netease-favorite-state-unavailable: no proven native favorite effect' };
      }
      if (!this.runtime.executeAction) throw Error('local-workspace-agent-action-unavailable');
      const result = await this.runtime.executeAction(action, actionId);
      this.observation = undefined;
      return result;
    } finally { this.busy = false; }
  }
  async close() { this.closed = true; this.observation = undefined; await this.runtime.close(); }
}
