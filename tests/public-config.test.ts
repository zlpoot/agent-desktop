import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configuredModel, configuredVerifier, requiredEndpoint } from '../src/agent/local-config.js';
import { configuredLiveShadow } from '../src/verification/live-shadow.js';
import { createRootAssembly } from '../src/composition/root.js';

test('public defaults and an absent configuration start without auxiliary model calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'public-config-'));
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw Error('Network must stay off'); };
  try {
    for (const root of [process.cwd(), dir]) {
      assert.equal(configuredVerifier(root), undefined);
      assert.equal(configuredLiveShadow(root), undefined);
      const assembly = await createRootAssembly({ rootDir: root });
      await assembly.dispose();
    }
    assert.equal(calls, 0);
    assert.throws(() => requiredEndpoint('COMPUTER_USE_BASE_URL'), /Set COMPUTER_USE_BASE_URL/);
    assert.throws(() => configuredModel({}, dir), /COMPUTER_USE_API_KEY/);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
