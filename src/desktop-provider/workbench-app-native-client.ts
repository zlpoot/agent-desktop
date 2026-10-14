import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { lstat, open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { AppWindowPreview } from '../contracts/environment-apps.js';
import type { EnvironmentAppScope } from '../contracts/environment-apps.js';
import type { WorkbenchAppConfig } from './workbench-apps.js';
import { AppLaunchError } from '../environment-apps/launcher.js';

export interface WorkbenchAppClient { call<T>(method: string, fields?: object): Promise<T>; close(): Promise<void>; }
export class NativeWorkbenchAppClient implements WorkbenchAppClient {
  private child?: ChildProcessWithoutNullStreams;
  private next = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private failed = false;
  private previewDirectory?: string;
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
    const initialized = await this.send<{ previewDirectory?: string }>('init', { config: this.config, scope: this.scope, registry: this.registry });
    if (initialized.previewDirectory && /^[a-f0-9]{32}$/.test(initialized.previewDirectory)) this.previewDirectory = initialized.previewDirectory;
  }
  private send<T>(method: string, fields: object = {}): Promise<T> {
    const id = ++this.next;
    return new Promise((resolveReply, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.failed = true; this.child?.kill(); reject(Error('workbench-app-worker-timeout')); }, 15000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolveReply(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.child!.stdin.write(JSON.stringify({ id, method, fields }) + '\n');
    });
  }
  private async readPreview(value: any): Promise<AppWindowPreview> {
    if (!this.previewDirectory || !value || typeof value.token !== 'string' || !/^[a-f0-9]{32}$/.test(value.token) ||
        typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
        !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 1 || value.height < 1 || value.width > 2048 || value.height > 2048) throw Error('workbench-preview-invalid');
    const root = resolve(this.project, '.artifacts/workbench-app-preview');
    const directory = resolve(root, this.previewDirectory), path = resolve(directory, value.token + '.png');
    let ownedFile = false;
    try {
      for (const folder of [root, directory]) { const info = await lstat(folder); if (!info.isDirectory() || info.isSymbolicLink()) throw Error('workbench-preview-invalid'); }
      const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw Error('workbench-preview-invalid');
      ownedFile = true;
      if (info.size < 24 || info.size > 4194304) throw Error('workbench-preview-invalid');
      const handle = await open(path, 'r');
      let png: Buffer;
      try {
        const buffer = Buffer.alloc(4194305);
        let size = 0;
        while (size < buffer.length) { const part = await handle.read(buffer, size, buffer.length - size, size); if (!part.bytesRead) break; size += part.bytesRead; }
        if (size !== info.size || size > 4194304) throw Error('workbench-preview-size-limit');
        png = buffer.subarray(0, size);
      } finally { await handle.close(); }
      if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || png.toString('ascii', 12, 16) !== 'IHDR' ||
          png.readUInt32BE(16) !== value.width || png.readUInt32BE(20) !== value.height || createHash('sha256').update(png).digest('hex') !== value.sha256 ||
          !Number.isFinite(Date.parse(value.capturedAt)) || Date.now() - Date.parse(value.capturedAt) > 5000 ||
          !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) throw Error('workbench-preview-invalid-or-expired');
      return { png: png.toString('base64'), width: value.width, height: value.height, capturedAt: value.capturedAt, expiresAt: value.expiresAt };
    } finally { if (ownedFile) await unlink(path).catch(() => {}); }
  }
  async call<T>(method: string, fields: object = {}): Promise<T> {
    await this.initialize();
    const result = await this.send<T>(method, fields);
    if (method === 'task_observe' && (result as any)?.capture) {
      const value = result as any;
      const capture = value.capture;
      const preview = await this.readPreview(capture);
      return { observation: value.observation, preview: { png: preview.png, sha256: capture.sha256 } } as T;
    }
    return method === 'preview' ? await this.readPreview(result) as T : result;
  }
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
