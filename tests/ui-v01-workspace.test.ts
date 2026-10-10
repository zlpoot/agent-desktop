import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createDashboardServer } from '../src/app/server.js';
import { initialState } from '../src/graph/state.js';
import { SqliteTrace } from '../src/trace/sqlite-trace.js';
import { configureSyntheticModel } from './fixtures/model-settings.js';

test('UI-01 shell keeps five routes, explicit admission, drafts, evidence and controls truthful', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const directory = mkdtempSync(join(tmpdir(), 'ui-v01-shell-'));
  configureSyntheticModel(directory);
  const target = { providerId: 'synthetic', environmentId: 'local-workspace:chrome' };
  const trace = new SqliteTrace(join(directory, 'web-tasks.sqlite'));
  const state = { ...initialState('recorded', 'synthetic recorded observation'), taskBindingVersion: 1 as const, desktopTarget: target, step: 1 };
  trace.save('observe', { ...state, observation: { pageText: 'synthetic DOM evidence',
    textEvidence: [{ source: 'dom', text: 'synthetic DOM evidence' }] } });
  trace.save('execute', { ...state, lastResult: { ok: true, message: 'synthetic dispatch' } });
  trace.save('paused', { ...state, status: 'paused', verificationPending: true, recoveryUncertain: true });
  trace.close();
  let admissions = 0;
  const server = createDashboardServer(directory, {
    desktopOptions: async () => [{ ...target, kind: 'local-workspace', executable: false,
      scenarios: [{ id: 'fixed-fixture', label: '合成规则计划', availability: 'supported' }] }],
    submit() { admissions++; return 'admitted-only'; }, // HTTP admission only; never claim execution.
    resume() { assert.fail('no resume'); }, pause() { assert.fail('no pause'); }, continue() { assert.fail('no continue'); },
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('port');
  const base = `http://127.0.0.1:${address.port}`;
  const { chromium } = await import('playwright'); const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [], posts: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST') posts.push(new URL(request.url()).pathname); });
    await page.goto(base);
    await page.locator('#task-destination option').filter({ hasText: 'Hidden Workspace Chrome' }).waitFor({ state: 'attached' });
    assert.deepEqual(await page.getByRole('navigation', { name: '主要导航', exact: true }).getByRole('button').allTextContents(),
      ['◈工作台', '≡任务', '◇工作流', '▦环境与应用', '⚙设置']);
    assert.equal(await page.locator('#task-destination').inputValue(), '');
    assert.equal(await page.locator('#task-submit').isDisabled(), true);
    await page.locator('#task-goal').fill('retained synthetic draft');
    await page.locator('#task-destination').selectOption('browser');
    for (const [mode, reason] of [['稳定', '尚未接通'], ['学习', '待启用'], ['优化', '待实现']]) {
      await page.getByRole('radio', { name: mode, exact: true }).check();
      assert.equal(await page.locator('#task-submit').isDisabled(), true);
      assert.match(await page.locator('#task-mode-description').innerText(), new RegExp(reason));
      await page.locator('#task-form').evaluate((form: HTMLFormElement) => form.requestSubmit());
      assert.equal(admissions, 0, `unsupported ${mode} must not POST`);
    }
    await page.getByRole('radio', { name: '自主', exact: true }).check();
    assert.equal(await page.locator('#task-message').innerText(), '', 'switching modes clears stale admission errors');
    await page.waitForFunction(() => !(document.querySelector('#task-submit') as HTMLButtonElement).disabled);
    assert.match(await page.locator('.readiness-card').innerText(), /后台检查模型与环境/);
    await page.getByText('查看执行计划与准备条件', { exact: true }).click();
    assert.match(await page.locator('#task-preview-summary').innerText(), /模型配置在后台核对/);
    assert.match(await page.locator('#task-preview-summary').innerText(), /DeepSeek \d+ 次 \/ \d+ Token/);
    await page.getByRole('radio', { name: '自主', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('radio', { name: '学习', exact: true }).isChecked(), true);
    assert.equal(await page.locator('#task-submit').isDisabled(), true);
    assert.equal(await page.getByRole('radio', { name: '学习', exact: true }).evaluate(radio =>
      getComputedStyle(radio.nextElementSibling!).outlineStyle), 'solid');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.getByLabel('应用（可选）', { exact: true }).isDisabled(), true);
    assert.deepEqual(posts, []);
    await page.getByRole('button', { name: '收起准备上下文', exact: true }).click();
    assert.equal(await page.getByRole('complementary', { name: '任务准备上下文' }).isVisible(), false);
    await page.getByRole('button', { name: '展开准备上下文', exact: true }).click();
    await page.getByRole('button', { name: '收起导航', exact: true }).click();
    assert.equal(await page.locator('.brand').evaluate(brand => brand.scrollWidth <= brand.clientWidth), true);
    assert.equal(await page.getByRole('button', { name: '工作流', exact: true }).isVisible(), true);
    await page.getByRole('button', { name: '展开导航', exact: true }).click();
    const screenshotDir = resolve('.artifacts/ui-v01-stage-b'); mkdirSync(screenshotDir, { recursive: true });
    for (const width of [390, 601, 668, 700, 900, 1366, 1440]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 598 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `idle overflow ${width}`);
      assert.equal(await page.locator('.topbar').evaluate(bar => {
        const bounds = bar.getBoundingClientRect();
        return [...bar.querySelectorAll('.topbar-actions > *')].every(child => child.getBoundingClientRect().bottom <= bounds.bottom);
      }), true, `topbar overlaps task content ${width}`);
      await page.locator('#task-submit').scrollIntoViewIfNeeded();
      assert.equal(await page.locator('#task-submit').evaluate(button => {
        const r = button.getBoundingClientRect();
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('#task-submit') === button;
      }), true, `submit occlusion ${width}`);
      await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.main')!.scrollTop = 0; });
      await page.screenshot({ path: join(screenshotDir, `idle-${width}.png`), fullPage: true });
    }
    await page.getByRole('radio', { name: '学习', exact: true }).check();
    await page.reload();
    assert.equal(await page.locator('#task-goal').inputValue(), 'retained synthetic draft');
    assert.equal(await page.getByRole('radio', { name: '学习', exact: true }).isChecked(), true);
    await page.locator('#task-destination').selectOption(JSON.stringify(Object.values(target)));
    assert.equal(await page.locator('#task-scenario').inputValue(), '');
    assert.equal(await page.locator('#task-submit').isDisabled(), true);
    await page.locator('#task-scenario').selectOption('fixed-fixture');
    assert.match(await page.locator('#task-mode-description').innerText(), /固定规则计划/);
    assert.equal(await page.getByRole('radio', { name: '学习', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('#task-goal').isDisabled(), true);
    assert.deepEqual(posts, []);
    for (const [route, name] of [['desktop', '环境与应用'], ['apps', '环境与应用'], ['plugins', '设置'], ['workflows', '工作流']]) {
      await page.goto(`${base}/#/${route}`);
      assert.equal(await page.getByRole('navigation', { name: '主要导航', exact: true }).getByRole('button', { name, exact: true }).getAttribute('aria-current'), 'page');
    }
    await page.goto(`${base}/#/history?task=web-tasks.sqlite%2Frecorded`);
    await page.waitForFunction(() => document.querySelector('#task-id')?.textContent?.includes('recorded'));
    assert.equal(await page.locator('.desktop-panel').isVisible(), false, 'Chrome record must never bind Guest stream');
    assert.match(await page.locator('#task-recorded').innerText(), /尚无已记录截图/);
    for (const label of ['接管任务', '停止任务', '紧急停止']) assert.equal(await page.getByRole('button', { name: label, exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '文字与结构', exact: true }).click();
    assert.match(await page.getByRole('region', { name: '已记录观察' }).innerText(), /synthetic DOM evidence/);
    assert.match(await page.locator('.workspace-timeline').innerText(), /动作回执 成功 · 验证 未知/);
    await page.getByRole('button', { name: '收起上下文', exact: true }).click();
    assert.equal(await page.locator('.task-detail-layout > .hero').isVisible(), false);
    await page.getByRole('button', { name: '展开上下文与任务控制', exact: true }).click();
    assert.equal(await page.locator('.task-detail-layout > .hero').isVisible(), true);
    for (const width of [390, 601, 668, 700, 900, 1366, 1440]) {
      await page.setViewportSize({ width, height: 598 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `scene overflow ${width}`);
      if (width === 390 || width === 1440) await page.screenshot({ path: join(screenshotDir, `recorded-${width}.png`), fullPage: true });
    }
    assert.deepEqual(errors, []); assert.deepEqual(posts, []);
  } finally { await browser.close(); await new Promise<void>(done => server.close(() => done())); rmSync(directory, { recursive: true, force: true }); }
});

test('UI-01 prevents concurrent POST and reports lost acknowledgement without automatic retry', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const directory = mkdtempSync(join(tmpdir(), 'ui-v01-unknown-'));
  configureSyntheticModel(directory);
  const server = createDashboardServer(directory, { submit() { assert.fail('request is intercepted'); }, resume() {}, pause() {}, continue() {} });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('port');
  const { chromium } = await import('playwright'); const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); let requests = 0;
    let intercepted!: (route: import('playwright').Route) => void;
    const pending = new Promise<import('playwright').Route>(done => { intercepted = done; });
    await page.route('**/api/tasks', route => { requests++; intercepted(route); });
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.locator('#task-destination').selectOption('browser'); await page.locator('#task-goal').fill('unknown synthetic request');
    await page.locator('#task-submit').click(); const route = await pending;
    assert.equal(await page.locator('#task-submit').isDisabled(), true);
    await page.locator('#task-form').evaluate((form: HTMLFormElement) => form.requestSubmit());
    assert.equal(requests, 1);
    await route.abort('failed'); await page.getByText(/提交结果未知：/).waitFor();
    assert.equal(await page.locator('#task-goal').inputValue(), 'unknown synthetic request');
    await page.getByRole('button', { name: '任务', exact: true }).click();
    await page.locator('#refresh').click();
    assert.equal(requests, 1, 'polling and refresh must never replay a POST');
  } finally { await browser.close(); await new Promise<void>(done => server.close(() => done())); rmSync(directory, { recursive: true, force: true }); }
});

