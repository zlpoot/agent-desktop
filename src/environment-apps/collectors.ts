import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { EnvironmentAppScope } from '../contracts/environment-apps.js';
import type { AppCollection, AppDiscoveryCollector, AppScanLimits } from '../contracts/app-discovery.js';
import { sameAppScope, scopeValue, textValue } from './validation.js';

const maxReplyBytes = 2 * 1024 * 1024;
async function readReply(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok || !response.body) throw new Error(`app-query-http-${response.status}`);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > maxReplyBytes) throw new Error('app-query-reply-limit');
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } finally { await reader.cancel(); }
}
/** Trusted infrastructure configuration; neither executable nor endpoint comes from a Task/model. */
export class WindowsAppCollector implements AppDiscoveryCollector {
  readonly scope: EnvironmentAppScope;
  constructor(scope: EnvironmentAppScope, private readonly python = 'python',
    private readonly script = resolve('guest/app_discovery.py')) {
    this.scope = scopeValue(scope);
    if (scope.providerId !== 'physical') throw new Error('host-discovery-requires-physical-installation-scope');
  }
  private request(operation: 'scan' | 'inspect', limits: AppScanLimits, signal: AbortSignal, path?: string): Promise<AppCollection> {
    return new Promise((accept, reject) => {
      if (signal.aborted) { reject(new Error('app-scan-timeout')); return; }
      const child = spawn(this.python, [this.script], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const output: Buffer[] = []; let size = 0, settled = false;
      const finish = (error?: Error, result?: AppCollection) => {
        if (settled) return; settled = true; signal.removeEventListener('abort', abort);
        if (error) { child.kill(); reject(error); } else accept(result!);
      };
      const abort = () => finish(new Error('app-scan-timeout'));
      signal.addEventListener('abort', abort, { once: true });
      child.on('error', () => finish(new Error('windows-app-scanner-unavailable')));
      child.stdin.on('error', () => finish(new Error('windows-app-scanner-unavailable')));
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxReplyBytes) finish(new Error('app-query-reply-limit')); else output.push(chunk);
      });
      child.stderr.on('data', () => {}); // never expose subprocess/installation diagnostics as model text
      child.on('close', code => {
        if (settled) return;
        try {
          const reply = JSON.parse(Buffer.concat(output).toString('utf8')) as Record<string, unknown>;
          if (code !== 0 || reply.error) throw new Error(typeof reply.error === 'string' ?
            `windows-app-scanner-unavailable:${reply.error}` : 'windows-app-scanner-unavailable');
          if (reply.installationScopeId !== this.scope.installationScopeId) throw new Error('host-app-installation-identity-mismatch');
          finish(undefined, { scope: this.scope, entries: reply.entries as AppCollection['entries'],
            coverage: reply.coverage as AppCollection['coverage'] });
        } catch (error) { finish(error instanceof Error ? error : new Error('invalid-app-query-reply')); }
      });
      child.stdin.end(JSON.stringify({ operation, limits, installationScopeId: this.scope.installationScopeId,
        ...(path === undefined ? {} : { path }) }));
    });
  }
  collect(limits: AppScanLimits, signal: AbortSignal) { return this.request('scan', limits, signal); }
  inspectPath(path: string, limits: AppScanLimits, signal: AbortSignal) { return this.request('inspect', limits, signal, path); }
}
/** Negotiated application query is separate from action/control/recovery RPC. No Host fallback. */
export class GuestAppCollector implements AppDiscoveryCollector {
  readonly scope: EnvironmentAppScope;
  private readonly endpoint: string;
  constructor(scope: EnvironmentAppScope, endpoint: string, private readonly token: string, private readonly vmId: string) {
    this.scope = scopeValue(scope); textValue(token); textValue(vmId);
    if (scope.providerId !== 'hyper-v' || scope.environmentId !== `vm:${vmId.toLowerCase()}`) throw new Error('guest-app-environment-mismatch');
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('invalid-app-guest-endpoint');
    }
    this.endpoint = url.origin;
  }
  private async request(operation: 'scan' | 'inspect', limits: AppScanLimits, signal: AbortSignal, path?: string): Promise<AppCollection> {
    const options = { headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, signal,
      redirect: 'error' as const };
    const state = await readReply(await fetch(`${this.endpoint}/state`, options));
    const port = state.app_discovery as { protocolVersion?: number; scope?: EnvironmentAppScope } | undefined;
    if (state.vm_id !== this.vmId || port?.protocolVersion !== 1 || !port.scope || !sameAppScope(scopeValue(port.scope), this.scope)) {
      throw new Error('guest-app-query-unsupported-or-identity-mismatch');
    }
    const reply = await readReply(await fetch(`${this.endpoint}/apps/query`, { ...options, method: 'POST',
      body: JSON.stringify({ protocolVersion: 1, scope: this.scope, operation, limits, ...(path === undefined ? {} : { path }) }) }));
    if (reply.protocolVersion !== 1 || !sameAppScope(scopeValue(reply.scope as EnvironmentAppScope), this.scope)) {
      throw new Error('guest-app-reply-identity-mismatch');
    }
    return { scope: this.scope, entries: reply.entries as AppCollection['entries'], coverage: reply.coverage as AppCollection['coverage'] };
  }
  collect(limits: AppScanLimits, signal: AbortSignal) { return this.request('scan', limits, signal); }
  inspectPath(path: string, limits: AppScanLimits, signal: AbortSignal) { return this.request('inspect', limits, signal, path); }
}
