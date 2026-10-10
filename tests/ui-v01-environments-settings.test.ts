import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { managementFixture } from './fixtures/app-management.js';
import { globalTaskBudget } from '../src/runtime/model-budget.js';

async function layouts(page: Page, name: string) {
  const directory = resolve('.artifacts/ui-v01-stage-d'); mkdirSync(directory, { recursive: true });
  for (const width of [390, 601, 668, 700, 900, 1366, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 598 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} overflow ${width}`);
    const label = name === 'environments' ? '刷新环境目录' : name === 'apps' ? '扫描 / 重扫' : '保存全局预算';
    const button = page.getByRole('button', { name: label, exact: true });
    await button.scrollIntoViewIfNeeded();
    assert.equal(await button.evaluate(element => { const box = element.getBoundingClientRect(); return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') === element; }), true, `${name} occluded ${width}`);
    await button.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    assert.equal(await button.evaluate(element => document.activeElement === element && getComputedStyle(element).outlineStyle !== 'none'), true, `${name} keyboard focus ${width}`);
    if (width === 390 || width === 1440) await page.screenshot({ path: join(directory, `${name}-${width}.png`), fullPage: true });
  }
}

test('D directory keeps environment admission, Session and app phases separate; explicit links and late/error/empty reads never execute', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const f = await managementFixture(); const { chromium } = await import('playwright'); const browser = await chromium.launch({ headless: true });
  let release: (() => void) | undefined;
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); const errors: string[] = [], writes: Record<string, unknown>[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST') { assert.ok(request.url().endsWith('/api/desktop/apps')); writes.push(request.postDataJSON()); } });
    await page.goto(`${f.base}/#/desktop`); await page.locator('.environment-card').nth(3).waitFor();
    assert.equal(writes.length, 0);
    assert.match(await page.locator('.environment-catalog').innerText(), /Physical Desktop.*Local Workspace/s);
    const local = page.locator('.environment-card').filter({ hasText: 'local-workspace / hidden' });
    assert.match(await local.innerText(), /通用任务接口：未开放.*Session：未记录匹配绑定.*Target readiness.*目录未提供/s);
    assert.doesNotMatch(await local.innerText(), /离线|未配置 VM/);
    await page.getByText('能力声明与当前就绪的区别', { exact: true }).click();
    for (const state of ['supported', 'unsupported', 'not-proven', 'forbidden']) assert.match(await page.locator('.capability-legend').innerText(), new RegExp(state));
    await layouts(page, 'environments');
    await page.getByRole('searchbox', { name: '搜索执行环境' }).fill('vm:a'); assert.equal(await page.locator('.environment-card').count(), 1);
    await page.getByRole('button', { name: '查看此环境的应用', exact: true }).click();
    await page.locator('#apps-status').getByText(/配置已读取/).waitFor();
    assert.match(page.url(), /#\/environments\?view=apps/);
    assert.equal(await page.locator('#apps-environment').inputValue(), JSON.stringify(['hyper-v', 'vm:a']));
    assert.match(await page.locator('#apps-phases').innerText(), /尚无候选记录.*0 个当前配置已确认.*仅为历史事实.*not-proven/s);
    await layouts(page, 'apps');
    assert.ok(f.backends.every(item => item.scans === 0 && item.starts === 0));
    await page.goto(`${f.base}/#/environments`); await page.locator('.environment-card').first().waitFor();
    await page.getByRole('searchbox', { name: '搜索执行环境' }).fill('');
    await page.getByRole('combobox', { name: '环境类型', exact: true }).selectOption('physical'); assert.equal(await page.locator('.environment-card').count(), 1);
    await page.getByRole('button', { name: '查看此环境的应用', exact: true }).click();
    await page.locator('#apps-capability').getByText(/physical-generic-not-supported/).waitFor();
    assert.equal(await page.getByRole('button', { name: '查看确认内容', exact: true }).isDisabled(), true);
    await page.route('**/api/desktop/sessions', route => route.fulfill({ json: { sessions: [
      { sessionId: 'synthetic-a', vmId: 'a', status: 'offline', lastError: 'synthetic-worker-timeout' },
      { sessionId: 'synthetic-b', providerId: 'hyper-v', environmentId: 'vm:b', status: 'connecting' },
    ] } }));
    await page.locator('.workspace-nav').getByRole('button', { name: '环境与应用', exact: true }).click();
    await page.getByRole('combobox', { name: '环境类型', exact: true }).selectOption('all');
    await page.locator('.environment-card').filter({ hasText: 'hyper-v / vm:a' }).getByText(/synthetic-worker-timeout/).waitFor();
    assert.match(await page.locator('.environment-card').filter({ hasText: 'hyper-v / vm:b' }).innerText(), /synthetic-b.*connecting/s);
    assert.doesNotMatch(await local.innerText(), /synthetic-a|synthetic-b|synthetic-worker-timeout/);
    await page.unroute('**/api/desktop/sessions');
    await page.route('**/api/desktop/sessions', route => route.fulfill({ status: 503, json: { error: 'synthetic session unavailable' } }));
    await page.getByRole('button', { name: '刷新环境目录', exact: true }).click();
    await page.locator('.environment-card').filter({ hasText: 'hyper-v / vm:a' }).getByText(/Session 读取失败/).waitFor();
    assert.doesNotMatch(await local.innerText(), /连接 offline|synthetic-worker-timeout/);
    await page.unroute('**/api/desktop/sessions');
    await page.getByRole('button', { name: '已接入应用', exact: true }).click();
    // A directory response that returns after leaving must not select or reopen an app environment.
    let received!: () => void; const entered = new Promise<void>(done => { received = done; });
    const waiting = new Promise<void>(done => { release = done; });
    await page.route('**/api/desktop/environments', async route => { const response = await route.fetch(); received(); await waiting; await route.fulfill({ response }); });
    await page.locator('.workspace-nav').getByRole('button', { name: '环境与应用', exact: true }).click(); await entered;
    await page.getByRole('button', { name: '已接入应用', exact: true }).click();
    const returned = page.waitForResponse(response => response.url().endsWith('/api/desktop/environments')); release!(); release = undefined; await returned;
    assert.equal(await page.locator('#apps-environment').inputValue(), '');
    assert.equal(await page.locator('#apps-confirmation').textContent(), '');
    await page.unroute('**/api/desktop/environments');
    await page.route('**/api/desktop/environments', route => route.fulfill({ status: 503, json: { error: 'synthetic directory unavailable' } }));
    await page.getByRole('button', { name: '环境', exact: true }).click(); await page.locator('.environment-catalog').getByText(/环境目录读取失败/).waitFor();
    assert.equal(await page.locator('.environment-card').count(), 0);
    await page.getByRole('searchbox', { name: '搜索执行环境' }).fill('unknown');
    assert.match(await page.locator('#environment-missing-status').innerText(), /UNKNOWN.*读取失败不等于未配置/);
    assert.equal(await page.locator('.environment-card').count(), 0);
    await page.getByRole('searchbox', { name: '搜索执行环境' }).fill('');
    await page.unroute('**/api/desktop/environments'); await page.route('**/api/desktop/environments', route => route.fulfill({ json: { environments: [] } }));
    await page.getByRole('button', { name: '刷新环境目录', exact: true }).click(); await page.getByText('目录中没有已注册环境；没有自动创建或连接。', { exact: true }).waitFor();
    assert.ok(writes.every(item => ['open', 'close'].includes(String(item.action))));
    assert.ok(f.backends.every(item => item.scans === 0 && item.starts === 0)); assert.deepEqual(f.counts(), { models: 0, runtime: 0, leases: 0 }); assert.deepEqual(errors, []);
  } finally { release?.(); await browser.close(); await f.close(); }
});

