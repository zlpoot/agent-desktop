import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createDashboardServer } from '../src/app/server.js';
import type { TaskController } from '../src/app/task-runner.js';
import { SqliteTrace } from '../src/trace/sqlite-trace.js';
import { initialState } from '../src/graph/state.js';
import { WorkflowStore } from '../src/workflows/store.js';
import { createFixtureDashboard } from '../src/composition/fixture-dashboard.js';
import { createRootAssembly } from '../src/composition/root.js';
import { ScenarioWorkspace } from './fixtures/local-workspace-scenario.js';

for (const width of [601, 668, 700]) {
  test(`fixed scenario button reaches submit, HTTP and persisted Fake Task at ${width}px`, { timeout: 60000 }, async () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
    const directory = mkdtempSync(join(tmpdir(), 'task-submit-chain-'));
    const backend = new ScenarioWorkspace();
    const assembly = await createRootAssembly({ rootDir: directory, localWorkspace: { app: 'fixture' },
      localWorkspaceBackendFactory: () => backend, model: { createModel() { assert.fail('no model'); } } });
    const server = createDashboardServer(directory, assembly.controller);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('port');
    const base = `http://127.0.0.1:${address.port}`;
    const { chromium } = await import('playwright'); const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width, height: 598 } });
      const posts: { path: string; body: unknown }[] = [];
      page.on('request', request => {
        if (request.method() === 'POST') posts.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
      });
      await page.goto(base);
      const desktopTarget = { providerId: 'windows-local-workspace', environmentId: 'local-workspace:fixture' };
      const scenarioId = 'd0-fixture-text-click-v1';
      await page.locator('#task-destination').selectOption(JSON.stringify(Object.values(desktopTarget)));
      await page.locator('#task-scenario').selectOption(scenarioId);
      await page.waitForFunction(() => !(document.querySelector('#task-submit') as HTMLButtonElement).disabled);
      await page.locator('#task-form').evaluate((form: HTMLFormElement) => {
        form.dataset.clicks = '0'; form.dataset.submits = '0';
        form.addEventListener('click', event => {
          if ((event.target as Element).closest('#task-submit')) {
            form.dataset.clicks = String(Number(form.dataset.clicks) + 1);
            form.dataset.trustedClick = String(event.isTrusted);
          }
        }, true);
        form.addEventListener('submit', event => {
          form.dataset.submits = String(Number(form.dataset.submits) + 1);
          form.dataset.submitter = (event as SubmitEvent).submitter?.id;
        }, true);
      });
      assert.deepEqual(await page.locator('#task-goal').evaluate((goal: HTMLTextAreaElement) => ({
        required: goal.required, disabled: goal.disabled, willValidate: goal.willValidate, value: goal.value,
      })), { required: true, disabled: true, willValidate: false, value: '' });
      assert.equal(await page.locator('#task-form').evaluate((form: HTMLFormElement) => form.checkValidity()), true);
      await page.locator('#task-submit').scrollIntoViewIfNeeded();
      assert.equal(await page.locator('#task-submit').evaluate(button => {
        const rect = button.getBoundingClientRect();
        return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('#task-submit') === button;
      }), true, 'the sidebar must not intercept the submit button');
      const responding = page.waitForResponse(response => response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/desktop/scenarios/tasks');
      await page.locator('#task-submit').click(); // One click; never force or bypass validation.
      const response = await responding;
      assert.equal(response.status(), 202);
      const issued = await response.json(); assert.equal(typeof issued.taskId, 'string');
      assert.deepEqual(posts, [{ path: '/api/desktop/scenarios/tasks', body: { desktopTarget, scenarioId } }]);
      assert.equal(await page.locator('#task-form').getAttribute('data-clicks'), '1');
      assert.equal(await page.locator('#task-form').getAttribute('data-trusted-click'), 'true');
      assert.equal(await page.locator('#task-form').getAttribute('data-submits'), '1');
      assert.equal(await page.locator('#task-form').getAttribute('data-submitter'), 'task-submit');
      assert.equal(existsSync(join(directory, 'web-tasks.sqlite')), true);
      const trace = new SqliteTrace(join(directory, 'web-tasks.sqlite'));
      try {
        const persisted = trace.load(issued.taskId)!; assert.ok(persisted);
        assert.deepEqual(persisted.desktopTarget, desktopTarget); assert.equal(persisted.desktopScenario, scenarioId);
      } finally { trace.close(); }
      await page.waitForFunction(() => document.querySelector('#scenario-status')?.textContent?.includes('阶段：完成'));
      const runs = await (await page.request.get(`${base}/api/runs`)).json();
      assert.equal(runs.runs.length, 1); assert.equal(runs.runs[0].taskId, issued.taskId);
      assert.equal(backend.acts, 1);
    } finally {
      await browser.close(); await new Promise<void>(done => server.close(() => done())); await assembly.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('accepted button click with an invalid required goal does not deliver submit or POST', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const directory = mkdtempSync(join(tmpdir(), 'task-html-validation-'));
  const server = createDashboardServer(directory, {
    submit() { assert.fail('invalid form must not submit'); }, resume() {}, pause() {}, continue() {},
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('port');
  const { chromium } = await import('playwright'); const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 668, height: 598 } });
    const posts: string[] = []; page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction(() => !(document.querySelector('#task-submit') as HTMLButtonElement).disabled);
    assert.equal(await page.locator('#task-form').evaluate((form: HTMLFormElement) => form.checkValidity()), false);
    await page.locator('#task-form').evaluate((form: HTMLFormElement) => {
      form.dataset.clicks = '0'; form.dataset.submits = '0';
      form.addEventListener('click', event => {
        if ((event.target as Element).closest('#task-submit')) form.dataset.clicks = String(Number(form.dataset.clicks) + 1);
      }, true);
      form.addEventListener('invalid', event => { form.dataset.invalid = (event.target as Element).id; }, true);
      form.addEventListener('submit', () => { form.dataset.submits = String(Number(form.dataset.submits) + 1); }, true);
    });
    await page.locator('#task-submit').click();
    assert.equal(await page.locator('#task-form').getAttribute('data-clicks'), '1');
    assert.equal(await page.locator('#task-form').getAttribute('data-invalid'), 'task-goal');
    assert.equal(await page.locator('#task-form').getAttribute('data-submits'), '0');
    assert.deepEqual(posts, []); assert.equal(existsSync(join(directory, 'web-tasks.sqlite')), false);
  } finally { await browser.close(); await new Promise<void>(done => server.close(() => done())); rmSync(directory, { recursive: true, force: true }); }
});

