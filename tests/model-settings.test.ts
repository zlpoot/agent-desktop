import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { test, type TestContext } from 'node:test';
import { readModelSettings, saveModelSettings, modelSettingsPath } from '../src/agent/model-settings.js';
import { configuredModel, configuredModelProvider, snapshotModelProvider } from '../src/agent/local-config.js';
import { createDashboardServer } from '../src/app/server.js';
import { createRootAssembly } from '../src/composition/root.js';
import { SqliteTrace } from '../src/trace/sqlite-trace.js';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'model-settings-synthetic-'));
  const names = ['COMPUTER_USE_BASE_URL', 'COMPUTER_USE_MODEL', 'COMPUTER_USE_API_KEY'];
  const original = names.map(name => process.env[name]); names.forEach(name => { delete process.env[name]; });
  t.after(() => { names.forEach((name, i) => { if (original[i] === undefined) delete process.env[name]; else process.env[name] = original[i]; }); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
const syntheticKey = 'synthetic-private-key-never-real';
const settings = (apiKey = syntheticKey) => ({ endpoint: 'https://synthetic.invalid/v1', model: 'synthetic-model', keyAction: 'replace', apiKey });

test('private settings persist, never echo keys, keep/replace/clear and legacy priority agree with runtime', t => {
  const dir = fixture(t);
  assert.equal(readModelSettings(dir).effective.ready, false);
  assert.equal(readModelSettings(dir).effective.reasons.length, 3);
  let state = saveModelSettings(dir, settings());
  assert.equal(state.effective.ready, true); assert.equal(state.effective.keyConfigured, true);
  assert.ok(!JSON.stringify(state).includes(syntheticKey));
  assert.equal(JSON.parse(readFileSync(modelSettingsPath(dir), 'utf8')).apiKey, syntheticKey);
  assert.equal(configuredModel({}, dir).model.name, 'synthetic-model');
  assert.equal(readdirSync(join(dir, 'config')).some(name => name.endsWith('.tmp')), false);
  if (process.platform !== 'win32') assert.equal(statSync(modelSettingsPath(dir)).mode & 0o777, 0o600);
  assert.match(readFileSync('.gitignore', 'utf8'), /^config\/model\.local\.json$/m);
  writeFileSync(join(dir, '.env.local'), "COMPUTER_USE_API_KEY='synthetic-legacy-key'\n");
  saveModelSettings(dir, { endpoint: settings().endpoint, model: 'second-model', keyAction: 'keep' });
  assert.equal(JSON.parse(readFileSync(modelSettingsPath(dir), 'utf8')).apiKey, syntheticKey);
  state = saveModelSettings(dir, { endpoint: '', model: '', keyAction: 'clear' });
  assert.equal(state.saved.keyCleared, true); assert.equal(state.effective.keyConfigured, false);
  assert.equal(state.effective.sources.apiKey, 'private-file', 'clear suppresses legacy fallback');
  process.env.COMPUTER_USE_BASE_URL = 'https://environment.invalid/v1';
  process.env.COMPUTER_USE_MODEL = 'env-model'; process.env.COMPUTER_USE_API_KEY = 'synthetic-env-key';
  state = saveModelSettings(dir, settings('synthetic-replacement'));
  assert.deepEqual(state.effective.sources, { endpoint: 'environment', model: 'environment', apiKey: 'environment' });
  assert.equal(state.effective.model, 'env-model'); assert.equal(state.saved.model, 'synthetic-model');
  assert.equal(configuredModel({}, dir).model.name, 'env-model');
  saveModelSettings(dir, { endpoint: settings().endpoint, model: 'local-model', keyAction: 'clear' });
  assert.equal(readModelSettings(dir).effective.keyConfigured, true, 'env still overrides clear');
  delete process.env.COMPUTER_USE_API_KEY;
  assert.equal(readModelSettings(dir).effective.keyConfigured, false);
});

test('legacy env and .env.local remain available; blank env falls through; invalid/credential URLs fail without echo', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, '.env.local'), 'COMPUTER_USE_API_KEY="synthetic-legacy-key"');
  process.env.COMPUTER_USE_BASE_URL = settings().endpoint; process.env.COMPUTER_USE_MODEL = 'legacy-model';
  assert.equal(readModelSettings(dir).effective.sources.apiKey, 'env-local');
  assert.equal(configuredModel({}, dir).model.name, 'legacy-model');
  saveModelSettings(dir, settings()); process.env.COMPUTER_USE_BASE_URL = ' '; process.env.COMPUTER_USE_MODEL = '';
  assert.equal(readModelSettings(dir).effective.model, 'synthetic-model');
  for (const endpoint of ['file:///secret', 'https://user:synthetic-secret@example.test', 'https://example.test/?key=secret', 'https://example.test/#key']) {
    assert.throws(() => saveModelSettings(dir, { ...settings(), endpoint }), /API 地址/);
  }
  for (const body of [{ ...settings(), model: 'jev' }, { ...settings(), apiKey: 'YOUR_API_KEY' },
    { ...settings(), apiKey: 'key\nheader' }, { ...settings(), keyAction: 'keep' }, { ...settings(), unexpected: syntheticKey }]) {
    assert.throws(() => saveModelSettings(dir, body));
  }
  process.env.COMPUTER_USE_BASE_URL = `https://user:${syntheticKey}@example.test`;
  const state = readModelSettings(dir);
  assert.equal(state.effective.ready, false); assert.equal(state.effective.endpoint, '');
  assert.ok(!JSON.stringify(state).includes(syntheticKey));
});

