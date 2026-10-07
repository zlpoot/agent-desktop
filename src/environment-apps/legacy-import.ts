import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AppCandidate, EnvironmentAppBinding, EnvironmentAppRegistry } from '../contracts/environment-apps.js';
import { parseRegisteredApp } from '../runtime/desktop/app-catalog.js';
import { candidateValue, scopeValue } from './validation.js';

export type LegacyAppSource = 'apps.local.json' | 'config/agent-desktop-apps.json';

/** Explicit one-way import. Existing consumers keep read-only legacy files until migration. */
export async function importLegacyApps(rootDir: string, source: LegacyAppSource,
  registry: EnvironmentAppRegistry): Promise<readonly EnvironmentAppBinding[]> {
  const scope = scopeValue(registry?.scope);
  if (!['apps.local.json', 'config/agent-desktop-apps.json'].includes(source)) throw new Error('unknown-legacy-app-source');
  const raw: unknown = JSON.parse(await readFile(resolve(rootDir, source), 'utf8'));
  if (!Array.isArray(raw)) throw new Error('invalid-legacy-app-list');
  const apps = raw.map(parseRegisteredApp);
  if (new Set(apps.map(app => app.id)).size !== apps.length) throw new Error('duplicate-legacy-app-id');
  // Validate all entries before touching the registry. Window hints are not target identity.
  const snapshots: AppCandidate[] = apps.map(app => candidateValue({ scope,
    installationId: `legacy:${createHash('sha256').update(JSON.stringify([source, app.id])).digest('hex')}`,
    applicationId: app.id, displayName: app.name, aliases: [],
    launchSpec: { kind: 'exe', executable: app.executable, args: app.args },
    source: { kind: 'legacy-import', reference: source, observedAt: new Date().toISOString() } }, scope));
  return snapshots.map(snapshot => {
    const previous = registry.list().find(app => app.scope.installationScopeId === registry.scope.installationScopeId &&
      app.installationId === snapshot.installationId);
    return registry.discover(snapshot, previous?.revision);
  });
}
