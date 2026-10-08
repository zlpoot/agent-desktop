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
    assert.match(await page.locator('#preflight-workspace').innerText(), /本地隔离工作区不可用/);
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
    assert.match(await page.locator('#apps-capability').innerText(), /环境提供方：本机交互桌面.*状态未知.*暂不可用.*不表示未安装.*业务操作：尚未验证/s);
    assert.doesNotMatch(await page.locator('#apps-capability').innerText(), /unknown|not-proven|unavailable|Provider|Registry|\bTask\b|\bVM\b/);
    assert.match(await page.locator('#apps-capability-details').innerText(), /系统全局键鼠输入.*禁止使用.*原始键鼠输入隔离.*尚未验证.*独立操作系统隔离.*不支持/s);
    assert.match(await page.locator('#apps-capability-diagnostics').textContent() ?? '', /physical.*synthetic-host/s);
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
    await page.waitForFunction(() => document.querySelector('#apps-capability-diagnostics')?.textContent?.includes('synthetic-workspace'));
    const late = page.waitForResponse(response => response.url().endsWith('/api/desktop/apps') &&
      response.request().postDataJSON().action === 'open' && response.request().postDataJSON().desktopTarget.providerId === 'physical');
    release!(); release = undefined; await late;
    assert.match(await page.locator('#apps-capability').innerText(), /环境提供方：本地隔离工作区/);
    assert.match(await page.locator('#apps-capability-diagnostics').textContent() ?? '', /local-workspace.*synthetic-workspace/s);
    assert.equal(await page.locator('#apps-candidate option').count(), 1);
    await page.locator('#apps-environment').selectOption(''); assert.equal(await page.locator('#apps-capability').innerText(), '');
    assert.equal(await page.locator('#apps-capability-details').isVisible(), false);
    await page.reload(); await page.waitForFunction(() => (document.querySelector('#apps-environment') as HTMLSelectElement)?.options.length === 4);
    assert.equal(await page.locator('#apps-environment').inputValue(), '');
    assert.ok(requests.every(item => ['open', 'close'].includes(item.action))); assert.equal(f.opens(), 0);
    assert.equal(await page.locator('#task-goal').count(), 0); assert.equal(await page.locator('#desktop-frame').count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally { release?.(); await browser.close(); await f.close(); }
});

