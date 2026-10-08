import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { preflightFixture } from './fixtures/dashboard-preflight.js';

test('B Browser preview separates discovery/history/bridge/consent and never dispatches or auto-selects; switching/reload clear selection', { timeout: 60000 }, async () => {
  const f = await preflightFixture({ mode: 'bridge-preview' });
  const { chromium } = await import('playwright'); const browser = await chromium.launch();
  try {
    const page = await browser.newPage(), requests: { action: string }[] = [], errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().endsWith('/api/desktop/apps')) requests.push(request.postDataJSON()); });
    await page.goto(`${f.base}/#/apps`);
    await page.waitForFunction(() => (document.querySelector('#apps-environment') as HTMLSelectElement)?.options.length === 4);
    assert.equal(await page.title(), 'Agent Desktop · P8-B 任务桥接只读预览');
    assert.equal(await page.locator('#apps-environment').inputValue(), ''); assert.equal(requests.length, 0);
    const preview = page.locator('#bridge-test-preview');
    assert.match(await preview.innerText(), /不会执行.*不自动选择.*网易云音乐.*3\.1\.40\.205461.*尚未验证.*发现候选.*历史启动验证.*任务桥接.*不可用.*受控实测.*尚未授权/s);
    assert.match(await preview.innerText(), /孙燕姿《我怀念的》.*单独授权/s);
    assert.match(await preview.innerText(), /候选环境：.*当前未配置，不可用/);
    assert.match(await preview.innerText(), /原目标窗口.*撤销授权成功后.*拒绝所有新动作/s);
    assert.equal(await preview.locator('button,input').count(), 0);
    for (const name of ['扫描 / 重扫', '指定路径', '查看确认内容']) {
      assert.equal(await page.getByRole('button', { name, exact: true }).isDisabled(), true);
    }
    const key = (index: number) => JSON.stringify([f.scopes[index].providerId, f.scopes[index].environmentId]);
    await page.locator('#apps-environment').selectOption(key(0));
    await page.waitForFunction(() => document.querySelector('#apps-status')?.textContent?.includes('P8-B 只读预览'));
    assert.match(await page.locator('#apps-capability').innerText(), /任务桥接：不可用.*原启动窗口绑定.*受控实测：尚未授权/s);
    await page.locator('#apps-environment').selectOption(key(1));
    await page.waitForFunction(() => document.querySelector('#apps-capability')?.textContent?.includes('现有工作区只支持'));
    assert.match(await page.locator('#apps-capability').innerText(), /自有目标.*原启动窗口绑定到任务.*撤销应用许可后停止新动作/s);
    await page.getByRole('button', { name: '刷新配置', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#apps-status')?.textContent?.includes('配置已读取'));
    assert.equal(await page.locator('#apps-candidate option').count(), 1);
    await page.locator('#apps-environment').selectOption(''); assert.equal(await page.locator('#apps-capability').innerText(), '');
    await page.reload(); await page.waitForFunction(() => (document.querySelector('#apps-environment') as HTMLSelectElement)?.options.length === 4);
    assert.equal(await page.locator('#apps-environment').inputValue(), '');
    assert.ok(requests.every(item => ['open', 'close'].includes(item.action)));
    assert.equal(f.opens(), 0); assert.equal(f.identityReads(), 0); assert.deepEqual(f.calls, []); assert.deepEqual(errors, []);
    mkdirSync(resolve('.validation'), { recursive: true });
    await page.screenshot({ path: resolve('.validation/p8-b-preview.png'), fullPage: true });
    await page.route('**/api/dashboard/preflight', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), localWorkspaceConfigured: true } });
    });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#bridge-test-preview')?.textContent?.includes('已加载配置，实际应用与原目标实例尚未验证'));
    assert.doesNotMatch(await preview.innerText(), /当前未配置，不可用/);
    assert.equal(await page.locator('#apps-environment').inputValue(), '');
    assert.ok(requests.every(item => ['open', 'close'].includes(item.action)));
    assert.equal(f.opens(), 0); assert.equal(f.identityReads(), 0); assert.deepEqual(f.calls, []);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await browser.close(); await f.close(); }
});
