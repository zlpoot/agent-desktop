import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DesktopProvider, DesktopCapabilities } from '../../src/contracts/desktop-environment.js';
import { createDashboardPreflight } from '../../src/composition/dashboard-preflight.js';
import { createDashboardServer } from '../../src/app/server.js';
import type { AppCollection, AppDiscoveryCollector } from '../../src/contracts/app-discovery.js';

export async function preflightFixture(options: { mode?: 'a2'; identity?: string | Error } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'p8a-synthetic-'));
  const config = join(dir, 'operator.json'); writeFileSync(config, '{}');
  let opens = 0;
  const scopes = [
    { providerId: 'physical', environmentId: 'synthetic-host', kind: 'physical' as const },
    { providerId: 'local-workspace', environmentId: 'synthetic-workspace', kind: 'local-workspace' as const },
    { providerId: 'hyper-v', environmentId: 'synthetic-guest', kind: 'virtual-machine' as const },
  ];
  const calls: { action: string; path?: string }[] = [];
  const hooks: { beforeCapabilities?: (id: string) => Promise<void>; capabilities?: DesktopCapabilities;
    collect?: (scope: AppDiscoveryCollector['scope'], path?: string) => Promise<AppCollection> } = {};
  const providers: DesktopProvider[] = scopes.map(scope => ({ id: scope.providerId, kind: scope.kind,
    discover: async () => [scope], capabilities: async () => {
      await hooks.beforeCapabilities?.(scope.providerId);
      return hooks.capabilities ?? { 'input.globalInput': [{ state: 'forbidden', scope: {} }],
        'input.rawIsolated': [{ state: 'not-proven', scope: {} }],
        'isolation.separateOs': [{ state: 'unsupported', scope: {} }] };
    }, open: async () => { opens++; throw new Error('synthetic-must-not-open'); } }));
  let identityReads = 0;
  const assembly = await createDashboardPreflight(config, dir, { providers, hostLabel: 'Synthetic Host', installationScopeId: 'synthetic-domain' },
    options.mode === 'a2' ? { identity: async () => {
      identityReads++; if (options.identity instanceof Error) throw options.identity;
      return options.identity ?? `windows:${'a'.repeat(64)}`;
    }, collector: scope => {
      const collect = async (path?: string): Promise<AppCollection> => {
        calls.push({ action: path === undefined ? 'scan' : 'path', ...(path === undefined ? {} : { path }) });
        return hooks.collect ? hooks.collect(scope, path) : { scope, entries: [
          { displayName: '合成音乐', aliases: ['Synthetic Music'], version: '1.0', publisher: 'Synthetic Publisher',
            launchSpec: { kind: 'exe', executable: 'C:\\Synthetic\\Music.exe', args: [] },
            source: path ? 'manual-path' : 'app-paths-hkcu', contentFingerprint: 'synthetic-file-digest' },
        ], coverage: [{ source: path ? 'manual-path' : 'app-paths-hkcu', status: 'complete', inspected: 1, rejected: 0 }] };
      };
      return { scope, collect: () => collect(), inspectPath: path => collect(path) };
    } } : undefined);
  const server = createDashboardServer(dir, assembly.controller, undefined, undefined, undefined, undefined, assembly.view);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
  const base = `http://127.0.0.1:${address.port}`;
  return { dir, config, scopes, hooks, assembly, base, calls, identityReads: () => identityReads, opens: () => opens,
    post: (body: object, origin: string | null = base) => fetch(`${base}/api/desktop/apps`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) }),
    async close() { await new Promise<void>(done => server.close(() => done())); await assembly.close(); rmSync(dir, { recursive: true, force: true }); } };
}
