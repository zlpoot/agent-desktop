import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRootAssembly } from './root.js';
import { TaskDesktopSessions } from '../app/task-desktop-sessions.js';
import { LocalWorkspaceDesktopProvider } from '../desktop-provider/local-workspace-provider.js';
import { LocalWorkspaceTaskExecutor } from '../desktop-provider/local-workspace-task-executor.js';
import { ResourceInputControl } from '../desktop-provider/resource-input-control.js';
import { ScenarioWorkspace } from '../testing/scenario-workspace.js';

/** Explicit synthetic assembly. Uses the production Task queue, provider and gates;
 * no native backend, model, app discovery, VM or physical executor is registered. */
export async function createFixtureDashboard(rootDir: string) {
  mkdirSync(rootDir, { recursive: true });
  const provider = new LocalWorkspaceDesktopProvider(new ResourceInputControl(), { app: 'fixture' },
    join(rootDir, '.artifacts', 'provider'), rootDir, () => new ScenarioWorkspace(), true);
  const desktopSessions = new TaskDesktopSessions([provider],
    new Map([[provider.id, new LocalWorkspaceTaskExecutor(provider)]]));
  try {
    return await createRootAssembly({ rootDir, desktopSessions,
      extraPlugins: [{ name: 'syntheticFixtureCleanup', apply: () => () => provider.close() }],
      model: { createModel() { throw new Error('synthetic-fixture-model-disabled'); } } });
  } catch (error) { try { await desktopSessions.close(); } finally { await provider.close(); } throw error; }
}
