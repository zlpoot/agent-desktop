import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

test('工作台隔离当前任务与历史记录，保持控制归属及响应式布局', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    let activeStatus = 'paused', interactionKind = 'question';
    const run = (taskId: string, status: string) => ({ taskId, source: 'web-tasks.sqlite',
      goal: taskId === 'active' ? '整理当前文档' : '此前任务记录', status, plan: [], steps: [],
      error: taskId === 'active' ? '应用窗口未能启动' : undefined, recoveryRequired: taskId === 'active',
      ...(taskId === 'active' ? { status: activeStatus, interactionKind } : {}),
      completedActions: 0, completedStages: [], groundingStats: [], modelCalls: 0, modelNames: [], canPause: true });
    let active = true, controlUnavailable = false;
    const commands: string[] = [];
    let stream: import('playwright').WebSocketRoute | undefined;
    const frame = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 2048; canvas.height = 1152;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#20333e'; context.fillRect(0, 0, 2048, 1152);
      context.strokeStyle = '#8bcbbb'; context.lineWidth = 10; context.strokeRect(5, 5, 2038, 1142);
      context.fillStyle = 'white'; context.font = '50px sans-serif'; context.fillText('Desktop test fixture', 650, 570);
      return canvas.toDataURL().split(',')[1];
    });
    let receiveCommand: () => void;
    const commandReceived = new Promise<void>(resolve => { receiveCommand = resolve; });
    await page.routeWebSocket('**/stream', ws => {
      stream = ws;
      ws.send(JSON.stringify({ type: 'client', clientId: 'test-client' }));
      ws.send(Buffer.from(frame, 'base64'));
      ws.onMessage(message => { commands.push(JSON.parse(String(message)).command); receiveCommand(); });
    });
    await page.route('http://localhost:48999/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/desktop/control' && controlUnavailable) return route.fulfill({ status: 503 });
      const data = path === '/api/runs' ? { runs: [run('old', 'done'), run('active', 'paused')] }
        : path.startsWith('/api/runs/') ? run(path.split('/').at(-1)!, path.endsWith('active') ? 'paused' : 'done')
        : path === '/api/desktop/control' ? { mode: 'PAUSED', workerReady: true, taskId: active ? 'active' : null,
          connection: { status: 'ready' }, task: active ? { id: 'active', goal: '整理当前文档', status: 'paused' } : null }
        : path === '/api/desktop/sessions' ? { sessions: [{ sessionId: 'test-session', status: 'online' }] }
        : path === '/api/desktop/vm' ? { configured: false }
        : path === '/api/prompts' ? { prompts: [] } : undefined;
      if (path === '/api/settings/task-budget') return route.fulfill({ json: { budget: {
        deepseek: { maxCalls: 24, maxTokens: 60000 }, jev: { maxCalls: 120, maxTokens: 300000 },
      } } });
      if (data) return route.fulfill({ json: data });
      const file = path === '/' ? 'index.html' : path.slice(1);
      if (!['index.html', 'app.js', 'workbench.js', 'task-experience.js', 'workflow-library.js', 'runtime-plugins.js', 'style.css', 'workbench.css'].includes(file)) return route.fulfill({ status: 404 });
      await route.fulfill({ body: readFileSync(resolve('src/app/public', file)),
        contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html' });
    });
    await page.goto('http://localhost:48999/');
    await page.waitForFunction(() => document.querySelector('#goal')?.textContent === '整理当前文档');
    await page.waitForFunction(() => (document.querySelector('#desktop-frame') as HTMLImageElement)?.naturalWidth === 2048);
    assert.equal(await page.locator('#detail').isVisible(), false);
    assert.equal(await page.locator('.workspace-home').isVisible(), true);
    assert.equal(await page.locator('.desktop-panel').isVisible(), false);
    assert.equal(await page.locator('#task-controls').isVisible(), false);
    assert.equal(await page.locator('.sidebar #run-list').count(), 0);
    assert.equal(await page.locator('#run-list').isVisible(), false);
    assert.equal(await page.locator('#task-submit').isDisabled(), true, '保留任务未释放时不可提交新 Guest 任务');
    await page.getByRole('button', { name: '处理当前任务', exact: true }).click();
    await page.waitForURL('**/#/history?task=web-tasks.sqlite%2Factive');
    await page.getByRole('button', { name: '工作台', exact: true }).click();
    await page.locator('#task-destination').selectOption('host');
    assert.equal(await page.locator('#task-submit').isEnabled(), true);
    await page.locator('#task-goal').fill('未提交的草稿');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#goal')?.textContent === '整理当前文档');
    assert.equal(await page.locator('#task-goal').inputValue(), '未提交的草稿');
    assert.equal(await page.locator('#task-destination').inputValue(), 'host');
    await page.locator('#task-destination').selectOption('guest');
    await page.getByRole('button', { name: '桌面', exact: true }).click();
    assert.equal(await page.locator('#task-form').isVisible(), false);
    assert.match(await page.getByRole('region', { name: '连接检查' }).innerText(), /Worker 已就绪/);
    await page.getByRole('button', { name: '刷新连接状态', exact: true }).click();
    assert.deepEqual(commands, [], '刷新连接不发送控制命令');
    await page.getByText('连接恢复步骤', { exact: true }).click();
    assert.match(await page.locator('.desktop-recovery').innerText(), /Windows 已登录/);
    await page.getByText('连接恢复步骤', { exact: true }).click();
    controlUnavailable = true;
    await page.getByRole('button', { name: '刷新连接状态', exact: true }).click();
    await page.getByText('控制归属待确认', { exact: false }).waitFor();
    assert.equal(await page.locator('[data-desktop-command="take"]').isDisabled(), true);
    controlUnavailable = false;
    await page.getByRole('button', { name: '刷新连接状态', exact: true }).click();
    await page.locator('[data-desktop-command="take"]').click();
    await commandReceived;
    assert.deepEqual(commands, ['take']);
    await page.getByRole('button', { name: '任务', exact: true }).click();
    assert.equal(await page.locator('.history-list #run-list').isVisible(), true);
    await page.locator('.run-card').filter({ hasText: '整理当前文档' }).click();
    await page.locator('.task-live-slot .desktop-panel').waitFor();
    assert.equal(await page.locator('#desktop-frame').count(), 1, '实时桌面不复制，保持同一输入绑定');
    assert.equal(await page.locator('#task-recorded').isVisible(), false);
    assert.match(await page.locator('.task-issue').innerText(), /应用窗口未能启动/);
    assert.doesNotMatch(await page.locator('.request-card').innerText(), /Host 重启/);
    await page.route('**/api/runs/web-tasks.sqlite/old', route => route.fulfill({ status: 503 }));
    await page.getByRole('button', { name: /此前任务记录/ }).click();
    await page.getByRole('button', { name: '重试读取任务', exact: true }).waitFor();
    assert.equal(await page.locator('#detail').isVisible(), false, '失败后不能显示上一任务的详情或操作');
    await page.unroute('**/api/runs/web-tasks.sqlite/old');
    await page.getByRole('button', { name: '重试读取任务', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#goal')?.textContent === '此前任务记录');
    assert.match(page.url(), /#\/history\?task=web-tasks.sqlite%2Fold/);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#goal')?.textContent === '此前任务记录');
    assert.equal(await page.locator('.desktop-panel').isVisible(), false);
    assert.equal(await page.locator('#task-recorded').isVisible(), true);
    assert.match(await page.locator('#task-recorded').innerText(), /尚无已记录截图/);
    assert.equal(await page.locator('.request-card').isVisible(), false, '完成任务不展示暂停处理框');
    assert.match(await page.locator('.task-context').innerText(), /任务记录/);
    await page.getByRole('button', { name: '工作台', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#goal')?.textContent === '整理当前文档');
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('#goal')?.textContent === '此前任务记录');
    await page.goForward();
    await page.waitForFunction(() => document.querySelector('#goal')?.textContent === '整理当前文档');
    assert.equal(await page.locator('.desktop-panel').isVisible(), false);
    assert.equal(await page.locator('#task-form').isVisible(), true);
    assert.equal(await page.locator('#run-list').isVisible(), false);
    await page.route('**/api/prompts', route => route.fulfill({ status: 503, json: { error: '测试读取失败' } }), { times: 1 });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '重试读取提示词', exact: true }).waitFor();
    assert.equal(await page.locator('#prompt-save').isDisabled(), true);
    await page.route('**/api/prompts', route => route.fulfill({ json: { prompts: [{ id: 'test', label: '测试提示词', content: '原文' }, { id: 'second', label: '另一个提示词', content: '另一原文' }] } }), { times: 1 });
    await page.getByRole('button', { name: '重试读取提示词', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#prompt-save')?.getAttribute('disabled') === null);
    await page.locator('#prompt-content').fill('保留编辑内容');
    await page.locator('#prompt-select').selectOption('second');
    assert.equal(await page.locator('#prompt-content').inputValue(), '另一原文');
    await page.locator('#prompt-select').selectOption('test');
    assert.equal(await page.locator('#prompt-content').inputValue(), '保留编辑内容', '切换提示词保留独立草稿');
    await page.route('**/api/prompts/test', route => route.fulfill({ status: 503, json: { error: '测试保存失败' } }));
    await page.locator('#prompt-save').click();
    await page.getByText(/保存未确认：测试保存失败/).waitFor();
    assert.equal(await page.locator('#prompt-content').inputValue(), '保留编辑内容');
    assert.equal(await page.locator('#prompt-content').isVisible(), true);
    assert.equal(await page.getByRole('heading', { name: '任务运行配置', exact: true }).isVisible(), true);
    assert.equal(await page.locator('.desktop-panel').isVisible(), false);
    await page.getByRole('button', { name: '工作台', exact: true }).click();
    active = false;
    await page.waitForFunction(() => document.querySelector('#detail')?.hasAttribute('hidden'));
    assert.match(await page.locator('.home-current').innerText(), /当前没有活动任务/);
    await page.getByRole('button', { name: '任务', exact: true }).click();
    await page.getByRole('searchbox', { name: '搜索任务' }).fill('不存在');
    assert.equal(await page.locator('.run-card').count(), 0);
    await page.getByRole('searchbox', { name: '搜索任务' }).fill('');
    await page.getByRole('button', { name: '工作台', exact: true }).click();
    for (const width of [1440, 800, 390]) {
      await page.getByRole('button', { name: '工作台', exact: true }).click();
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.waitForFunction(() => window.scrollY === 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `设置溢出 ${width}`);
      await page.getByRole('button', { name: '桌面', exact: true }).click();
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `横向溢出 ${width}`);
      assert.equal(await page.locator('#desktop-frame').evaluate(image => {
        const rect = image.getBoundingClientRect();
        const parent = image.parentElement!.getBoundingClientRect();
        return rect.width <= parent.width && rect.height <= parent.height && Math.abs(rect.width / rect.height - 2048 / 1152) < 0.02;
      }), true, `画面比例或裁切 ${width}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    mkdirSync(resolve('.artifacts/web-workbench'), { recursive: true });
    await page.screenshot({ path: resolve('.artifacts/web-workbench/desktop.png'), fullPage: true });
    stream!.close();
    await page.waitForFunction(() => document.querySelector('.frame-freshness')?.textContent?.includes('画面已过期'));
    assert.equal(await page.locator('#desktop-frame').isVisible(), true);
    await page.goto('http://localhost:48999/#/history?task=web-tasks.sqlite%2Factive');
    await page.waitForFunction(() => document.querySelector('#goal')?.textContent === '整理当前文档');
    assert.equal(await page.locator('.desktop-panel').isVisible(), false, '失去服务端归属的任务不显示实时桌面');
    assert.equal(await page.locator('#task-recorded').isVisible(), true);
    for (const width of [1440, 800, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `任务详情溢出 ${width}`);
    }
    for (const [kind, heading, button] of [['question', '需要补充信息', '提交回答'], ['approval', '需要批准下一步动作', '允许执行'], ['final_review', '请确认最终结果', '确认完成']]) {
      activeStatus = 'waiting_user'; interactionKind = kind;
      await page.reload();
      await page.getByRole('heading', { name: heading, exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: button, exact: true }).isVisible(), true);
      assert.equal(await page.locator('.desktop-panel').isVisible(), false);
    }
    activeStatus = 'failed'; await page.reload();
    await page.getByRole('heading', { name: '任务未完成', exact: true }).waitFor();
    assert.match(await page.locator('.task-issue').innerText(), /应用窗口未能启动/);
    assert.equal(await page.locator('#task-continue').isVisible(), false);
    await page.goto('http://localhost:48999/#/history?task=web-tasks.sqlite%2Fmissing');
    await page.getByRole('heading', { name: '找不到指定任务记录' }).waitFor();
    assert.equal(await page.locator('#detail').isVisible(), false);
    await page.goto('http://localhost:48999/?legacy=1');
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('workbench')), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
