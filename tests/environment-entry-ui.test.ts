import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDashboardServer } from '../src/app/server.js';
import { SqliteTrace } from '../src/trace/sqlite-trace.js';
import { initialState } from '../src/graph/state.js';
import { configureSyntheticModel } from './fixtures/model-settings.js';
import { saveModelSettings } from '../src/agent/model-settings.js';

test('B Browser entry gates empty/unknown model status, refreshes after settings save and persists one synthetic Task through history', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const dir = mkdtempSync(join(tmpdir(), 'b-browser-entry-'));
  let submissions = 0, release: (() => void) | undefined;
  const server = createDashboardServer(dir, {
    desktopOptions: async () => [],
    submit(goal, options) {
      submissions++; assert.equal(options?.desktopTarget, undefined); assert.equal(options?.destination, 'browser');
      const trace = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
      // Synthetic admission/history projection only; no Runtime or model is invoked.
      try { trace.save('queued', initialState('b-browser-task', goal)); } finally { trace.close(); }
      return 'b-browser-task';
    }, resume() { assert.fail('no resume'); }, pause() {}, continue() {},
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('port');
  const base = `http://127.0.0.1:${address.port}`;
  const { chromium } = await import('playwright'), browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [], posts: { path: string; body: Record<string, unknown> }[] = [], remote: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (new URL(request.url()).origin !== base) remote.push(request.url());
      if (request.method() === 'POST') posts.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
    });
    await page.route('**/api/desktop/environments', route => route.fulfill({ status: 503, json: { error: 'synthetic-directory-failure' } }));
    await page.goto(base); await page.locator('#task-destination').selectOption('browser');
    await page.locator('#task-model-status').getByText(/配置不完整/).waitFor();
    assert.equal(await page.locator('#task-submit').isDisabled(), true);
    assert.match(await page.locator('#task-environment-status').innerText(), /读取失败.*不能判断.*已配置/);
    assert.match(await page.locator('.readiness-card').innerText(), /缺少 API 地址.*缺少模型名称.*缺少有效 API Key/);
    await page.locator('#task-goal').fill('synthetic ordinary Browser goal');
    await page.locator('#task-form').evaluate((form: HTMLFormElement) => form.requestSubmit());
    assert.equal(submissions, 0);
    await page.route('**/api/settings/model', route => route.fulfill({ status: 503, json: { error: 'synthetic-model-read-failure' } }));
    await page.getByRole('button', { name: '重新读取准备状态', exact: true }).click();
    await page.locator('#task-model-status').getByText(/读取失败.*UNKNOWN/).waitFor();
    assert.equal(await page.locator('#task-submit').isDisabled(), true);
    await page.unroute('**/api/settings/model');
    await page.locator('.readiness-card a').filter({ hasText: '到设置配置模型' }).click();
    await page.locator('#model-settings-message').getByText(/已读取生效来源/).waitFor();
    await page.locator('#model-endpoint').fill('https://synthetic.invalid/v1'); await page.locator('#model-name').fill('synthetic-ui-model');
    await page.locator('#model-key-action').selectOption('replace'); await page.locator('#model-api-key').fill('synthetic-key-never-real');
    await page.getByRole('button', { name: '保存模型配置', exact: true }).click();
    await page.locator('#model-settings-message').getByText(/已保存本机配置/).waitFor();
    await page.getByRole('button', { name: '工作台', exact: true }).click();
    await page.locator('#task-model-status').getByText(/配置完整.*尚未验证/).waitFor();
    assert.equal(await page.locator('#task-message').innerText(), '', 'updated preparation clears the old missing-model admission error');
    assert.equal(await page.locator('#task-submit').isEnabled(), true, 'desktop discovery failure does not override the separate Browser path');
    assert.match(await page.locator('#task-model-status').innerText(), /synthetic.invalid.*本机私有配置.*synthetic-ui-model.*Key 已配置/s);
    assert.doesNotMatch(await page.locator('#task-model-status').innerText(), /synthetic-key-never-real/);
    assert.match(await page.locator('.readiness-card').innerText(), /受控 Chromium.*Hidden Workspace Chrome/);
    await page.unroute('**/api/desktop/environments'); await page.getByRole('button', { name: '重新读取准备状态', exact: true }).click();
    await page.locator('#task-environment-status').getByText(/VM 未发现.*Local Workspace.*未发现/).waitFor();
    assert.equal((await page.request.get(`${base}/environment-help`)).status(), 200);
    mkdirSync(resolve('.artifacts/issue-59'), { recursive: true });
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator('#task-submit').scrollIntoViewIfNeeded();
      assert.equal(await page.locator('#task-submit').evaluate(button => { const r = button.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('#task-submit') === button; }), true);
      await page.screenshot({ path: resolve(`.artifacts/issue-59/browser-${width}.png`), fullPage: true });
    }
    let entered!: () => void; const received = new Promise<void>(done => { entered = done; }), waiting = new Promise<void>(done => { release = done; });
    await page.route('**/api/tasks', async route => { const response = await route.fetch(); entered(); await waiting; await route.fulfill({ response }); });
    await page.locator('#task-submit').click(); await received;
    assert.equal(await page.locator('#task-submit').isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '重新读取准备状态', exact: true }).isDisabled(), true);
    await page.locator('#task-form').evaluate((form: HTMLFormElement) => form.requestSubmit());
    assert.equal(submissions, 1); release!(); release = undefined;
    await page.waitForFunction(() => document.querySelector('#task-id')?.textContent?.includes('b-browser-task'));
    assert.equal(posts.length, 1); assert.equal(posts[0].path, '/api/tasks'); assert.equal(posts[0].body.destination, 'browser');
    assert.equal(posts[0].body.desktopTarget, undefined); assert.equal(posts[0].body.scenarioId, undefined);
    const record = await (await page.request.get(`${base}/api/runs/web-tasks.sqlite/b-browser-task`)).json();
    assert.equal(record.goal, 'synthetic ordinary Browser goal'); assert.equal(record.desktopTarget, undefined);
    await page.goto(`${base}/#/history?task=web-tasks.sqlite%2Fb-browser-task`);
    await page.waitForFunction(() => document.querySelector('#task-id')?.textContent?.includes('b-browser-task'));
    assert.equal(await page.locator('.desktop-panel').isVisible(), false);
    assert.deepEqual(remote, []); assert.deepEqual(errors, []);
  } finally { release?.(); await browser.close(); await new Promise<void>(done => server.close(() => done())); rmSync(dir, { recursive: true, force: true }); }
});

