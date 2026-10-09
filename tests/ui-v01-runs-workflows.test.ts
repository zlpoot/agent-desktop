import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { createDashboardServer } from '../src/app/server.js';
import { initialState, type ComputerState } from '../src/graph/state.js';
import { SqliteTrace } from '../src/trace/sqlite-trace.js';
import { WorkflowStore } from '../src/workflows/store.js';
import type { Workflow } from '../src/workflows/schema.js';
import { workflowDigest } from '../src/workflows/recovery.js';

async function dashboard(seed: (root: string) => void, inspect: (page: Page, base: string, root: string) => Promise<void>) {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const root = mkdtempSync(join(tmpdir(), 'ui-v01-c-')); seed(root);
  const server = createDashboardServer(root, {
    submit() { assert.fail('C must not create a Task'); }, submitWorkflow() { assert.fail('preview must not execute'); },
    resume() { assert.fail('no resume'); }, pause() { assert.fail('no pause'); }, continue() { assert.fail('no continue'); },
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('port');
  const { chromium } = await import('playwright'); const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await inspect(page, `http://127.0.0.1:${address.port}`, root);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise<void>(done => server.close(() => done())); rmSync(root, { recursive: true, force: true }); }
}

function seedRuns(root: string) {
  const trace = new SqliteTrace(join(root, 'web-tasks.sqlite'));
  const target = { providerId: 'synthetic', environmentId: 'local-workspace:chrome' };
  const binding = { ...target, sessionId: 'synthetic-session', instanceId: 'synthetic-instance' };
  const done: ComputerState = { ...initialState('shared', 'synthetic done, human accepted, auto unknown'),
    status: 'done', taskBindingVersion: 1, desktopTarget: target, desktopExecutionBinding: binding,
    desktopScenario: 'synthetic-scene', desktopScenarioDispatched: true, step: 1,
    humanReview: { approved: true, note: 'synthetic owner evidence', reviewedAt: '2026-01-01T00:00:00Z', observationId: 'synthetic' },
    acceptanceReport: { mode: 'assist', verdict: 'unknown', reason: 'evidence_unavailable', observationId: 'synthetic', message: 'synthetic automatic proof missing', checks: [] } };
  trace.save('observe', { ...done, observation: { pageText: 'synthetic recorded text', textEvidence: [{ source: 'dom', text: 'synthetic recorded text' }] } });
  trace.save('decide', { ...done, lastAction: { kind: 'keypress', keys: 'space' } });
  trace.save('execute', { ...done, lastResult: { ok: true, message: 'synthetic dispatched only' } });
  trace.save('desktop_scenario_cleanup_done', done);
  trace.save('finish', done);
  trace.recordNodeMetric('shared', { step: 1, node: 'execute', actor: 'rule', operator: 'synthetic', startedAt: '2026-01-01T00:00:00Z', durationMs: 125 });
  trace.save('waiting_user', { ...initialState('waiting', 'synthetic waiting'), status: 'waiting_user',
    error: 'synthetic permission needed', lastAction: { kind: 'ask_user', question: 'synthetic question' } });
  trace.save('paused', { ...initialState('paused', 'synthetic paused Guest'), status: 'paused', taskBindingVersion: 1,
    desktopTarget: { providerId: 'hyper-v', environmentId: 'vm:synthetic' }, recoveryRequired: true, error: 'synthetic paused reason' });
  trace.save('finish', { ...initialState('failed', 'synthetic failed'), status: 'failed', error: 'synthetic execution failure' });
  trace.save('finish', { ...initialState('auto-pass', 'synthetic independent auto PASS, cleanup FAIL'), status: 'done',
    taskBindingVersion: 1, desktopTarget: target, desktopExecutionBinding: binding, desktopScenario: 'synthetic-scene',
    goalVerification: { ok: true, message: 'synthetic auto passed' },
    acceptanceReport: { mode: 'assist', verdict: 'pass', observationId: 'synthetic', message: 'synthetic auto passed', checks: [] } });
  const auto = trace.load('auto-pass')!; trace.save('desktop_scenario_cleanup_error', auto);
  // Synthetic legacy statuses are read through the production API; no new state is written by product code.
  for (const id of ['unknown', 'blocked']) trace.save('paused', { ...initialState(id, `synthetic ${id}`), status: 'paused', error: `synthetic ${id} reason` });
  trace.close();
  const db = new DatabaseSync(join(root, 'web-tasks.sqlite'));
  for (const status of ['unknown', 'blocked']) {
    const row = db.prepare('SELECT state_json FROM tasks WHERE task_id=?').get(status) as { state_json: string };
    db.prepare('UPDATE tasks SET status=?, state_json=? WHERE task_id=?').run(status, JSON.stringify({ ...JSON.parse(row.state_json), status }), status);
  }
  db.close();
  const routes = new DatabaseSync(join(root, 'web-task-routes.sqlite'));
  routes.exec('CREATE TABLE generic_routes (task_id TEXT PRIMARY KEY, environment TEXT, window_handle INTEGER, created_at TEXT NOT NULL)');
  for (const id of ['paused', 'waiting', 'failed']) routes.prepare('INSERT INTO generic_routes (task_id,created_at) VALUES (?,?)').run(id, 'synthetic');
  routes.close();
  const history = new SqliteTrace(join(root, 'runs.sqlite'));
  history.save('finish', { ...initialState('shared', 'synthetic Browser history with same ID'), status: 'done' }); history.close();
}

test('C Runs separates execution, auto, cleanup and human facts; legacy states and full source/Task ID survive refresh', { timeout: 60000 }, async () => {
  await dashboard(seedRuns, async (page, base) => {
    const writes: string[] = []; page.on('request', request => { if (request.method() === 'POST') writes.push(request.url()); });
    await page.route('**/api/desktop/control', route => route.fulfill({ json: { mode: 'PAUSED', workerReady: true, taskId: 'paused' } }));
    const open = async (id: string, source = 'web-tasks.sqlite') => {
      await page.goto(`${base}/#/history?task=${encodeURIComponent(`${source}/${id}`)}`);
      await page.waitForFunction(expected => document.querySelector('#task-id')?.textContent === `任务 ID · ${expected}` &&
        !(document.querySelector('#detail') as HTMLElement)?.hidden, id);
    };
    await open('shared');
    assert.match(await page.locator('#task-auto-fact').innerText(), /UNKNOWN.*synthetic automatic proof missing/);
    assert.match(await page.locator('#task-cleanup-fact').innerText(), /PASS/);
    assert.match(await page.locator('#task-human-fact').innerText(), /人工验收：确认完成.*synthetic owner evidence/);
    assert.match(await page.locator('#task-execution-fact').innerText(), /UNKNOWN/);
    assert.equal(await page.locator('#status').innerText(), '已完成', 'Task state must not become an auto/human verdict');
    assert.equal(await page.locator('.desktop-panel').isVisible(), false, 'independent Chrome record must not borrow paused Guest frame');
    await page.locator('.task-diagnostics > summary').click(); await page.getByRole('button', { name: '步骤证据', exact: true }).click();
    assert.match(await page.locator('#step-list').innerText(), /动作回执 成功 · 独立验证 UNKNOWN/);
    assert.doesNotMatch(await page.locator('#step-list').innerText(), /已验证/);
    assert.match(await page.locator('#step-detail').innerText(), /网页 DOM/);
    assert.match(await page.locator('#step-detail').innerText(), /125 ms/);
    assert.match(await page.locator('#step-detail').innerText(), /独立验证\s*UNKNOWN/);
    await page.getByRole('button', { name: '截图', exact: true }).click();
    assert.match(await page.locator('#screenshot').innerText(), /该步骤没有截图/);
    await page.reload(); await page.locator('#task-auto-fact').getByText(/UNKNOWN/).waitFor();
    await open('auto-pass');
    assert.match(await page.locator('#task-auto-fact').innerText(), /PASS/);
    assert.match(await page.locator('#task-cleanup-fact').innerText(), /FAIL/);
    assert.match(await page.locator('#task-human-fact').innerText(), /暂无可读取/);
    for (const [id, label] of [['waiting', '等待人工'], ['paused', '已暂停'], ['failed', '失败'], ['unknown', '结果未知'], ['blocked', '已阻断']]) {
      await open(id); assert.equal(await page.locator('#status').innerText(), label);
      assert.match(await page.locator('#task-auto-fact').innerText(), /UNKNOWN/);
      assert.match(await page.locator('#task-cleanup-fact').innerText(), /UNKNOWN/);
      assert.equal(await page.locator('#task-continue').isVisible(), id === 'paused');
      assert.equal(await page.locator('#resume-controls').isVisible(), id === 'waiting');
      if (['unknown', 'blocked'].includes(id)) assert.match(await page.locator('.request-card').innerText(), /不自动重放非幂等动作/);
      for (const name of ['接管任务', '停止任务', '紧急停止']) assert.equal(await page.locator('.unsupported-task-controls').getByRole('button', { name, exact: true }).isDisabled(), true);
    }
    await open('shared', 'runs.sqlite');
    assert.match(await page.locator('#goal').innerText(), /synthetic Browser history/);
    assert.match(await page.locator('.task-runtime-summary').innerText(), /来源：runs.sqlite/);
    assert.match(await page.locator('#task-execution-fact').innerText(), /未记录执行/);
    await page.getByRole('searchbox', { name: '搜索任务', exact: true }).fill('web-tasks.sqlite/shared');
    assert.equal(await page.locator('.run-card').count(), 1);
    assert.match(await page.locator('.run-card').innerText(), /Task ID · shared.*来源 · web-tasks.sqlite/s);
    await page.locator('.run-card').click(); await page.waitForURL('**/#/history?task=web-tasks.sqlite%2Fshared');
    await page.locator('.task-runtime-summary').getByText(/local-workspace:chrome/).waitFor();
    assert.match(await page.locator('.task-runtime-summary').innerText(), /local-workspace:chrome/);
    await page.getByRole('searchbox', { name: '搜索任务', exact: true }).fill('');
    await page.getByRole('combobox', { name: '任务记录范围', exact: true }).selectOption('history');
    assert.equal(await page.locator('.run-card').filter({ hasText: 'synthetic waiting' }).count(), 0);
    await page.getByRole('combobox', { name: '任务记录范围', exact: true }).selectOption('current');
    assert.equal(await page.locator('.run-card').filter({ hasText: 'synthetic waiting' }).count(), 1);
    await page.getByRole('combobox', { name: '筛选任务状态', exact: true }).selectOption('unknown');
    assert.equal(await page.locator('.run-card').count(), 1);
    await page.getByRole('combobox', { name: '筛选任务状态', exact: true }).selectOption('all');
    await page.getByRole('combobox', { name: '任务记录范围', exact: true }).selectOption('all');
    const screenshots = resolve('.artifacts/ui-v01-stage-c'); mkdirSync(screenshots, { recursive: true });
    for (const width of [390, 700, 900, 1366, 1440]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 768 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Runs overflow ${width}`);
      if (width === 390 || width === 1440) await page.screenshot({ path: join(screenshots, `runs-${width}.png`), fullPage: true });
    }
    await page.goto(`${base}/#/history?task=runs.sqlite%2Fmissing`);
    await page.getByText('找不到指定任务记录', { exact: true }).waitFor();
    assert.equal(await page.locator('#detail').isVisible(), false);
    assert.deepEqual(writes, []);
  });
});

function workflow(id = 'versions'): Workflow {
  return { id, version: 1, status: 'candidate', environment: 'browser', taskPattern: `synthetic ${id} {{value}}`,
    inputs: [{ name: 'value', example: 'synthetic' }], preconditions: [{ kind: 'url_host', value: 'synthetic.invalid' }],
    steps: [{ goal: 'synthetic step {{value}}', action: { kind: 'keypress', keys: 'space' }, preferredMethods: [],
      idempotent: true, successCondition: { kind: 'text_includes', value: '{{value}}' } }],
    successConditions: { pageTextIncludes: '{{value}}' }, knownFailures: [], sourceTaskId: 'synthetic-source', sourceTrace: 'runs.sqlite',
    createdAt: '', successCount: 0, failureCount: 0 };
}

function seedWorkflows(root: string) {
  const store = new WorkflowStore(join(root, 'workflows.sqlite'));
  const version1 = store.addCandidate(workflow()); store.addCandidate(workflow());
  store.recordReplay('versions', 2, 'synthetic-replay', true, undefined, undefined, 'record_only');
  store.publish('versions', 2, workflowDigest(store.get('versions', 2)!), 1, 0);
  const retired = store.addCandidate(workflow());
  const hidden = workflow('hidden-chrome-fixture');
  hidden.steps = Array.from({ length: 15 }, (_, index) => ({ ...hidden.steps[0], stepId: `synthetic-${index}`,
    goal: `synthetic step ${index + 1} {{value}}`, preferredMethods: ['owned-chrome-cdp'], idempotent: index !== 14 }));
  hidden.knownFailures = ['非幂等创建需要新增授权，结果未知禁止重试。']; store.addCandidate(hidden);
  store.addCandidate({ ...workflow('stage-fixture'), scope: 'stage', stageCondition: 'synthetic stage accepted' });
  store.close();
  const db = new DatabaseSync(join(root, 'workflows.sqlite'));
  db.prepare('UPDATE workflows SET status=?, data_json=? WHERE workflow_id=? AND version=?')
    .run('retired', JSON.stringify({ ...retired, status: 'retired' }), retired.id, retired.version);
  db.close(); return version1;
}

test('C Workflow keeps fixed lifecycle, source, steps and preview boundaries; Hidden Chrome 15-step candidate stays read-only', { timeout: 60000 }, async () => {
  await dashboard(seedWorkflows, async (page, base, root) => {
    const posts: string[] = []; page.on('request', request => { if (request.method() === 'POST') posts.push(new URL(request.url()).pathname); });
    const before = await (await page.request.get(`${base}/api/workflows`)).json();
    await page.goto(`${base}/#/workflows`); await page.locator('.workflow-card').filter({ hasText: 'hidden-chrome-fixture' }).click();
    await page.locator('.workflow-definition-steps li').nth(14).waitFor();
    assert.equal(await page.locator('.workflow-definition-steps li').count(), 15);
    assert.match(await page.locator('.workflow-definition').innerText(), /来源 Task：synthetic-source.*轨迹：runs.sqlite/s);
    assert.match(await page.locator('.workflow-restriction').innerText(), /未回放.*不允许通用回放.*未晋升/);
    const preview = async () => {
      const ack = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/preview'));
      await page.getByRole('button', { name: '预览步骤（不执行）', exact: true }).click();
      const response = await ack; assert.equal(response.status(), 200); assert.equal((await response.json()).executed, false);
      await page.getByText(/参数预览 · 未执行任何动作/).waitFor();
    };
    await page.getByLabel('value', { exact: true }).fill('synthetic input'); await preview();
    assert.equal(await page.getByRole('button', { name: '试运行此候选版本', exact: true }).isDisabled(), true);
    await page.getByText('审核并发布此候选版本', { exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '确认发布为已验证', exact: true }).isDisabled(), true);
    assert.match(await page.locator('.workflow-preview').innerText(), /非幂等步骤/);
    await page.locator('.workflow-card').filter({ hasText: '3 个版本' }).click();
    await page.getByLabel('流程版本', { exact: true }).selectOption('1');
    await page.getByLabel('value', { exact: true }).fill('first'); await preview();
    assert.equal(await page.getByRole('button', { name: '试运行此候选版本', exact: true }).isEnabled(), true);
    await page.getByLabel('value', { exact: true }).fill('changed');
    assert.match(await page.locator('.workflow-preview').innerText(), /请重新预览/);
    assert.equal(await page.getByRole('button', { name: '试运行此候选版本', exact: true }).isDisabled(), true);
    await page.getByLabel('流程版本', { exact: true }).selectOption('2');
    await page.locator('.workflow-detail').getByText('v2 · 已验证 · 整任务流程 · browser', { exact: true }).waitFor();
    assert.equal(await page.locator('.workflow-preview').innerText(), '');
    assert.equal(await page.getByLabel('value', { exact: true }).inputValue(), '');
    assert.match(await page.locator('.workflow-lifecycle').innerText(), /synthetic-replay/);
    await page.getByLabel('value', { exact: true }).fill('second'); await preview();
    assert.equal(await page.getByRole('button', { name: '执行此版本', exact: true }).isEnabled(), true);
    await page.getByLabel('流程版本', { exact: true }).selectOption('3');
    await page.locator('.workflow-restriction').getByText(/已停用/).waitFor();
    assert.equal(await page.locator('.workflow-preview').innerText(), '');
    assert.equal(await page.getByRole('button', { name: '执行此版本', exact: true }).isDisabled(), true);
    await page.getByLabel('流程状态', { exact: true }).selectOption('verified'); assert.equal(await page.locator('.workflow-card').count(), 1);
    await page.getByLabel('流程状态', { exact: true }).selectOption('retired'); assert.equal(await page.locator('.workflow-card').count(), 1);
    await page.getByLabel('流程状态', { exact: true }).selectOption('all');
    await page.locator('.workflow-card').filter({ hasText: 'stage-fixture' }).click();
    await page.locator('.workflow-restriction').getByText(/阶段上下文/).waitFor();
    assert.equal(await page.getByRole('button', { name: '试运行此候选版本', exact: true }).isDisabled(), true);
    const screenshots = resolve('.artifacts/ui-v01-stage-c'); mkdirSync(screenshots, { recursive: true });
    for (const width of [390, 700, 900, 1366, 1440]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 768 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Workflow overflow ${width}`);
      if (width === 390 || width === 1440) await page.screenshot({ path: join(screenshots, `workflow-${width}.png`), fullPage: true });
    }
    assert.deepEqual(posts, ['/api/workflows/hidden-chrome-fixture/1/preview', '/api/workflows/versions/1/preview', '/api/workflows/versions/2/preview']);
    assert.deepEqual(await (await page.request.get(`${base}/api/workflows`)).json(), before);
    assert.deepEqual((await (await page.request.get(`${base}/api/runs`)).json()).runs, []);
    assert.equal(existsSync(join(root, 'web-tasks.sqlite')), false);
  });
});

test('C preview ignores stale parameter/version responses, prevents concurrent POST, and keeps errors and empty legacy stores truthful', { timeout: 60000 }, async () => {
  await dashboard(seedWorkflows, async (page, base) => {
    let posts = 0; let release!: () => void;
    const pending = new Promise<void>(done => { release = done; });
    let received!: () => void; const requestReceived = new Promise<void>(done => { received = done; });
    await page.route('**/api/workflows/versions/1/preview', async route => {
      posts++; const response = await route.fetch(); received(); await pending; await route.fulfill({ response });
    });
    await page.goto(`${base}/#/workflows`); await page.locator('.workflow-card').filter({ hasText: '3 个版本' }).click();
    await page.getByLabel('流程版本', { exact: true }).selectOption('1'); await page.getByLabel('value', { exact: true }).fill('old');
    await page.getByRole('button', { name: '预览步骤（不执行）', exact: true }).click(); await requestReceived;
    await page.locator('.workflow-parameters').evaluate((form: HTMLFormElement) => form.requestSubmit());
    assert.equal(posts, 1);
    await page.getByLabel('value', { exact: true }).fill('new');
    await page.getByLabel('流程版本', { exact: true }).selectOption('2');
    await page.locator('.workflow-detail').getByText('v2 · 已验证 · 整任务流程 · browser', { exact: true }).waitFor();
    const staleReturned = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/1/preview')); release(); await staleReturned;
    assert.equal(await page.locator('.workflow-preview').innerText(), '');
    assert.equal(await page.getByRole('button', { name: '执行此版本', exact: true }).isDisabled(), true);
    await page.route('**/api/workflows/versions/2/preview', route => route.fulfill({ status: 400, json: { error: 'synthetic invalid parameters' } }));
    await page.getByLabel('value', { exact: true }).fill('bad'); await page.getByRole('button', { name: '预览步骤（不执行）', exact: true }).click();
    await page.locator('.workflow-preview').getByText(/synthetic invalid parameters/).waitFor();
    assert.equal(await page.getByRole('button', { name: '执行此版本', exact: true }).isDisabled(), true);
    await page.route('**/api/workflows/versions/2', route => route.fulfill({ status: 503, json: { error: 'synthetic unavailable' } }));
    await page.getByLabel('流程版本', { exact: true }).selectOption('1'); await page.getByLabel('流程版本', { exact: true }).selectOption('2');
    await page.getByRole('button', { name: '重试读取版本', exact: true }).waitFor();
    await page.route('**/api/workflows', route => route.fulfill({ json: { workflows: [], metadata: {} } }));
    await page.getByRole('button', { name: '刷新流程', exact: true }).click(); await page.getByText(/流程库为空/).waitFor();
    assert.equal(await page.locator('.workflow-card').count(), 0); assert.equal(posts, 1);
  });
});