test('UI-01 keeps acknowledged Browser B selected over paused Guest A, including a delayed list and reload', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const directory = mkdtempSync(join(tmpdir(), 'ui-v01-submitted-'));
  configureSyntheticModel(directory);
  const routes = new DatabaseSync(join(directory, 'web-task-routes.sqlite'));
  routes.exec('CREATE TABLE generic_routes (task_id TEXT PRIMARY KEY, environment TEXT, window_handle INTEGER, created_at TEXT NOT NULL)');
  for (const [id, environment] of [['guest-A', 'windows'], ['browser-B', 'browser']]) {
    routes.prepare('INSERT INTO generic_routes (task_id, environment, created_at) VALUES (?, ?, ?)').run(id, environment, new Date().toISOString());
  }
  routes.close();
  const save = (state: ReturnType<typeof initialState>) => {
    const trace = new SqliteTrace(join(directory, 'web-tasks.sqlite'));
    try { trace.save(state.status, state); } finally { trace.close(); }
  };
  save({ ...initialState('guest-A', 'synthetic paused Guest A'), status: 'paused', taskBindingVersion: 1,
    desktopTarget: { providerId: 'hyper-v', environmentId: 'vm:synthetic' } });
  let admissions = 0;
  const server = createDashboardServer(directory, {
    submit(goal, options) {
      admissions++; assert.equal(options?.desktopTarget, undefined);
      save(initialState('browser-B', goal)); // Persist HTTP admission only; no runtime or model execution.
      return 'browser-B';
    },
    resume() { assert.fail('no resume'); }, pause() { assert.fail('no pause'); }, continue() { assert.fail('no continue'); },
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('port');
  const base = `http://127.0.0.1:${address.port}`;
  const { chromium } = await import('playwright'); const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); const errors: string[] = [], posts: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST') posts.push(new URL(request.url()).pathname); });
    let listCaughtUp = false;
    await page.route('**/api/runs', async route => {
      const response = await route.fetch(); const data = await response.json();
      if (!listCaughtUp) data.runs = data.runs.filter((run: { taskId: string }) => run.taskId !== 'browser-B');
      await route.fulfill({ response, json: data });
    });
    await page.route('**/api/desktop/control', route => route.fulfill({ json: {
      mode: 'PAUSED', workerReady: true, taskId: 'guest-A', connection: { status: 'ready' },
      task: { id: 'guest-A', goal: 'synthetic paused Guest A', status: 'paused' },
    } }));
    await page.route('**/api/desktop/sessions', route => route.fulfill({ json: {
      sessions: [{ sessionId: 'synthetic-guest', status: 'online' }],
    } }));
    const frame = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 32;
      return canvas.toDataURL().split(',')[1];
    });
    await page.routeWebSocket('**/stream', ws => { ws.send(Buffer.from(frame, 'base64')); });
    const assertB = async () => {
      await page.waitForFunction(() => document.querySelector('#task-id')?.textContent === '任务 ID · browser-B' &&
        !(document.querySelector('#detail') as HTMLElement)?.hidden);
      assert.equal(await page.locator('.desktop-panel').isVisible(), false, 'B must not display A Guest frame or controls');
      assert.equal(await page.locator('.task-live-slot .desktop-panel').count(), 0);
      assert.equal(await page.locator('#task-continue').isVisible(), false, 'A paused continue action must not appear for B');
      assert.match(await page.locator('.task-runtime-summary').innerText(), /环境：浏览器/);
      assert.doesNotMatch(await page.locator('#detail').innerText(), /synthetic paused Guest A/);
    };
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('#task-id')?.textContent === '任务 ID · guest-A');
    await page.waitForFunction(() => (document.querySelector('#desktop-frame') as HTMLImageElement)?.naturalWidth === 64);
    assert.equal(await page.locator('.task-live-slot .desktop-panel').isVisible(), true);
    assert.equal(await page.locator('#task-continue').isVisible(), true);
    await page.locator('#task-destination').selectOption('browser');
    await page.locator('#task-goal').fill('synthetic Browser B');
    const acknowledged = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/tasks');
    await page.locator('#task-submit').click(); const response = await acknowledged;
    assert.equal(response.status(), 202); assert.deepEqual(await response.json(), { taskId: 'browser-B', source: 'web-tasks.sqlite' });
    const persisted = await (await page.request.get(`${base}/api/runs/web-tasks.sqlite/browser-B`)).json();
    assert.equal(persisted.taskId, 'browser-B'); assert.equal(persisted.goal, 'synthetic Browser B'); assert.equal(persisted.status, 'running');
    await page.locator('.task-load-feedback').getByText(/已提交任务 web-tasks.sqlite\/browser-B/).waitFor();
    assert.match(page.url(), /#\/live$/);
    assert.equal(await page.locator('#detail').isVisible(), false, 'list lag must not substitute A details or Task controls');
    assert.equal(await page.locator('.desktop-panel').isVisible(), false);
    await page.getByRole('button', { name: '重试读取任务', exact: true }).click();
    assert.equal(await page.locator('#detail').isVisible(), false);
    await page.reload();
    await page.locator('.task-load-feedback').getByText(/已提交任务 web-tasks.sqlite\/browser-B/).waitFor();
    assert.equal(await page.locator('.desktop-panel').isVisible(), false, 'reload with delayed list must keep B identity');
    listCaughtUp = true;
    await page.getByRole('button', { name: '重试读取任务', exact: true }).click(); await assertB();
    assert.equal(await page.locator('#task-pause').isVisible(), true, 'running B has its own Task pause action');
    await page.goto(`${base}/#/history?task=web-tasks.sqlite%2Fguest-A`);
    await page.waitForFunction(() => document.querySelector('#task-id')?.textContent === '任务 ID · guest-A');
    await page.locator('.task-live-slot .desktop-panel').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#task-continue').isVisible(), true, 'explicit history A retains A controls');
    await page.getByRole('button', { name: '工作台', exact: true }).click(); await assertB();
    await page.reload(); await assertB();
    assert.equal(admissions, 1); assert.deepEqual(posts, ['/api/tasks']); assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise<void>(done => server.close(() => done())); rmSync(directory, { recursive: true, force: true }); }
});