test('Host GET/PUT enforce local same-origin writes, sanitize failures and never invoke models', async t => {
  const dir = fixture(t); let effects = 0;
  const server = createDashboardServer(dir, { submit() { effects++; throw Error('no task'); }, resume() {}, pause() {}, continue() {} });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => server.close(() => done())));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('port');
  const base = `http://127.0.0.1:${address.port}`, path = `${base}/api/settings/model`;
  const put = (body: object, headers: Record<string, string> = {}) => fetch(path, { method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body) });
  assert.equal((await put(settings(), { Origin: 'https://untrusted.invalid' })).status, 403);
  const foreignHost = await new Promise<number | undefined>((done, reject) => {
    const req = request(path, { headers: { Host: 'untrusted.invalid' } }, response => {
      response.resume(); response.on('end', () => done(response.statusCode));
    }); req.on('error', reject); req.end();
  });
  assert.equal(foreignHost, 403);
  assert.equal((await put(settings(), { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings()) })).status, 403);
  assert.equal((await put(settings(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await fetch(path, { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  const response = await put(settings()); assert.equal(response.status, 200); assert.ok(!(await response.text()).includes(syntheticKey));
  const get = await fetch(path); assert.equal(get.status, 200); assert.ok(!(await get.text()).includes(syntheticKey));
  const bad = await fetch(path, { method: 'PUT', headers: { Origin: base, 'Content-Type': 'application/json' }, body: `{"apiKey":"${syntheticKey}"` });
  assert.equal(bad.status, 400); assert.ok(!(await bad.text()).includes(syntheticKey));
  const large = await put({ ...settings(), apiKey: syntheticKey.repeat(400) }); assert.equal(large.status, 400); assert.ok(!(await large.text()).includes(syntheticKey));
  writeFileSync(modelSettingsPath(dir), `{"apiKey":"${syntheticKey}"`);
  const broken = await fetch(path); assert.equal(broken.status, 503); assert.ok(!(await broken.text()).includes(syntheticKey));
  assert.equal((await put(settings())).status, 400); assert.equal(effects, 0);
});

test('per-run provider snapshot fixes both model instances while later tasks see the saved change; no connection on save', async t => {
  const dir = fixture(t); const original = globalThis.fetch; const calls: { url: string; authorization: string }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), authorization: (init?.headers as Record<string, string>).Authorization }); throw Error('no network');
  }; t.after(() => { globalThis.fetch = original; });
  saveModelSettings(dir, settings()); const provider = configuredModelProvider(dir), active = snapshotModelProvider(provider);
  const planning = active.createModel(); saveModelSettings(dir, { ...settings(), endpoint: 'https://next.invalid/v1', model: 'next-model', apiKey: 'next-synthetic-key' });
  assert.equal(active.createModel({ environment: 'browser' }).name, planning.name);
  assert.equal(provider.createModel().name, 'next-model'); assert.equal(calls.length, 0);
  await assert.rejects(() => active.createModel({ environment: 'browser' }).planTask('synthetic goal'), /no network/);
  await assert.rejects(() => provider.createModel().planTask('synthetic goal'), /no network/);
  assert.deepEqual(calls, [
    { url: `${settings().endpoint}/chat/completions`, authorization: `Bearer ${syntheticKey}` },
    { url: 'https://next.invalid/v1/chat/completions', authorization: 'Bearer next-synthetic-key' },
  ]);
  const fake = { createModel() { throw Error('fake'); } }; assert.equal(snapshotModelProvider(fake), fake);
});

test('ordinary Task injection consumes new private settings without restart; stub transport stops before Runtime and secrets stay out of trace', async t => {
  const dir = fixture(t), original = globalThis.fetch;
  const requests: { url: string; model: string; authorization: string }[] = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url: String(url), model: body.model, authorization: (init?.headers as Record<string, string>).Authorization });
    throw Error('synthetic-stop-before-runtime');
  };
  t.after(() => { globalThis.fetch = original; });
  const assembly = await createRootAssembly({ rootDir: dir });
  const trace = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
  try {
    for (const [model, apiKey] of [['first-task-model', syntheticKey], ['second-task-model', 'synthetic-second-key']]) {
      saveModelSettings(dir, { ...settings(apiKey), model });
      const id = assembly.controller.submit('synthetic ordinary browser configuration probe');
      for (let count = 0; trace.load(id)?.status !== 'failed' && count < 100; count++) await new Promise(done => setTimeout(done, 10));
      assert.match(trace.load(id)?.error ?? '', /synthetic-stop-before-runtime/);
      assert.ok(!JSON.stringify(trace.events(id)).includes(apiKey));
      assert.equal(requests.at(-1)?.model, model); assert.equal(requests.at(-1)?.authorization, `Bearer ${apiKey}`);
      assert.equal(requests.at(-1)?.url, `${settings().endpoint}/chat/completions`);
    }
    assert.equal(requests.length, 2);
  } finally { trace.close(); await assembly.dispose(); }
});
