import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from 'cordis';
import { resolve } from 'node:path';
import { ExtensionRegistry } from '../src/contracts/extension.js';
import { mountInspected, inspectAssembly } from '../src/composition/inspection.js';
import { createDashboardServer } from '../src/app/server.js';

test('Cordis 只读面板显示真实 Fiber 状态及独立业务扩展，不输出服务配置', async () => {
  const root = new Context(); const extensions = new ExtensionRegistry();
  extensions.register({ id: 'example', name: '示例扩展', profiles: [{ id: 'profile-1', matches: () => false }] });
  const fiber = mountInspected(root, { name: 'sample', apply(ctx) { ctx.provide('secretService', { token: 'MUST_NOT_APPEAR' }); } }, 'Root', ['secretService']);
  await fiber;
  const snapshot = () => inspectAssembly(root, extensions);
  assert.equal(snapshot().plugins[0].state, 'active');
  assert.equal(JSON.stringify(snapshot()).includes('MUST_NOT_APPEAR'), false);
  const server = createDashboardServer(process.cwd(), undefined, undefined, undefined, undefined, snapshot);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const base = `http://127.0.0.1:${address.port}`;
  let browser: import('playwright').Browser | undefined;
  try {
    const response = await (await fetch(`${base}/api/runtime/plugins`)).json();
    assert.equal(response.extensions[0].profiles[0], 'profile-1');
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
    const { chromium } = await import('playwright'); browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(base);
    assert.equal(await page.locator('.workspace-nav').getByRole('button', { name: '插件与扩展', exact: true }).count(), 0);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.route('**/api/runtime/plugins', route => route.fulfill({ status: 503, json: { error: '测试暂不可用' } }), { times: 1 });
    await page.getByRole('button', { name: '插件与扩展', exact: true }).click();
    await page.getByRole('button', { name: '重试读取插件', exact: true }).waitFor();
    assert.match(await page.locator('.runtime-status').innerText(), /测试暂不可用/);
    await page.getByRole('button', { name: '重试读取插件', exact: true }).click();
    await page.getByRole('heading', { name: 'sample', exact: true }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: 'sample', exact: true }).waitFor();
    assert.equal(await page.locator('.workspace-nav').getByRole('button', { name: '设置', exact: true }).getAttribute('aria-current'), 'page');
    assert.match(await page.locator('.runtime-panel').innerText(), /已装载/);
    assert.equal(await page.locator('#run-list').isVisible(), false);
    await fiber.dispose();
    assert.equal(snapshot().plugins[0].state, 'disposed');
    await page.getByRole('button', { name: '刷新插件状态' }).click();
    await page.getByText('已卸载 · disposed', { exact: true }).waitFor();
    assert.match(await page.locator('.runtime-panel').innerText(), /示例扩展/);
  } finally {
    await browser?.close(); await new Promise<void>(done => server.close(() => done())); await root.fiber.dispose();
  }
});
