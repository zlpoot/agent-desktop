import { createHash } from 'node:crypto';
import type { InputAuthority } from '../contracts/desktop-input-control.js';
import type { LocalWorkspaceBackend, LocalWorkspaceAppConfig, LocalWorkspaceState, LocalWorkspaceConnection,
  LocalWorkspaceFrame } from '../desktop-provider/local-workspace-provider.js';

/** Synthetic backend behind the production Local Workspace provider/executor. No OS input. */
export class ScenarioWorkspace implements LocalWorkspaceBackend {
  readonly calls: string[] = [];
  current: LocalWorkspaceState = { status: 'ready', app: 'fixture', run_id: 'synthetic-p6-b',
    owner: 'agent', epoch: 1, control_ready: true, desktop: 'AgentD0_synthetic-p6-b', human_actions: 0 };
  instance = 'synthetic-backend-instance';
  target = 'synthetic-owned-target';
  windowsSessionId = 7;
  grant?: InputAuthority;
  token?: string;
  sequence = 0;
  /** Optional producer cadence: reads between captures reuse the same immutable frame. */
  frameIntervalMs?: number;
  frameClock = () => performance.now();
  private frameProducedAt?: number;
  acts = 0;
  autoComplete = true;
  failStop = false;
  failAct = false;
  frameHook?: () => void;
  stateHook?: () => void;
  actHook?: () => void;
  frameGate?: Promise<void>;
  startGate?: Promise<void>;
  async start(config: LocalWorkspaceAppConfig): Promise<LocalWorkspaceConnection> {
    this.calls.push('start');
    if (this.startGate) await this.startGate;
    this.current = { ...this.current, app: config.app, ...(config.app === 'netease' ? {
      app_version: '3.1.40.205461', input_ready: true } : {}) };
    return { state: structuredClone(this.current), targetId: this.target, windowsSessionId: this.windowsSessionId,
      backendInstanceId: this.instance, viewerPort: 19101, viewerToken: 'synthetic-viewer-token' };
  }
  async state() {
    this.calls.push('state'); this.stateHook?.();
    return { state: structuredClone(this.current), targetId: this.target, windowsSessionId: this.windowsSessionId,
      backendInstanceId: this.instance };
  }
  async activateGrant(_runId: string, authority: InputAuthority) {
    this.calls.push('activate'); this.grant = authority;
    this.current = { ...this.current, owner: authority.owner.kind, epoch: this.current.epoch! + 1 };
    return structuredClone(this.current);
  }
  async revokeGrant(_runId: string, authority: InputAuthority) {
    this.assertGrant(authority); this.calls.push('revoke'); this.grant = undefined;
    this.current = { ...this.current, owner: 'none', epoch: this.current.epoch! + 1 };
    return structuredClone(this.current);
  }
  private assertGrant(authority: InputAuthority) {
    if (!this.grant || JSON.stringify(this.grant) !== JSON.stringify(authority)) throw new Error('native-grant-fence');
  }
  async frame(authority: InputAuthority): Promise<LocalWorkspaceFrame> {
    this.assertGrant(authority); this.calls.push('frame');
    if (this.frameGate) await this.frameGate;
    this.frameHook?.();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
    const now = this.frameClock();
    if (this.frameIntervalMs === undefined || this.frameProducedAt === undefined || now - this.frameProducedAt >= this.frameIntervalMs) {
      this.sequence++; this.frameProducedAt = now;
    }
    this.token = `synthetic-observation-${this.calls.filter(call => call === 'frame').length}`;
    return { observationToken: this.token, validForMs: 2000 - (now - this.frameProducedAt!), png: png.toString('base64'),
      metadata: { sequence: this.sequence, width: 1, height: 1, sha256: createHash('sha256').update(png).digest('hex'),
        heartbeat: this.frameIntervalMs === undefined ? 1 : this.frameProducedAt! / 1000 }, uia: [] };
  }
  complete() {
    this.current = { ...this.current, input: 'PASS', agent_progress: this.current.app === 'fixture' ? 26 : 4,
      agent_total: this.current.app === 'fixture' ? 26 : 4, text_length: 26, clicks: 1, track_matches: true, playing: true };
  }
  async act(runId: string, epoch: number, authority: InputAuthority, observationToken: string) {
    this.actHook?.(); this.assertGrant(authority);
    if (runId !== this.current.run_id || epoch !== this.current.epoch || !this.token || observationToken !== this.token)
      throw new Error('native-observation-epoch-fence');
    this.token = undefined; this.calls.push('act'); this.acts++;
    if (this.failAct) throw new Error('synthetic-uncertain-dispatch');
    if (this.autoComplete) this.complete();
    // Deliberately report success even if the independent state has not completed.
    return { ...this.current, input: 'PASS', agent_progress: 26 };
  }
  async ping(authority: InputAuthority) { this.assertGrant(authority); }
  async stop() {
    this.calls.push('stop'); this.grant = undefined;
    this.current = { ...this.current, status: 'stopped', cleanup: this.failStop ?
      { status: 'FAIL', job_active: 1, desktop_absent: false } : { status: 'PASS', job_active: 0, desktop_absent: true } };
    return structuredClone(this.current);
  }
  viewerUrl() { return 'http://127.0.0.1:19101/#synthetic-viewer-token'; }
  setEventHandler(_handler: (event: Record<string, unknown>) => Promise<unknown>) {}
  async close() { this.calls.push('close'); }
}
