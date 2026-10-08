import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { preflightFixture } from './fixtures/dashboard-preflight.js';

test('A1 Browser no-selection, missing collector, environment switching, late response and reload remain read-only', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const f = await preflightFixture(); const { chromium } = await import('playwright'); const browser = await chromium.launch();
  let release: (() => void) | undefined;
  try {
    const page = await browser.newPage(); const requests: { action: string }[] = [], errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().endsWith('/api/desktop/apps')) requests.push(request.postDataJSON()); });
    await page.goto(`${f.base}/#/apps`);
    await page.waitForFunction(() => (document.querySelector('#apps-environment') as HTMLSelectElement)?.options.length === 4);
    assert.equal(await page.locator('#apps-environment').inputValue(), ''); assert.equal(requests.length, 0);
    assert.match(await page.locator('#preflight-config').innerText(), /Synthetic Host.*已显式加载/);
    assert.match(await page.locator('#preflight-workspace').innerText(), /Local Workspace 不可用/);
    const scan = page.getByRole('button', { name: '扫描 / 重扫', exact: true }); assert.equal(await scan.isDisabled(), true);
    const manual = page.getByRole('button', { name: '指定路径', exact: true });
    assert.equal(await manual.isDisabled(), true);
    assert.equal(await page.locator('#apps-path').isVisible(), false);
    const style = () => scan.evaluate(button => {
      const css = getComputedStyle(button);
      return { background: css.backgroundColor, opacity: css.opacity, cursor: css.cursor };
    });
    const disabledStyle = await style();
    assert.equal(disabledStyle.cursor, 'not-allowed'); assert.ok(Number(disabledStyle.opacity) < 1);
    await scan.hover(); assert.deepEqual(await style(), disabledStyle);
    await scan.click({ force: true }); await manual.click({ force: true });
    assert.equal(requests.length, 0, 'disabled controls must not issue scan/path requests');
    mkdirSync(resolve('.validation'), { recursive: true });
    await page.screenshot({ path: resolve('.validation/p8-a-disabled-controls.png'), fullPage: true });
    const key = (index: number) => JSON.stringify([f.scopes[index].providerId, f.scopes[index].environmentId]);
    await page.locator('#apps-environment').selectOption(key(0));
    await page.waitForFunction(() => document.querySelector('#apps-status')?.textContent?.includes('配置已读取'));
    assert.match(await page.locator('#apps-capability').innerText(), /physical.*synthetic-host.*unknown.*unavailable.*不表示未安装.*not-proven.*forbidden.*unsupported/s);
    assert.equal(await scan.isDisabled(), true);
    const refreshStyle = await page.getByRole('button', { name: '刷新配置', exact: true }).evaluate(button => {
      const css = getComputedStyle(button); return { background: css.backgroundColor, opacity: css.opacity, cursor: css.cursor };
    });
    assert.notEqual(disabledStyle.background, refreshStyle.background);
    assert.ok(Number(disabledStyle.opacity) < Number(refreshStyle.opacity));
    assert.equal(refreshStyle.cursor, 'pointer');
    assert.equal(await page.locator('#apps-path').isVisible(), false);
    let entered!: () => void; const waiting = new Promise<void>(done => { entered = done; });
    f.hooks.beforeCapabilities = async id => { if (id === 'physical') { entered(); await new Promise<void>(done => { release = done; }); } };
    await page.getByRole('button', { name: '刷新配置', exact: true }).click(); await waiting;
    await page.locator('#apps-environment').selectOption(key(1));
    await page.waitForFunction(() => document.querySelector('#apps-capability')?.textContent?.includes('synthetic-workspace'));
    const late = page.waitForResponse(response => response.url().endsWith('/api/desktop/apps') &&
      response.request().postDataJSON().action === 'open' && response.request().postDataJSON().desktopTarget.providerId === 'physical');
    release!(); release = undefined; await late;
    assert.match(await page.locator('#apps-capability').innerText(), /local-workspace.*synthetic-workspace/s);
    assert.equal(await page.locator('#apps-candidate option').count(), 1);
    await page.locator('#apps-environment').selectOption(''); assert.equal(await page.locator('#apps-capability').innerText(), '');
    await page.reload(); await page.waitForFunction(() => (document.querySelector('#apps-environment') as HTMLSelectElement)?.options.length === 4);
    assert.equal(await page.locator('#apps-environment').inputValue(), '');
    assert.ok(requests.every(item => ['open', 'close'].includes(item.action))); assert.equal(f.opens(), 0);
    assert.equal(await page.locator('#task-goal').count(), 0); assert.equal(await page.locator('#desktop-frame').count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally { release?.(); await browser.close(); await f.close(); }
});
