import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import type { EnvironmentAppScope } from '../contracts/environment-apps.js';
import type { WorkbenchAppConfig } from './workbench-apps.js';
import { AppLaunchError } from '../environment-apps/launcher.js';

export interface WorkbenchAppClient { call<T>(method: string, fields?: object): Promise<T>; close(): Promise<void>; }
export class NativeWorkbenchAppClient implements WorkbenchAppClient {
  private child?: ChildProcessWithoutNullStreams;
  private next = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private failed = false;
  constructor(private readonly config: WorkbenchAppConfig | undefined, private readonly scope: EnvironmentAppScope,
    private readonly registry: string, private readonly project: string) {}
  private async initialize() {
    if (this.failed) throw Error('workbench-app-worker-unavailable');
    if (this.child) return;
    const child = this.child = spawn('python', [resolve(this.project, 'src/desktop-provider/workbench_app_worker.py')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const fail = () => { this.failed = true; for (const waiter of this.pending.values()) waiter.reject(Error('workbench-app-worker-disconnected')); this.pending.clear(); };
    child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail); child.stderr.on('data', () => {});
    createInterface({ input: child.stdout }).on('line', line => {
      if (Buffer.byteLength(line) > 131072) { child.kill(); fail(); return; }
      let value: any; try { value = JSON.parse(line); } catch { child.kill(); fail(); return; }
      const waiter = this.pending.get(value.id); if (!waiter) return; this.pending.delete(value.id);
      if (value.error && value.diagnostic) console.error('Workbench native diagnostic:', JSON.stringify(value.diagnostic));
      if (value.error) waiter.reject(new AppLaunchError(['stale', 'unavailable', 'unknown'].includes(value.failureKind) ? value.failureKind
        : value.error === 'workbench-installation-changed' ? 'stale'
        : value.error === 'workbench-native-operation-failed' ? 'unknown' : 'unavailable', value.error)); else waiter.resolve(value.result);
    });
    await this.send('init', { config: this.config, scope: this.scope, registry: this.registry });
  }
  private send<T>(method: string, fields: object = {}): Promise<T> {
    const id = ++this.next;
    return new Promise((resolveReply, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.failed = true; this.child?.kill(); reject(Error('workbench-app-worker-timeout')); }, 15000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolveReply(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.child!.stdin.write(JSON.stringify({ id, method, fields }) + '\n');
    });
  }
  async call<T>(method: string, fields: object = {}): Promise<T> { await this.initialize(); return this.send<T>(method, fields); }
  async close() {
    const child = this.child; if (!child) return;
    if (!this.failed) await this.send('close');
    child.stdin.end();
    if (child.exitCode === null) await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error('workbench-app-worker-close-unconfirmed')); }, 3000);
      child.once('exit', () => { clearTimeout(timer); done(); });
    });
  }
}
