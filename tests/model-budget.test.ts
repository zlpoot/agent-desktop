import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { MemorySaver } from '@langchain/langgraph';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ChatCompletionsModel } from '../src/agent/chat-completions-model.js';
import { JevChoiceModel } from '../src/agent/jev-choice-model.js';
import { createDashboardServer } from '../src/app/server.js';
import type { TaskController } from '../src/app/task-runner.js';
import { initialState } from '../src/graph/state.js';
import { createAgentLoop } from '../src/graph/graph.js';
import { FakeRuntime } from '../src/runtime/runtime-adapter.js';
import { SqliteTrace } from '../src/trace/sqlite-trace.js';
import { createTaskBudget, currentBudgetStopReason, globalTaskBudget, readTaskBudget,
  meteredModelRequest, runWithTaskBudget, saveGlobalTaskBudget } from '../src/runtime/model-budget.js';

test('全局预算在提交时固定快照，单次覆盖只改变该任务', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-budget-'));
  try {
    const baseline = globalTaskBudget(dir);
    assert.equal(baseline.deepseek.maxCalls, 24);
    saveGlobalTaskBudget(dir, { deepseek: { maxCalls: 4, maxTokens: 80 }, jev: { maxCalls: 40, maxTokens: 900 } });
    createTaskBudget(dir, 'one');
    createTaskBudget(dir, 'two', { deepseek: { maxCalls: 2 } });
    assert.deepEqual(readTaskBudget(dir, 'one')?.limits.deepseek, { maxCalls: 4, maxTokens: 80 });
    assert.deepEqual(readTaskBudget(dir, 'two')?.limits.deepseek, { maxCalls: 2, maxTokens: 80 });
    assert.deepEqual(readTaskBudget(dir, 'two')?.limits.jev, { maxCalls: 40, maxTokens: 900 });
    saveGlobalTaskBudget(dir, { deepseek: { maxCalls: 9, maxTokens: 100 }, jev: { maxCalls: 60, maxTokens: 1000 } });
    assert.equal(readTaskBudget(dir, 'one')?.limits.deepseek.maxCalls, 4);
    assert.equal(createTaskBudget(dir, 'three').limits.deepseek.maxCalls, 9);
    assert.throws(() => createTaskBudget(dir, 'bad', { deepseek: { maxCalls: 0 } }), /整数/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('规划解析失败仍计 DeepSeek 用量，达到次数后阻止下一请求；JEV 独立记账', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-budget-model-'));
  let deepseekCalls = 0, jevCalls = 0;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/chat/completions') {
      deepseekCalls++;
      response.end(JSON.stringify({ choices: [{ message: { content: 'invalid plan' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
    } else if (request.url === '/v1/systemone') {
      jevCalls++;
      response.end(JSON.stringify({ answers: { next_action: { type: 'choice', choice: 'action_0', confidence: 0.98 } },
        usage: { input_tokens: 4, output_tokens: 2 } }));
    } else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no server');
  try {
    createTaskBudget(dir, 'task', { deepseek: { maxCalls: 1 }, jev: { maxCalls: 1 } });
    const deepseek = new ChatCompletionsModel({ baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: 'test', model: 'deepseek-test' });
    const jev = new JevChoiceModel({ baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: 'test', candidateActions: () => [{ kind: 'done', summary: '结束' }] });
    await runWithTaskBudget(dir, 'task', async () => {
      await assert.rejects(() => deepseek.planTask('测试'), /规划|JSON|解析|格式/);
      assert.equal(readTaskBudget(dir, 'task')?.usage.deepseek.tokens, 5);
      assert.match(currentBudgetStopReason() ?? '', /deepseek 预算已用尽/);
      await assert.rejects(() => deepseek.planTask('测试'), /预算已用尽/);
      assert.deepEqual(await jev.decide(initialState('task', '测试')), { kind: 'done', summary: '结束' });
      await assert.rejects(() => jev.decide(initialState('task', '测试')), /预算已用尽/);
    });
    assert.equal(deepseekCalls, 1);
    assert.equal(jevCalls, 1);
    assert.deepEqual(readTaskBudget(dir, 'task')?.usage,
      { deepseek: { calls: 1, tokens: 5, unreportedCalls: 0 },
        jev: { calls: 1, tokens: 6, unreportedCalls: 0 } });
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('重新进入任务预算上下文后沿用原上限与累计用量', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-budget-resume-'));
  try {
    createTaskBudget(dir, 'resumed', { deepseek: { maxCalls: 2, maxTokens: 10 } });
    let dispatched = 0;
    const request = () => meteredModelRequest('deepseek', async () => {
      dispatched++;
      return { usage: { total_tokens: 6 } };
    });
    await runWithTaskBudget(dir, 'resumed', request);
    // The next invocation uses a fresh async context and reopens the persisted SQLite row.
    saveGlobalTaskBudget(dir, { deepseek: { maxCalls: 100, maxTokens: 1000 },
      jev: { maxCalls: 100, maxTokens: 1000 } });
    await runWithTaskBudget(dir, 'resumed', async () => {
      assert.equal(readTaskBudget(dir, 'resumed')?.usage.deepseek.calls, 1);
      await request();
      assert.match(currentBudgetStopReason() ?? '', /deepseek 预算已用尽/);
      await assert.rejects(request, /预算已用尽/);
    });
    assert.equal(dispatched, 2);
    assert.deepEqual(readTaskBudget(dir, 'resumed')?.limits.deepseek,
      { maxCalls: 2, maxTokens: 10 });
    assert.deepEqual(readTaskBudget(dir, 'resumed')?.usage.deepseek,
      { calls: 2, tokens: 12, unreportedCalls: 0 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('预算设置 API 拒绝跨站修改并校验输入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-budget-api-'));
  const server = createDashboardServer(dir);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no server');
  const url = `http://127.0.0.1:${address.port}/api/settings/task-budget`;
  try {
    assert.equal((await fetch(url).then(response => response.json()) as { budget: { deepseek: { maxCalls: number } } })
      .budget.deepseek.maxCalls, 24);
    const put = (body: unknown, origin?: string) => fetch(url, { method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(body) });
    const valid = { deepseek: { maxCalls: 3, maxTokens: 100 }, jev: { maxCalls: 20, maxTokens: 1000 } };
    assert.equal((await put(valid, 'http://evil.example')).status, 403);
    assert.equal((await put({ ...valid, deepseek: { maxCalls: 0, maxTokens: 100 } })).status, 400);
    assert.equal((await put(valid)).status, 200);
    assert.equal(globalTaskBudget(dir).deepseek.maxCalls, 3);
    const trace = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
    try { trace.save('queued', initialState('api-run', '测试预算展示')); }
    finally { trace.close(); }
    createTaskBudget(dir, 'api-run');
    const detail = await fetch(`http://127.0.0.1:${address.port}/api/runs/web-tasks.sqlite/api-run`)
      .then(response => response.json()) as { taskBudget: { limits: { deepseek: { maxCalls: number } } } };
    assert.equal(detail.taskBudget.limits.deepseek.maxCalls, 3);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('达到任务内调用上限后在执行前安全暂停，不发送待执行动作', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-budget-graph-'));
  const trace = new SqliteTrace(join(dir, 'trace.sqlite'));
  try {
    createTaskBudget(dir, 'graph', { deepseek: { maxCalls: 1 } });
    const runtime = new FakeRuntime();
    const graph = createAgentLoop({ runtime, trace, checkpointer: new MemorySaver(),
      model: { name: 'budget-test', kind: 'model', decide: async () => {
        await meteredModelRequest('deepseek', async () => ({ usage: { total_tokens: 3 } }));
        return { kind: 'navigate', url: 'https://example.com' };
      } } });
    await runWithTaskBudget(dir, 'graph', () => graph.invoke(initialState('graph', '打开页面'),
      { configurable: { thread_id: 'graph' } }));
    assert.equal(trace.load('graph')?.status, 'paused');
    assert.match(trace.load('graph')?.summary ?? '', /预算已用尽/);
    assert.equal(runtime.executed.length, 0);
    assert.equal(readTaskBudget(dir, 'graph')?.usage.deepseek.calls, 1);
  } finally { trace.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('网页设置全局预算并在单次任务提交中覆盖，空白字段继承全局值', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-budget-ui-'));
  let submitted: unknown;
  const controller: TaskController = { submit(_goal, options) { submitted = options?.budget; return 'budget-ui-task'; },
    resume() {}, pause() {}, continue() {} };
  const server = createDashboardServer(dir, controller);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no server');
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(process.cwd(), '.playwright-browsers');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.locator('.workspace-nav').getByRole('button', { name: '设置' }).click();
    await page.waitForFunction(() => (document.querySelector('#global-budget-deepseek-maxCalls') as HTMLInputElement)?.value === '24');
    await page.locator('#global-budget-deepseek-maxCalls').fill('7');
    await page.getByRole('button', { name: '保存全局预算' }).click();
    await page.getByText('已保存，后续新任务将使用这些默认值').waitFor();
    assert.equal(globalTaskBudget(dir).deepseek.maxCalls, 7);
    await page.locator('.workspace-nav').getByRole('button', { name: '工作台' }).click();
    await page.locator('#task-destination').selectOption('browser');
    await page.waitForFunction(() => document.querySelector('#task-preview-summary')?.textContent?.includes('DeepSeek 7 次'));
    await page.locator('#task-goal').fill('整理文档');
    await page.getByText('完成条件、操作限制与单次预算（可选）').click();
    await page.locator('#task-deepseekCalls').fill('2');
    await page.getByRole('button', { name: /发送任务/ }).click();
    await page.waitForFunction(() => document.querySelector('#task-message')?.textContent?.includes('budget-ui-task'));
    assert.deepEqual(submitted, { deepseek: { maxCalls: 2 } });
  } finally {
    await browser.close();
    await new Promise<void>(done => server.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  }
});