test('finite Dashboard stops pending execution, shows UNKNOWN with confirmed cleanup and hides Resume', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const directory = mkdtempSync(join(tmpdir(), 'mvp-stop-ui-'));
  const backend = new ScenarioWorkspace(); backend.autoComplete = false;
  const assembly = await createRootAssembly({ rootDir: directory, localWorkspace: { app: 'fixture' },
    localWorkspaceBackendFactory: () => backend, model: { createModel() { assert.fail('no model'); } } });
  const server = createDashboardServer(directory, assembly.controller);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('port');
  const { chromium } = await import('playwright'); const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
    await page.locator('#task-destination').selectOption(JSON.stringify(['windows-local-workspace', 'local-workspace:fixture']));
    await page.locator('#task-scenario').selectOption('d0-fixture-text-click-v1');
    await page.locator('#task-submit').click();
    await page.waitForFunction(() => document.querySelector('#scenario-status')?.textContent?.includes('阶段：独立验证'));
    await page.getByRole('button', { name: '停止并清理', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#scenario-status')?.textContent?.includes('清理 PASS'));
    assert.equal(backend.acts, 1);
    assert.match(await page.locator('#scenario-status').innerText(), /BLOCKED.*执行 UNKNOWN.*验证 UNKNOWN.*清理 PASS/);
    assert.equal(await page.locator('#task-continue').isVisible(), false);
    assert.match(await page.locator('.request-card').first().innerText(), /不支持 Dashboard 接管或 Resume/);
    assert.equal(await page.locator('#scenario-report').isVisible(), true);
  } finally {
    await browser.close(); await new Promise<void>(done => server.close(() => done())); await assembly.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('synthetic Dashboard uses production Task chain, shows independent facts/cleanup and downloads feedback', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const directory = mkdtempSync(join(tmpdir(), 'mvp-dashboard-'));
  const assembly = await createFixtureDashboard(directory);
  const server = createDashboardServer(directory, assembly.controller, undefined, undefined, undefined, undefined, undefined, true);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('port');
  const base = `http://127.0.0.1:${address.port}`;
  const { chromium } = await import('playwright'); const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('#task-destination option[value=""]'));
    assert.equal(await page.locator('#task-destination').inputValue(), '');
    assert.equal(await page.locator('#task-submit').isDisabled(), true);
    await page.locator('#task-destination').selectOption(JSON.stringify(['windows-local-workspace', 'local-workspace:fixture']));
    assert.equal(await page.locator('#task-scenario').inputValue(), '');
    assert.equal(await page.locator('#task-submit').isDisabled(), true);
    await page.locator('#task-scenario').selectOption('d0-fixture-text-click-v1');
    await page.locator('#task-submit').click();
    await page.waitForFunction(() => document.querySelector('#scenario-status')?.textContent?.includes('阶段：完成'));
    assert.match(await page.locator('#scenario-status').innerText(), /执行 PASS.*验证 PASS.*清理 PASS.*NOT HUMAN VERIFIED/);
    assert.match(await page.locator('#scenario-facts').innerText(), /"text_length": 26/);
    assert.match(await page.locator('#scenario-facts').innerText(), /"clicks": 1/);
    assert.match(await page.locator('#scenario-history').innerText(), /环境与目标预检.*执行一次.*独立验证.*停止与清理.*完成/s);
    assert.equal(await page.locator('#task-continue').isVisible(), false);
    await page.locator('#scenario-issue-note').fill('合成体验反馈');
    mkdirSync(resolve('.artifacts/mvp-01'), { recursive: true });
    await page.locator('#scenario-result').screenshot({ path: resolve('.artifacts/mvp-01/result.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 1440, height: 900 });
    const downloading = page.waitForEvent('download'); await page.locator('#scenario-report').click();
    const download = await downloading; const stream = await download.createReadStream();
    const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    const report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(report.note, '合成体验反馈'); assert.equal(report.result.cleanup, 'PASS');
    assert.equal(report.result.humanAcceptance, 'NOT HUMAN VERIFIED');
    assert.equal(report.scenarioId, 'd0-fixture-text-click-v1');
    for (const path of ['/api/tasks', '/api/desktop/apps', '/api/workflows/test/execute'])
      assert.equal((await fetch(base + path, { method: 'POST' })).status, 403);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await new Promise<void>(done => server.close(() => done())); await assembly.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('finite Task UI requires explicit scene, persists exact selection and refuses stale scene without fallback', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const directory = mkdtempSync(join(tmpdir(), 'p6-c-ui-'));
  const target = { providerId: 'workspace', environmentId: 'finite-fixture' };
  const scene = { id: 'fixture-v1', label: '固定合成场景', availability: 'supported' as const };
  let scenes: import('../src/contracts/desktop-scenario.js').DesktopScenarioOption[] = [scene,
    { id: 'notepad', label: 'Notepad', availability: 'unsupported' },
    { id: 'raw', label: 'RAW', availability: 'not-proven' },
    { id: 'offline', label: '断开的目标', availability: 'unavailable' }];
  const submitted: unknown[] = []; let generic = 0;
  const server = createDashboardServer(directory, {
    desktopOptions: async () => [ { ...target, kind: 'local-workspace', executable: false, scenarios: scenes },
      { ...target, environmentId: 'different-environment', kind: 'local-workspace', executable: false, scenarios: [scene] } ],
    submit() { generic++; throw new Error('no generic fallback'); },
    submitScenario(request) {
      submitted.push(request);
      const trace = new SqliteTrace(join(directory, 'web-tasks.sqlite'));
      try { trace.save('queued', { ...initialState('scene-task', 'trusted fixed goal'), taskBindingVersion: 1,
        desktopTarget: request.desktopTarget, desktopScenario: request.scenarioId }); } finally { trace.close(); }
      return 'scene-task';
    }, resume() {}, pause() {}, continue() {},
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
  const { chromium } = await import('playwright'); const browser = await chromium.launch();
  try {
    const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction(() => (document.querySelector('#task-destination') as HTMLSelectElement)?.options.length === 3);
    await page.locator('#task-goal').fill('VM: arbitrary text must never select a scene');
    assert.equal(await page.locator('#task-destination').inputValue(), 'browser');
    const key = JSON.stringify([target.providerId, target.environmentId]);
    await page.locator('#task-destination').selectOption(key);
    assert.equal(await page.locator('#task-scenario').inputValue(), '');
    assert.equal(await page.locator('#task-submit').isDisabled(), true);
    assert.equal(await page.locator('#task-goal').isDisabled(), true);
    assert.equal(await page.locator('#task-scenario option:disabled').count(), 3);
    assert.match(await page.locator('#task-scenario').textContent() || '', /不支持.*尚未验证.*不可用/);
    await page.locator('#task-scenario').selectOption(scene.id);
    await page.reload();
    await page.waitForFunction(() => (document.querySelector('#task-scenario') as HTMLSelectElement)?.value === 'fixture-v1');
    assert.equal(await page.locator('#task-destination').inputValue(), key);
    assert.equal(await page.locator('#task-goal').inputValue(), 'VM: arbitrary text must never select a scene');
    await page.locator('#task-destination').selectOption(JSON.stringify([target.providerId, 'different-environment']));
    assert.equal(await page.locator('#task-scenario').inputValue(), '');
    assert.equal(await page.locator('#task-submit').isDisabled(), true);
    await page.locator('#task-destination').selectOption(key);
    await page.locator('#task-scenario').selectOption(scene.id);
    await page.locator('#task-submit').click();
    await page.waitForURL('**/#/history?task=web-tasks.sqlite%2Fscene-task');
    assert.deepEqual(submitted, [{ desktopTarget: target, scenarioId: scene.id }]); assert.equal(generic, 0);
    await page.getByRole('button', { name: '以此任务新建草稿', exact: true }).click();
    assert.equal(await page.locator('#task-scenario').inputValue(), scene.id);
    await page.locator('#task-destination').selectOption('browser');
    assert.equal(await page.locator('#task-scenario').inputValue(), '');
    assert.equal(await page.locator('#task-goal').isDisabled(), false);
    await page.locator('#task-destination').selectOption(key); await page.locator('#task-scenario').selectOption(scene.id);
    scenes = scenes.filter(item => item.id !== scene.id);
    await page.reload();
    await page.waitForFunction(() => (document.querySelector('#task-scenario') as HTMLSelectElement)?.value === 'fixture-v1');
    assert.equal(await page.locator('#task-submit').isDisabled(), true);
    assert.equal(await page.locator('#task-scenario option:checked').evaluate((option: HTMLOptionElement) => option.disabled), true);
    await page.locator('#task-form').evaluate((form: HTMLFormElement) => form.requestSubmit());
    await page.waitForFunction(() => document.querySelector('#task-message')?.textContent?.includes('不可用'));
    assert.equal(submitted.length, 1); assert.equal(generic, 0); assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise<void>(done => server.close(() => done())); rmSync(directory, { recursive: true, force: true }); }
});

test('Task UI submits exact environment identity, preserves selection, and never routes by VM text or global control', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const directory = mkdtempSync(join(tmpdir(), 'desktop-selection-ui-'));
  const submitted: { goal: string; target: unknown }[] = [];
  const environments = [
    { providerId: 'synthetic', environmentId: 'desktop-one', kind: 'physical' as const, executable: true },
    { providerId: 'synthetic', environmentId: 'desktop-two', kind: 'physical' as const, executable: true },
    { providerId: 'workspace', environmentId: 'finite-fixture', kind: 'local-workspace' as const, executable: false },
  ];
  const controller: TaskController = {
    desktopOptions: async () => environments,
    submit(goal, options) {
      const id = `task-${submitted.length + 1}`; submitted.push({ goal, target: options?.desktopTarget });
      const trace = new SqliteTrace(join(directory, 'web-tasks.sqlite'));
      try { trace.save('queued', { ...initialState(id, goal), taskBindingVersion: 1, desktopTarget: options?.desktopTarget }); }
      finally { trace.close(); }
      return id;
    }, resume() {}, pause() {}, continue() {},
  };
  const server = createDashboardServer(directory, controller);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
  const { chromium } = await import('playwright'); const browser = await chromium.launch();
  try {
    const page = await browser.newPage(); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction(() => (document.querySelector('#task-destination') as HTMLSelectElement)?.options.length === 4);
    assert.equal(await page.locator('#task-destination option:disabled').count(), 1);
    const key = JSON.stringify(['synthetic', 'desktop-two']);
    await page.locator('#task-destination').selectOption(key);
    await page.locator('#task-goal').fill('VM: ordinary task text');
    await page.reload();
    await page.waitForFunction(expected => (document.querySelector('#task-destination') as HTMLSelectElement)?.value === expected, key);
    assert.equal(await page.locator('#task-goal').inputValue(), 'VM: ordinary task text');
    await page.locator('#task-submit').click();
    await page.waitForURL('**/#/history?task=web-tasks.sqlite%2Ftask-1');
    assert.deepEqual(submitted[0], { goal: 'VM: ordinary task text', target: { providerId: 'synthetic', environmentId: 'desktop-two' } });
    await page.getByRole('button', { name: '以此任务新建草稿', exact: true }).click();
    assert.equal(await page.locator('#task-destination').inputValue(), key);
    assert.equal(await page.locator('#task-goal').inputValue(), 'VM: ordinary task text');
    await page.locator('#task-destination').selectOption('browser');
    await page.locator('#task-submit').click();
    await page.waitForURL('**/#/history?task=web-tasks.sqlite%2Ftask-2');
    assert.deepEqual(submitted[1], { goal: 'VM: ordinary task text', target: undefined });
    await page.evaluate(() => sessionStorage.setItem('agent-desktop.task-draft.v2', JSON.stringify({ goal: 'retained draft', destination: '["synthetic","removed"]' })));
    await page.reload();
    await page.getByRole('button', { name: '工作台', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('#task-destination') as HTMLSelectElement)?.value === '["synthetic","removed"]');
    assert.equal(await page.locator('#task-submit').isDisabled(), true);
    assert.equal(await page.locator('#task-goal').inputValue(), 'retained draft');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});

test('Browser Workflow UI executes its pinned version without a desktop target or global VM readiness', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const directory = mkdtempSync(join(tmpdir(), 'browser-workflow-selection-'));
  const store = new WorkflowStore(join(directory, 'workflows.sqlite'));
  store.addCandidate({ id: 'browser-fixture', version: 1, status: 'candidate', environment: 'browser',
    taskPattern: 'browser fixture', inputs: [], preconditions: [],
    steps: [{ goal: 'fixed step', action: { kind: 'keypress', keys: 'space' }, preferredMethods: [], successCondition: { kind: 'text_includes', value: 'fixture' } }],
    successConditions: { pageTextIncludes: 'fixture' }, knownFailures: [], sourceTaskId: 'synthetic', sourceTrace: 'synthetic',
    createdAt: '', successCount: 0, failureCount: 0 });
  const submitted: unknown[] = [];
  const server = createDashboardServer(directory, {
    submit() { throw new Error('wrong route'); },
    submitWorkflow(request, _budget, target) {
      submitted.push({ request, target });
      const trace = new SqliteTrace(join(directory, 'web-tasks.sqlite'));
      try { trace.save('queued', initialState('browser-task', 'browser fixture')); } finally { trace.close(); }
      return 'browser-task';
    }, pause() {}, continue() {}, resume() {},
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
  const { chromium } = await import('playwright'); const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole('button', { name: '流程库', exact: true }).click();
    await page.locator('.workflow-card').click();
    assert.equal(await page.locator('#workflow-desktop-target').count(), 0);
    await page.getByRole('button', { name: '预览步骤（不执行）', exact: true }).click();
    await page.getByText('v1 参数预览 · 未执行任何动作', { exact: true }).waitFor();
    await page.getByRole('button', { name: '试运行此候选版本', exact: true }).click();
    await page.waitForURL('**/#/history?task=web-tasks.sqlite%2Fbrowser-task');
    const result = submitted[0] as { request: { id: string; version: number; destination: string; trial: boolean }; target: unknown };
    assert.equal(result.target, undefined); assert.equal(result.request.id, 'browser-fixture');
    assert.equal(result.request.destination, 'browser'); assert.equal(result.request.version, 1); assert.equal(result.request.trial, true);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Windows Workflow UI cannot use finite scenario support as generic execution evidence', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const directory = mkdtempSync(join(tmpdir(), 'p6-c-workflow-'));
  const store = new WorkflowStore(join(directory, 'workflows.sqlite'));
  store.addCandidate({ id: 'desktop-fixture', version: 1, status: 'candidate', environment: 'windows',
    taskPattern: 'desktop fixture', inputs: [], preconditions: [],
    steps: [{ goal: 'fixed step', action: { kind: 'keypress', keys: 'space' }, preferredMethods: [], successCondition: { kind: 'text_includes', value: 'fixture' } }],
    successConditions: { pageTextIncludes: 'fixture' }, knownFailures: [], sourceTaskId: 'synthetic', sourceTrace: 'synthetic',
    createdAt: '', successCount: 0, failureCount: 0 });
  const target = { providerId: 'workspace', environmentId: 'finite-fixture' }; let submissions = 0;
  const server = createDashboardServer(directory, {
    desktopOptions: async () => [{ ...target, kind: 'local-workspace', executable: false,
      scenarios: [{ id: 'fixture-v1', label: '合成固定场景', availability: 'supported' }] }],
    submit() { submissions++; throw new Error('forbidden'); },
    submitScenario() { submissions++; throw new Error('forbidden'); },
    submitWorkflow() { submissions++; throw new Error('forbidden'); }, pause() {}, continue() {}, resume() {},
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
  const { chromium } = await import('playwright'); const browser = await chromium.launch();
  try {
    const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole('button', { name: '流程库', exact: true }).click(); await page.locator('.workflow-card').click();
    await page.waitForFunction(() => (document.querySelector('#workflow-desktop-target') as HTMLSelectElement)?.options.length === 2);
    assert.equal(await page.locator('#workflow-desktop-target option').last().evaluate((option: HTMLOptionElement) => option.disabled), true);
    await page.getByRole('button', { name: '预览步骤（不执行）', exact: true }).click();
    await page.getByText('v1 参数预览 · 未执行任何动作', { exact: true }).waitFor();
    await page.locator('#workflow-desktop-target').evaluate((select: HTMLSelectElement) => {
      select.value = JSON.stringify(['workspace', 'finite-fixture']); select.dispatchEvent(new Event('change'));
    });
    assert.equal(await page.getByRole('button', { name: '试运行此候选版本', exact: true }).isDisabled(), true);
    assert.equal(submissions, 0);
  } finally { await browser.close(); await new Promise<void>(done => server.close(() => done())); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