test('D P1 preserves old offline and new online Sessions for one VM without choosing active ownership or overriding explicit identities', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const f = await managementFixture(); const { chromium } = await import('playwright'); const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); const errors: string[] = []; let posts = 0;
    page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (request.method() === 'POST') posts++; });
    // Same ascending creation order as the legacy API; later online is not proof of active ownership.
    await page.route('**/api/desktop/sessions', route => route.fulfill({ json: { sessions: [
      { sessionId: 'old-offline', vmId: 'a', status: 'offline', createdAt: '2026-01-01T00:00:00Z', lastSeenAt: '2026-01-01T01:00:00Z', lastError: 'synthetic-old-worker-timeout' },
      { sessionId: 'new-online', vmId: 'a', status: 'online', createdAt: '2026-01-02T00:00:00Z', lastSeenAt: '2026-01-02T01:00:00Z' },
      { sessionId: 'explicit-other-vm', providerId: 'hyper-v', environmentId: 'vm:b', vmId: 'a', status: 'offline' },
      { sessionId: 'partial-provider', providerId: 'physical', vmId: 'a', status: 'offline' },
      { sessionId: 'partial-environment', environmentId: 'vm:b', vmId: 'a', status: 'offline' },
    ] } }));
    await page.goto(`${f.base}/#/environments`); await page.locator('.environment-card').nth(3).waitFor();
    const vm = page.locator('.environment-card').filter({ hasText: 'hyper-v / vm:a' });
    assert.equal(await vm.locator('.environment-sessions li').count(), 2);
    assert.match(await vm.innerText(), /2 条匹配 Session 记录.*活跃归属 UNKNOWN.*old-offline.*连接 offline.*2026-01-01T00:00:00Z.*2026-01-01T01:00:00Z.*synthetic-old-worker-timeout.*new-online.*连接 online.*2026-01-02T00:00:00Z.*2026-01-02T01:00:00Z/s);
    assert.doesNotMatch(await vm.innerText(), /explicit-other-vm|partial-provider|partial-environment/);
    const other = page.locator('.environment-card').filter({ hasText: 'hyper-v / vm:b' });
    assert.equal(await other.locator('.environment-sessions li').count(), 1);
    assert.match(await other.innerText(), /explicit-other-vm/); assert.doesNotMatch(await other.innerText(), /old-offline|new-online|partial-/);
    for (const identity of ['physical / host', 'local-workspace / hidden']) {
      const card = page.locator('.environment-card').filter({ hasText: identity });
      assert.match(await card.innerText(), /Session：未记录匹配绑定.*UNKNOWN/s);
      assert.doesNotMatch(await card.innerText(), /old-offline|new-online|synthetic-old-worker-timeout|explicit-other-vm|partial-/);
    }
    await layouts(page, 'environments');
    assert.equal(posts, 0); assert.deepEqual(errors, []); assert.deepEqual(f.counts(), { models: 0, runtime: 0, leases: 0 });
    assert.ok(f.backends.every(item => item.scans === 0 && item.starts === 0));
  } finally { await browser.close(); await f.close(); }
});