test('A2 Browser scans only on click; Chinese coverage, absent/ambiguous candidates and stale responses remain private and scoped', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const f = await preflightFixture({ mode: 'a2' }); const { chromium } = await import('playwright'); const browser = await chromium.launch();
  let release: (() => void) | undefined;
  try {
    const page = await browser.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const key = (i: number) => JSON.stringify([f.scopes[i].providerId, f.scopes[i].environmentId]);
    await page.goto(`${f.base}/#/apps`);
    await page.waitForFunction(() => (document.querySelector('#apps-environment') as HTMLSelectElement)?.options.length === 4);
    const scan = page.getByRole('button', { name: '扫描 / 重扫', exact: true });
    assert.equal(await scan.isDisabled(), true); assert.deepEqual(f.calls, []);
    assert.match(await page.locator('#preflight-config').innerText(), /A2 只读应用发现/);
    await page.locator('#apps-environment').selectOption(key(0));
    await page.waitForFunction(() => document.querySelector('#apps-status')?.textContent?.includes('配置已读取'));
    assert.equal(await scan.isDisabled(), false); assert.equal(await page.locator('#apps-path').isVisible(), true);
    assert.deepEqual(f.calls, []);
    f.hooks.collect = async scope => ({ scope, entries: ['1.0', '2.0'].map(version => ({
      displayName: '<img src=x onerror=alert(1)> 合成音乐', aliases: ['Synthetic Music'], version,
      launchSpec: { kind: 'exe', executable: `C:\\Synthetic${version}\\Music.exe`, args: [] },
      source: 'app-paths-hkcu', contentFingerprint: `synthetic-${version}`,
    })), coverage: [
      { source: 'app-paths-hkcu', status: 'complete', inspected: 2, rejected: 0 },
      { source: 'start-menu-user', status: 'truncated', inspected: 5, rejected: 1, reason: 'scan-entry-limit' },
    ] });
    await scan.click(); await page.waitForFunction(() => document.querySelector('#apps-status')?.textContent?.includes('读取不完整'));
    assert.equal(f.calls.length, 1); assert.equal(await page.locator('#apps-candidate').inputValue(), '');
    assert.match(await page.locator('#apps-scan-report').innerText(), /读取不完整.*当前用户应用路径登记.*检查 2 条.*当前用户开始菜单.*达到读取限制.*同名多版本/s);
    assert.equal(await page.locator('#app-management img').count(), 0);
    await page.locator('#apps-search').fill('Synthetic Music'); assert.equal(await page.locator('#apps-candidate option').count(), 3);
    const id = await page.locator('#apps-candidate option').nth(1).getAttribute('value');
    await page.locator('#apps-candidate').selectOption(id!);
    assert.match(await page.locator('#apps-identity').innerText(), /安装实例.*C:\\Synthetic1\.0.*尚未确认、注册或启动/s);
    assert.equal(await page.getByRole('button', { name: '查看确认内容', exact: true }).isDisabled(), true);
    await page.locator('#apps-search').fill('Absent Synthetic App');
    assert.equal(await page.locator('#apps-candidate option').count(), 1); assert.equal(await page.locator('#apps-identity').innerText(), '');
    assert.match(await page.locator('#apps-scan-report').innerText(), /不能证明没有安装/); assert.equal(f.calls.length, 1);
    f.hooks.collect = async scope => ({ scope, entries: [], coverage: [{ source: 'app-paths-hkcu', status: 'complete', inspected: 0, rejected: 0 }] });
    await scan.click(); await page.waitForFunction(() => document.querySelector('#apps-status')?.textContent?.includes('已完整读取限定来源'));
    assert.match(await page.locator('#apps-scan-report').innerText(), /仅在已扫描的限定来源中没有匹配结果.*可指定路径/s);
    assert.equal(f.calls.length, 2);
    for (const action of ['switch', 'refresh']) {
      let entered!: () => void; const waiting = new Promise<void>(done => { entered = done; });
      f.hooks.collect = async scope => {
        entered(); await new Promise<void>(done => { release = done; });
        return { scope, entries: [], coverage: [{ source: 'app-paths-hkcu', status: 'complete', inspected: 0, rejected: 0 }] };
      };
      await scan.click(); await waiting;
      const late = page.waitForResponse(response => response.url().endsWith('/api/desktop/apps') && response.request().postDataJSON().action === 'scan');
      if (action === 'switch') await page.locator('#apps-environment').selectOption(key(1));
      else await page.getByRole('button', { name: '刷新配置', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#apps-status')?.textContent?.includes('配置已读取'));
      assert.equal(await page.locator('#apps-scan-report').isVisible(), false);
      release!(); release = undefined; await late;
      assert.equal(await page.locator('#apps-scan-report').isVisible(), false);
      assert.match(await page.locator('#apps-capability').innerText(), /本地隔离工作区.*只读.*不继承本机启动/s);
    }
    const beforeGuest = f.calls.length;
    await page.locator('#apps-environment').selectOption(key(2));
    await page.waitForFunction(() => document.querySelector('#apps-status')?.textContent?.includes('配置已读取'));
    assert.equal(await scan.isDisabled(), true); assert.match(await page.locator('#apps-capability').innerText(), /不会扫描本机作为虚拟机结果/);
    assert.equal(f.calls.length, beforeGuest);
    await page.locator('#apps-environment').selectOption(key(0));
    await page.waitForFunction(() => document.querySelector('#apps-status')?.textContent?.includes('配置已读取'));
    f.hooks.collect = async () => { throw new Error('host-app-installation-identity-mismatch'); };
    await scan.click(); await page.waitForFunction(() => document.querySelector('#apps-status')?.textContent?.includes('读取不可用'));
    assert.match(await page.locator('#apps-scan-report').innerText(), /身份无法核对.*已拒绝結果|身份无法核对.*已拒绝结果/s);
    assert.equal(await page.locator('#apps-candidate option').count(), 1);
    await page.screenshot({ path: resolve('.validation/p8-a2-unavailable.png'), fullPage: true });
    await page.reload(); await page.waitForFunction(() => (document.querySelector('#apps-environment') as HTMLSelectElement)?.options.length === 4);
    assert.equal(await page.locator('#apps-environment').inputValue(), ''); assert.equal(await scan.isDisabled(), true);
    assert.equal(f.opens(), 0); assert.deepEqual(errors, []);
  } finally { release?.(); await browser.close(); await f.close(); }
});

test('A1 explains all capability states in Chinese and preserves distinct version scopes and inert technical identifiers', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const f = await preflightFixture(); const { chromium } = await import('playwright'); const browser = await chromium.launch();
  try {
    const scope = { providerId: ['local-workspace'], environmentKind: ['local-workspace' as const],
      application: ['netease-cloud-music'], applicationVersion: ['3.1.21'], targetRole: ['search-editor'],
      action: ['viewer-edit'], mechanism: ['uia-valuepattern'] };
    f.hooks.capabilities = {
      'observation.pixels': [{ state: 'supported', scope: {} }],
      'observation.accessibility': [{ state: 'not-proven', scope: {} }],
      'isolation.separateDesktop': [{ state: 'supported', scope: {} }],
      'isolation.separateOs': [{ state: 'unsupported', scope: {} }],
      'isolation.sharedUserSession': [{ state: 'supported', scope: {} }],
      'input.rawIsolated': [{ state: 'not-proven', scope: {} }],
      'input.semantic': [{ state: 'supported', scope }, { state: 'not-proven', scope: { ...scope, applicationVersion: ['3.1.22'] } }],
      'input.targetedWindow': [{ state: 'not-proven', scope: { application: ['<img src=x onerror=alert(1)>'] } }],
      'input.globalInput': [{ state: 'forbidden', scope: {} }],
      'control.humanTakeover': [{ state: 'supported', scope: {} }],
      'control.resumable': [{ state: 'supported', scope: {} }],
      'control.leaseProtected': [{ state: 'supported', scope: {} }],
    };
    const page = await browser.newPage(); await page.goto(`${f.base}/#/apps`);
    await page.waitForFunction(() => (document.querySelector('#apps-environment') as HTMLSelectElement)?.options.length === 4);
    await page.locator('#apps-environment').selectOption(JSON.stringify(['local-workspace', 'synthetic-workspace']));
    await page.waitForFunction(() => document.querySelector('#apps-status')?.textContent?.includes('配置已读取'));
    const table = page.locator('#apps-capability-details table');
    assert.equal(await table.locator('tbody tr').count(), 13);
    const visible = await page.locator('#apps-capability-details').innerText();
    assert.match(visible, /已声明支持.*尚未验证.*不支持.*禁止使用/s);
    assert.match(visible, /不是当前机器、应用已经就绪的证明/);
    assert.doesNotMatch(visible, /observation\.|input\.|control\.|isolation\.|supported|not-proven|forbidden|unavailable/);
    const semantic = table.locator('tbody tr').filter({ hasText: '按控件含义操作' });
    assert.equal(await semantic.count(), 2);
    assert.match(await semantic.nth(0).innerText(), /已声明支持.*网易云音乐.*3\.1\.21.*搜索输入框.*操作者编辑文本.*辅助功能文本设置接口/s);
    assert.match(await semantic.nth(1).innerText(), /尚未验证.*3\.1\.22/s);
    assert.equal(await page.locator('#apps-capability-details img').count(), 0);
    await page.getByText('技术标识（仅排查问题时使用）', { exact: true }).click();
    assert.match(await page.locator('#apps-capability-diagnostics').innerText(), /input\.semantic.*3\.1\.21.*3\.1\.22.*<img src=x onerror=alert\(1\)>/s);
    await page.getByText('技术标识（仅排查问题时使用）', { exact: true }).click();
    mkdirSync(resolve('.validation'), { recursive: true });
    await page.screenshot({ path: resolve('.validation/p8-a-capabilities-zh.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const scan = page.getByRole('button', { name: '扫描 / 重扫', exact: true }); assert.equal(await scan.isDisabled(), true);
    assert.equal(f.opens(), 0);
  } finally { await browser.close(); await f.close(); }
});
