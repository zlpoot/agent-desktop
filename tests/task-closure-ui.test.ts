import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { chromium, type Page } from 'playwright';
import { createDashboardServer } from '../src/app/server.js';
import { DesktopTaskController } from '../src/app/task-runner.js';
import { createDefaultExtensionRegistry } from '../src/extensions/index.js';
import { FakeModel } from '../src/agent/model-adapter.js';
import { FakeRuntime } from '../src/runtime/runtime-adapter.js';
import { PlaywrightRuntime } from '../src/runtime/browser/playwright-runtime.js';
import type { PlanningModel } from '../src/contracts/model-provider.js';
import { fixtureDesktopSessions } from './fixtures/task-desktop.js';
import { createFixtureDashboard } from '../src/composition/fixture-dashboard.js';
import { ScenarioWorkspace } from '../src/testing/scenario-workspace.js';
import { createRootAssembly } from '../src/composition/root.js';
import { recoverDesktopTasks } from '../src/desktop-session/recovery.js';

async function listen(server: Server, port = 0) {
  await new Promise<void>(done => server.listen(port, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { port: address.port, base: `http://127.0.0.1:${address.port}` };
}
const close = (server: Server) => new Promise<void>(done => server.close(() => done()));
function removeFixture(directory: string, prefix: string) {
  const target = resolve(directory);
  assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith(prefix));
  rmSync(target, { recursive: true, force: true });
}
async function openRecord(page: Page, base: string, taskId: string) {
  await page.goto(`${base}/#/history?task=${encodeURIComponent(`web-tasks.sqlite/${taskId}`)}`);
  await page.reload(); // A hash change alone retains the old list; prove a fresh document read.
  await page.waitForFunction(id => document.querySelector('#task-id')?.textContent === `任务 ID · ${id}`, taskId);
}
function evidence(directory: string, taskId: string) {
  const db = new DatabaseSync(join(directory, 'web-tasks.sqlite'), { readOnly: true });
  try {
    const events = db.prepare('SELECT node, created_at FROM events WHERE task_id=? ORDER BY id').all(taskId);
    const state = JSON.parse(String(db.prepare('SELECT state_json FROM tasks WHERE task_id=?').get(taskId)?.state_json));
    return { taskId, source: 'web-tasks.sqlite', start: events[0]?.created_at, end: events.at(-1)?.created_at,
      status: state.status, desktopTarget: state.desktopTarget ?? 'browser', scene: state.desktopScenario,
      error: state.error, summary: state.summary, verification: state.goalVerification ?? 'UNKNOWN',
      independentSceneVerification: state.desktopScenarioVerification ?? 'UNKNOWN',
      nodes: events.map(event => event.node), humanAcceptance: state.humanReview ?? 'NOT HUMAN VERIFIED' };
  } finally { db.close(); }
}
function saveEvidence(name: string, facts: unknown) {
  const path = resolve('.artifacts/issue-62'); mkdirSync(path, { recursive: true });
  writeFileSync(join(path, `${name}.json`), JSON.stringify(facts, null, 2));
  console.log(`SYNTHETIC_EVIDENCE ${JSON.stringify(facts)}`);
}

test('ordinary Browser UI executes through Controller/Trace, survives refresh/restart and list-read failure', { timeout: 90000 }, async t => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const directory = mkdtempSync(join(tmpdir(), 'c-browser-loop-'));
  const resultUrl = 'http://127.0.0.1:19199/synthetic-result'; // FakeRuntime never makes a network request.
  const runtimes: Array<FakeRuntime & { closed: boolean }> = [];
  t.mock.method(PlaywrightRuntime, 'launch', async () => {
    const runtime = Object.assign(new FakeRuntime(), { closed: false, async close() { this.closed = true; } });
    runtimes.push(runtime); return runtime as unknown as PlaywrightRuntime;
  });
  let plannedGoal = '';
  const makeController = () => {
    recoverDesktopTasks(directory); // The same startup recovery called by the production Root.
    return new DesktopTaskController(directory, {
      registry: createDefaultExtensionRegistry({ rootDir: directory }),
      desktopSessions: fixtureDesktopSessions(async () => assert.fail('no Guest/native Runtime')),
      modelProvider: { createModel(options) {
        assert.deepEqual(options, { environment: 'browser', visualMode: false });
        return Object.assign(new FakeModel(plannedGoal === '等待合成人工确认'
          ? [{ kind: 'ask_user', question: '合成人工确认问题' }] : [{ kind: 'navigate', url: resultUrl }]), {
          async planTask(goal: string) {
            plannedGoal = goal;
            if (goal === '合成规划失败') throw Error('synthetic-planning-failed');
            return { task: { environment: 'browser', plan: ['打开合成结果页'], completionCriteria: { urlIncludes: '/synthetic-result' } } };
          },
          async planStage() { return { goal: plannedGoal === '等待合成人工确认' ? '等待合成人工确认' : '合成结果页已打开',
            successCondition: '/synthetic-result', isFinal: true }; },
          async verifyStage(_stage: unknown, observation: { url?: string }) {
            const ok = observation.url === resultUrl;
            return { ok, confidence: ok ? 1 : 0, evidence: observation.url ?? '', source: 'dom' as const };
          },
        }) as unknown as PlanningModel;
      } },
    });
  };
  let controller = makeController(), server = createDashboardServer(directory, controller);
  const { base, port } = await listen(server);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); const errors: string[] = [], posts: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/tasks')) posts.push(request.postData()!); });
    await page.goto(`${base}/#/settings`);
    // Save only synthetic values through the real settings form.
    await page.locator('#model-endpoint').fill('https://synthetic.invalid/v1');
    await page.locator('#model-name').fill('synthetic-ui-model');
    await page.locator('#model-key-action').selectOption('replace');
    await page.locator('#model-api-key').fill('synthetic-ui-key-never-real');
    await page.getByRole('button', { name: '保存模型配置', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#model-settings-message')?.textContent?.includes('已保存'));
    await page.getByRole('button', { name: '工作台', exact: true }).click();
    await page.locator('#task-destination').selectOption('browser');
    await page.locator('#task-goal').fill('打开合成结果页');
    const responding = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/tasks'));
    await page.locator('#task-submit').click();
    const response = await responding; assert.equal(response.status(), 202);
    const { taskId } = await response.json();
    await page.waitForFunction(() => ['已完成', '失败', '已暂停', '等待人工'].includes(document.querySelector('#status')?.textContent ?? ''));
    assert.equal(await page.locator('#status').innerText(), '已完成', JSON.stringify(evidence(directory, taskId)));
    assert.match(await page.locator('#task-execution-fact').innerText(), /成功 1/);
    assert.match(await page.locator('#goal-verification').innerText(), /PASS/);
    assert.match(await page.locator('#task-cleanup-fact').innerText(), /UNKNOWN/);
    assert.match(await page.locator('#manual-review-record').innerText(), /暂无/);
    assert.equal(await page.locator('.task-live-slot').isVisible(), false);
    assert.equal(runtimes.length, 1); assert.equal(runtimes[0].executed.length, 1); assert.equal(runtimes[0].closed, true);
    await page.reload(); await page.waitForFunction(id => document.querySelector('#task-id')?.textContent?.includes(id), taskId);
    await openRecord(page, base, taskId);
    const before = evidence(directory, taskId); assert.equal(before.status, 'done');
    // A submitted request whose response is lost still executes once and is discoverable in history.
    await page.getByRole('button', { name: '工作台', exact: true }).click();
    await page.locator('#task-destination').selectOption('browser'); await page.locator('#task-goal').fill('合成规划失败');
    let lostId = '';
    await page.route('**/api/tasks', async route => { const issued = await route.fetch(); lostId = (await issued.json()).taskId; await route.abort(); });
    await page.locator('#task-submit').click();
    await page.waitForFunction(() => document.querySelector('#task-message')?.getAttribute('data-state') === 'unknown');
    await page.unroute('**/api/tasks');
    assert.ok(lostId); await openRecord(page, base, lostId);
    await page.waitForFunction(() => document.querySelector('#status')?.textContent === '失败');
    assert.match(await page.locator('#summary').innerText(), /synthetic-planning-failed/);
    assert.equal(posts.length, 2); assert.equal(runtimes.length, 1);
    await page.getByRole('button', { name: '工作台', exact: true }).click();
    await page.locator('#task-destination').selectOption('browser'); await page.locator('#task-goal').fill('等待合成人工确认');
    const waitingResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/tasks'));
    await page.locator('#task-submit').click(); const waitingId = (await (await waitingResponse).json()).taskId;
    await page.waitForFunction(() => document.querySelector('#status')?.textContent === '等待人工');
    assert.match(await page.locator('#goal-verification').innerText(), /UNKNOWN/);
    const waitingBefore = evidence(directory, waitingId); assert.equal(waitingBefore.status, 'waiting_user');
    assert.equal(runtimes[1].executed.length, 0); assert.equal(runtimes[1].closed, true);
    await close(server); await controller.close();
    controller = makeController(); server = createDashboardServer(directory, controller); await listen(server, port);
    await openRecord(page, base, waitingId); assert.equal(await page.locator('#status').innerText(), '等待人工');
    assert.deepEqual(evidence(directory, waitingId), waitingBefore);
    await openRecord(page, base, lostId); assert.equal(await page.locator('#status').innerText(), '失败');
    assert.deepEqual(evidence(directory, taskId), before, 'restart/readback must not execute or rewrite terminal Tasks');
    // Real detail endpoint remains readable even when only the list request fails.
    await page.route('**/api/runs', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"synthetic-list-read-failure"}' }));
    assert.equal((await page.request.get(`${base}/api/runs/web-tasks.sqlite/${taskId}`)).status(), 200);
    await openRecord(page, base, taskId);
    assert.match(await page.locator('#goal-verification').innerText(), /PASS/);
    assert.match(await page.locator('#last-update').innerText(), /列表读取失败（UNKNOWN）/);
    const detailPath = `${base}/api/runs/web-tasks.sqlite/${taskId}`;
    await page.route(detailPath, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"synthetic-detail-read-failure"}' }));
    await page.reload(); await page.getByText(/任务详情暂不可用：读取失败（HTTP 503）/).waitFor();
    assert.equal(await page.locator('#empty').isVisible(), false, 'read errors must not claim the Task was removed');
    await page.unroute(detailPath);
    await page.getByRole('button', { name: '重试读取任务', exact: true }).click();
    await page.waitForFunction(id => document.querySelector('#task-id')?.textContent?.includes(id), taskId);
    assert.match(await page.locator('#goal-verification').innerText(), /PASS/);
    await page.goto(`${base}/#/history?task=web-tasks.sqlite%2Fsynthetic-missing-task`);
    await page.getByRole('heading', { name: '找不到指定任务记录', exact: true }).waitFor();
    assert.equal(await page.locator('#detail').isVisible(), false, 'confirmed 404 stays a missing Task, unlike read errors');
    assert.equal(posts.length, 3); assert.equal(runtimes.length, 2); assert.deepEqual(errors, []);
    const persistedBrowser = await (await page.request.get(detailPath)).json();
    saveEvidence('browser-loop', { success: before, executionReceipts: persistedBrowser.steps.filter((step: { resultOrigin?: string }) => step.resultOrigin === 'execute'),
      failed: { ...evidence(directory, lostId), execution: 'NOTRUN' }, waiting: { ...waitingBefore, execution: 'NOTRUN' }, posts: posts.length,
      runtimeActions: runtimes[0].executed.length, runtimeClosed: runtimes[0].closed, persistedCleanup: 'UNKNOWN', liveUat: 'NOT RUN' });
  } finally { await browser.close(); await close(server); await controller.close(); removeFixture(directory, 'c-browser-loop-'); }
});