test('D settings show actual scope, fail closed on read/save errors, keep drafts and focus, and never save unsupported settings', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const f = await managementFixture(); const { chromium } = await import('playwright'); const browser = await chromium.launch({ headless: true });
  let release: (() => void) | undefined;
  try {
    const page = await browser.newPage(); const errors: string[] = []; let unavailable = true, puts = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/settings/task-budget', route => unavailable && route.request().method() === 'GET'
      ? route.fulfill({ status: 503, json: { error: 'synthetic budget unavailable' } }) : route.continue());
    await page.goto(`${f.base}/#/settings`); await page.locator('#global-budget-message').getByText(/预算读取失败/).waitFor();
    const save = page.getByRole('button', { name: '保存全局预算', exact: true }); assert.equal(await save.isDisabled(), true);
    assert.equal(await page.locator('.planned-setting button:disabled').count(), 3);
    assert.match(await page.locator('.planned-settings').innerText(), /待后端接入.*权限.*不能修改或扩大许可/s);
    unavailable = false; await page.getByRole('button', { name: '重新读取全局预算', exact: true }).click();
    await page.locator('#global-budget-message').getByText(/已读取本机生效/).waitFor();
    const input = page.locator('#global-budget-deepseek-maxCalls'); await input.fill('-1'); await save.click();
    assert.equal(await input.getAttribute('aria-invalid'), 'true'); assert.equal(await input.evaluate(element => document.activeElement === element), true);
    await input.fill('7');
    let received!: () => void; const entered = new Promise<void>(done => { received = done; }); const waiting = new Promise<void>(done => { release = done; });
    await page.unroute('**/api/settings/task-budget');
    await page.route('**/api/settings/task-budget', async route => {
      if (route.request().method() !== 'PUT') return route.continue();
      puts++; const response = await route.fetch(); received(); await waiting; await route.fulfill({ response });
    });
    await save.click(); await entered; assert.equal(await input.isDisabled(), true);
    await save.dispatchEvent('click'); assert.equal(puts, 1);
    release!(); release = undefined; await page.getByText('已保存，后续新任务将使用这些默认值', { exact: true }).waitFor();
    assert.equal(globalTaskBudget(f.dir).deepseek.maxCalls, 7);
    await input.fill('8'); await page.getByRole('button', { name: '插件与扩展', exact: true }).click();
    await page.locator('.runtime-status').getByText(/个装配插件|未提供 Cordis 装配快照/).waitFor();
    assert.match(page.url(), /#\/settings\?view=plugins/);
    await page.getByRole('button', { name: '预算与提示词', exact: true }).click(); assert.equal(await input.inputValue(), '8');
    assert.match(await page.locator('#global-budget-message').innerText(), /尚未保存/);
    await page.unroute('**/api/settings/task-budget');
    await page.route('**/api/settings/task-budget', route => route.request().method() === 'PUT'
      ? (puts++, route.fulfill({ status: 503, json: { error: 'synthetic save unavailable' } })) : route.continue());
    await save.click(); await page.locator('#global-budget-message').getByText(/保存未确认/).waitFor();
    assert.equal(await input.inputValue(), '8'); assert.equal(globalTaskBudget(f.dir).deepseek.maxCalls, 7); assert.equal(puts, 2);
    await layouts(page, 'settings');
    await page.getByRole('button', { name: '预算与提示词', exact: true }).focus(); await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('button', { name: '插件与扩展', exact: true }).evaluate(element => document.activeElement === element), true);
    assert.equal(await page.getByRole('button', { name: '插件与扩展', exact: true }).evaluate(element => getComputedStyle(element).outlineStyle !== 'none'), true);
    assert.ok(f.backends.every(item => item.scans === 0 && item.starts === 0)); assert.deepEqual(f.counts(), { models: 0, runtime: 0, leases: 0 }); assert.deepEqual(errors, []);
  } finally { release?.(); await browser.close(); await f.close(); }
});