test('B Browser preparation displays env overrides and explicit local Key clear without exposing a Key', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const names = ['COMPUTER_USE_BASE_URL', 'COMPUTER_USE_MODEL', 'COMPUTER_USE_API_KEY'], before = names.map(name => process.env[name]);
  const dir = mkdtempSync(join(tmpdir(), 'b-env-entry-')); configureSyntheticModel(dir);
  process.env.COMPUTER_USE_BASE_URL = 'https://environment.invalid/v1'; process.env.COMPUTER_USE_MODEL = 'environment-model'; process.env.COMPUTER_USE_API_KEY = 'synthetic-env-key-never-real';
  const server = createDashboardServer(dir, { desktopOptions: async () => [], submit() { assert.fail('no submit'); }, resume() {}, pause() {}, continue() {} });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('port');
  const { chromium } = await import('playwright'), browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${address.port}`); await page.locator('#task-destination').selectOption('browser');
    await page.locator('#task-model-status').getByText(/环境变量正在覆盖/).waitFor();
    assert.match(await page.locator('#task-model-status').innerText(), /environment.invalid.*环境变量.*environment-model.*Key 已配置/s);
    assert.doesNotMatch(await page.locator('#task-model-status').innerText(), /synthetic-env-key-never-real/);
    assert.equal(await page.locator('#task-submit').isEnabled(), true);
    names.forEach(name => { delete process.env[name]; });
    await page.getByRole('button', { name: '重新读取准备状态', exact: true }).click();
    await page.locator('#task-model-status').getByText(/synthetic-ui-model/).waitFor();
    assert.doesNotMatch(await page.locator('#task-model-status').innerText(), /环境变量正在覆盖/);
    saveModelSettings(dir, { endpoint: 'https://synthetic.invalid/v1', model: 'synthetic-ui-model', keyAction: 'clear' });
    await page.getByRole('button', { name: '重新读取准备状态', exact: true }).click();
    await page.locator('#task-model-status').getByText(/Key 未配置/).waitFor();
    assert.equal(await page.locator('#task-submit').isDisabled(), true);
  } finally { await browser.close(); await new Promise<void>(done => server.close(() => done())); rmSync(dir, { recursive: true, force: true }); names.forEach((name, i) => { if (before[i] === undefined) delete process.env[name]; else process.env[name] = before[i]; }); }
});

test('B finite-only catalog keeps unavailable/unproven states and refreshes consumed synthetic authorization without generic fallback', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const dir = mkdtempSync(join(tmpdir(), 'b-finite-entry-'));
  const target = { providerId: 'synthetic-hidden', environmentId: 'local-workspace:chrome' };
  let consumed = false, submissions = 0;
  const server = createDashboardServer(dir, {
    desktopOptions: async () => [{ ...target, kind: 'local-workspace', executable: false, blockedReason: 'hidden-chrome-generic-task-unavailable', scenarios: [
      { id: 'synthetic-readonly', label: '合成只读固定场景', availability: 'supported' },
      { id: 'synthetic-once', label: '合成一次性候选（不创建 Key）', availability: consumed ? 'unavailable' : 'supported', reason: consumed ? '本次授权已绑定任务，禁止重复创建' : '独立一次性授权' },
      { id: 'raw', label: 'RAW', availability: 'not-proven', reason: '未有证据' },
      { id: 'notepad', label: 'Notepad', availability: 'unsupported', reason: '历史不支持' },
      { id: 'offline', label: '断开的目标', availability: 'unavailable', reason: '当次目标不可用' },
    ] }],
    submit() { assert.fail('no generic fallback'); },
    submitScenario(request) {
      assert.equal(consumed, false); assert.deepEqual(request, { desktopTarget: target, scenarioId: 'synthetic-once' });
      consumed = true; submissions++;
      const trace = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
      try { trace.save('queued', { ...initialState('b-finite-task', 'synthetic fixed goal'), taskBindingVersion: 1, desktopTarget: target, desktopScenario: request.scenarioId }); } finally { trace.close(); }
      return 'b-finite-task';
    }, resume() {}, pause() {}, continue() {},
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('port');
  const { chromium } = await import('playwright'), browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.locator('#task-destination').selectOption(JSON.stringify(Object.values(target)));
    assert.equal(await page.locator('#task-submit').isDisabled(), true); assert.equal(await page.locator('#task-scenario').inputValue(), '');
    assert.equal(await page.locator('#task-scenario option:disabled').count(), 3);
    assert.match(await page.locator('#task-scenario').textContent() || '', /尚未验证.*未有证据.*不支持.*历史不支持.*不可用.*当次目标不可用/);
    assert.match(await page.locator('#task-environment-status').innerText(), /普通任务未开放.*hidden-chrome-generic-task-unavailable/);
    await page.locator('#task-goal').fill('free text must not select a scene');
    await page.locator('#task-scenario').selectOption('synthetic-once');
    assert.equal(await page.locator('#task-goal').isDisabled(), true);
    await page.locator('#task-submit').click(); await page.waitForFunction(() => document.querySelector('#task-id')?.textContent?.includes('b-finite-task'));
    await page.getByRole('button', { name: '以此任务新建草稿', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('#task-scenario option[value="synthetic-once"]') as HTMLOptionElement)?.disabled);
    assert.equal(await page.locator('#task-submit').isDisabled(), true);
    await page.locator('#task-form').evaluate((form: HTMLFormElement) => form.requestSubmit());
    assert.equal(submissions, 1); assert.match(await page.locator('.readiness-card').innerText(), /本次授权已绑定任务/);
    const record = await (await page.request.get(`http://127.0.0.1:${address.port}/api/runs/web-tasks.sqlite/b-finite-task`)).json();
    assert.deepEqual(record.desktopTarget, target); assert.equal(record.desktopScenario, 'synthetic-once');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise<void>(done => server.close(() => done())); rmSync(dir, { recursive: true, force: true }); }
});
