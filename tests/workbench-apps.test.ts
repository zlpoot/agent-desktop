import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRootAssembly } from '../src/composition/root.js';
import { WorkbenchApps, workbenchAppConfig, loadWorkbenchAppConfig } from '../src/desktop-provider/workbench-apps.js';
import { config, scope, FakeWorkbenchClient } from './fixtures/workbench-apps.js';

test('ordinary Root wires configured App service and App-only environment without task/model/input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-wiring-')), client = new FakeWorkbenchClient(); let models = 0;
  const provider = new WorkbenchApps(config, scope.installationScopeId, client, true);
  const root = await createRootAssembly({ rootDir: dir, workbenchApps: provider, model: { createModel() { models++; throw Error('no-model'); } } });
  try {
    const option = (await root.controller.desktopOptions()).find(item => item.providerId === scope.providerId)!;
    assert.equal(option.executable, false); await assert.rejects(provider.open(), /no-task-runtime/);
    const target = { providerId: scope.providerId, environmentId: scope.environmentId };
    let view: any = await root.controller.manageApps({ action: 'open', desktopTarget: target });
    assert.equal(view.configuredAppList, true); assert.equal(view.readiness.controlledLaunch, true); assert.equal(client.starts, 0);
    const act = async (action: string, fields = {}) => view = await root.controller.manageApps({ action, desktopTarget: target,
      sessionId: view.sessionId, revision: view.revision, requestId: crypto.randomUUID(), ...fields });
    await act('scan'); assert.equal(view.candidates[0].candidate.displayName, '网易云音乐'); assert.equal(client.starts, 0);
    await act('prepare', { candidateId: view.candidates[0].candidateId, candidateRevision: view.candidates[0].revision });
    assert.equal(client.starts, 0); await act('confirm', { confirmationId: view.confirmation.confirmationId, digest: view.confirmation.digest, allowLaunch: true });
    assert.equal(client.starts, 1); assert.equal(view.registered[0].trust, 'verified');
    assert.doesNotMatch(JSON.stringify(view), /private-owned-app|WinSta0/);
    await act('verify', { appBindingId: view.registered[0].appBindingId, expectedRevision: view.registered[0].revision, allowLaunch: true });
    assert.equal(client.starts, 1); assert.equal(models, 0);
    client.changed = true;
    await act('verify', { appBindingId: view.registered[0].appBindingId, expectedRevision: view.registered[0].revision, allowLaunch: true });
    assert.equal(view.registered[0].verifications.at(-1).result, 'unavailable'); assert.equal(client.active, false); assert.equal(client.starts, 1);
  } finally { await root.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test('configured App rejects wrappers, other versions, mutable authority and missing explicit files', () => {
  for (const invalid of [{ ...config, path: 'C:\\Windows\\cmd.exe' }, { ...config, path: '\\\\server\\cloudmusic.exe' },
    { ...config, version: 'other' }, { ...config, sha256: 'not-a-pin' }, { ...config, allowLaunch: true }]) assert.throws(() => workbenchAppConfig(invalid));
  const dir = mkdtempSync(join(tmpdir(), 'workbench-config-'));
  try { assert.equal(loadWorkbenchAppConfig(dir), undefined); assert.throws(() => loadWorkbenchAppConfig(dir, join(dir, 'missing.json'))); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
