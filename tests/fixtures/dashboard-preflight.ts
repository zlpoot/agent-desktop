import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DesktopProvider } from '../../src/contracts/desktop-environment.js';
import { createDashboardPreflight } from '../../src/composition/dashboard-preflight.js';
import { createDashboardServer } from '../../src/app/server.js';

export async function preflightFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'p8a-synthetic-'));
  const config = join(dir, 'operator.json'); writeFileSync(config, '{}');
  let opens = 0;
  const scopes = [
    { providerId: 'physical', environmentId: 'synthetic-host', kind: 'physical' as const },
    { providerId: 'local-workspace', environmentId: 'synthetic-workspace', kind: 'local-workspace' as const },
    { providerId: 'hyper-v', environmentId: 'synthetic-guest', kind: 'virtual-machine' as const },
  ];
  const hooks: { beforeCapabilities?: (id: string) => Promise<void> } = {};
  const providers: DesktopProvider[] = scopes.map(scope => ({ id: scope.providerId, kind: scope.kind,
    discover: async () => [scope], capabilities: async () => {
      await hooks.beforeCapabilities?.(scope.providerId);
      return { 'input.globalInput': [{ state: 'forbidden', scope: {} }],
        'input.rawIsolated': [{ state: 'not-proven', scope: {} }],
        'isolation.separateOs': [{ state: 'unsupported', scope: {} }] };
    }, open: async () => { opens++; throw new Error('synthetic-must-not-open'); } }));
  const assembly = await createDashboardPreflight(config, dir, { providers, hostLabel: 'Synthetic Host', installationScopeId: 'synthetic-domain' });
  const server = createDashboardServer(dir, assembly.controller, undefined, undefined, undefined, undefined, assembly.view);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
  const base = `http://127.0.0.1:${address.port}`;
  return { dir, config, scopes, hooks, assembly, base, opens: () => opens,
    post: (body: object, origin: string | null = base) => fetch(`${base}/api/desktop/apps`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) }),
    async close() { await new Promise<void>(done => server.close(() => done())); await assembly.close(); rmSync(dir, { recursive: true, force: true }); } };
}