test('dashboard fixture finite execution and uncertain dispatch retain their verdicts after refresh and assembly restart', { timeout: 90000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const directory = mkdtempSync(join(tmpdir(), 'c-finite-loop-'));
  let assembly = await createFixtureDashboard(directory);
  let server = createDashboardServer(directory, assembly.controller, undefined, undefined, undefined, undefined, undefined, true);
  const { base, port } = await listen(server); const browser = await chromium.launch({ headless: true });
  const target = { providerId: 'windows-local-workspace', environmentId: 'local-workspace:fixture' };
  const scenarioId = 'd0-fixture-text-click-v1';
  try {
    const page = await browser.newPage(); let posts = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/desktop/scenarios/tasks')) posts++; });
    async function submit() {
      await page.goto(base);
      await page.locator('#task-destination').selectOption(JSON.stringify(Object.values(target)));
      await page.locator('#task-scenario').selectOption(scenarioId);
      const responding = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/desktop/scenarios/tasks'));
      await page.locator('#task-submit').click(); const response = await responding; assert.equal(response.status(), 202);
      return (await response.json()).taskId as string;
    }
    const taskId = await submit();
    await page.waitForFunction(() => document.querySelector('#scenario-status')?.textContent?.includes('阶段：完成'));
    assert.match(await page.locator('#scenario-status').innerText(), /执行 PASS.*验证 PASS.*清理 PASS.*NOT HUMAN VERIFIED/);
    const before = evidence(directory, taskId); assert.deepEqual(before.desktopTarget, target); assert.equal(before.scene, scenarioId);
    const successResult = (await (await page.request.get(`${base}/api/runs/web-tasks.sqlite/${taskId}`)).json()).desktopScenarioResult;
    assert.ok(before.start && before.end); assert.ok(before.nodes.includes('desktop_scenario_verified'));
    await page.reload(); await openRecord(page, base, taskId);
    await close(server); await assembly.dispose();
    // Same production assembly, with an uncertain synthetic dispatch; it must not pass or replay.
    const backend = new ScenarioWorkspace(); backend.failAct = true;
    assembly = await createRootAssembly({ rootDir: directory, localWorkspace: { app: 'fixture' },
      localWorkspaceBackendFactory: () => backend, model: { createModel() { assert.fail('finite scenes never use models'); } } });
    server = createDashboardServer(directory, assembly.controller); await listen(server, port);
    await openRecord(page, base, taskId); assert.deepEqual(evidence(directory, taskId), before);
    const failedId = await submit();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent === '已暂停');
    assert.match(await page.locator('#scenario-status').innerText(), /执行 UNKNOWN.*验证 UNKNOWN.*清理 PASS/);
    const failed = evidence(directory, failedId); assert.equal(failed.status, 'paused'); assert.equal(backend.acts, 1);
    await page.reload(); await openRecord(page, base, failedId); assert.deepEqual(evidence(directory, failedId), failed);
    await close(server); await assembly.dispose(); assembly = await createFixtureDashboard(directory);
    server = createDashboardServer(directory, assembly.controller, undefined, undefined, undefined, undefined, undefined, true); await listen(server, port);
    await openRecord(page, base, failedId); assert.equal(await page.locator('#status').innerText(), '已暂停');
    const restarted = evidence(directory, failedId);
    assert.equal(restarted.status, 'paused'); assert.deepEqual(restarted.desktopTarget, target);
    assert.deepEqual(restarted.independentSceneVerification, failed.independentSceneVerification);
    assert.deepEqual(restarted.nodes, [...failed.nodes, 'host_restart']); assert.equal(posts, 2);
    const persistedResults = await (await page.request.get(`${base}/api/runs/web-tasks.sqlite/${failedId}`)).json();
    assert.equal(persistedResults.desktopScenarioResult.verification, 'UNKNOWN'); assert.equal(persistedResults.desktopScenarioResult.cleanup, 'PASS');
    saveEvidence('finite-loop', { success: { ...before, result: successResult }, failed: restarted, persistedResults: persistedResults.desktopScenarioResult,
      posts, uncertainDispatchDoesNotPass: true, liveUat: 'NOT RUN' });
  } finally { await browser.close(); await close(server); await assembly.dispose(); removeFixture(directory, 'c-finite-loop-'); }
});
