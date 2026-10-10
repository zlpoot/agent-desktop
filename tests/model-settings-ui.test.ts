import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { managementFixture } from './fixtures/app-management.js';
import { readModelSettings, modelSettingsPath } from '../src/agent/model-settings.js';
import { promptDefinitions } from '../src/agent/prompt-store.js';

test('model settings save/keep/replace/clear/reload privately without Task, Runtime, model calls or browser caching', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const f = await managementFixture(), { chromium } = await import('playwright'), browser = await chromium.launch({ headless: true });
  const secret = 'synthetic-ui-key-never-real', requests: string[] = [], responses: string[] = [], errors: string[] = [];
  try {
    mkdirSync(resolve(f.dir, 'prompts'), { recursive: true });
    for (const prompt of promptDefinitions) writeFileSync(resolve(f.dir, 'prompts', prompt.file), `synthetic prompt ${prompt.id}`);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() !== 'GET') requests.push(new URL(request.url()).pathname); });
    page.on('response', response => { if (response.url().endsWith('/api/settings/model')) void response.text().then(text => responses.push(text)); });
    await page.goto(`${f.base}/#/settings`); await page.locator('#model-settings-message').getByText(/已读取生效来源/).waitFor();
    await page.waitForFunction(() => (document.querySelector('#prompt-content') as HTMLTextAreaElement)?.value === 'synthetic prompt task-planner');
    assert.match(await page.locator('#model-effective').innerText(), /不完整.*未就绪/);
    await page.locator('#model-endpoint').fill('https://synthetic.invalid/v1'); await page.locator('#model-name').fill('synthetic-ui-model');
    await page.locator('#model-key-action').selectOption('replace'); await page.locator('#model-api-key').fill(secret);
    await page.getByRole('button', { name: '保存模型配置', exact: true }).click();
    await page.locator('#model-settings-message').getByText(/已保存本机配置/).waitFor();
    assert.equal(await page.locator('#model-api-key').inputValue(), '');
    assert.match(await page.locator('#model-effective').innerText(), /Key 已配置.*本机私有配置.*完整.*尚未验证/s);
    assert.equal(JSON.parse(readFileSync(modelSettingsPath(f.dir), 'utf8')).apiKey, secret);
    assert.equal(await page.locator('#prompt-content').inputValue(), 'synthetic prompt task-planner');
    await page.locator('#model-name').fill('changed-name'); await page.getByRole('button', { name: '保存模型配置', exact: true }).click();
    await page.locator('#model-settings-message').getByText(/已保存本机配置/).waitFor();
    assert.equal(JSON.parse(readFileSync(modelSettingsPath(f.dir), 'utf8')).apiKey, secret);
    await page.reload(); await page.locator('#model-settings-message').getByText(/已读取生效来源/).waitFor();
    assert.equal(await page.locator('#model-name').inputValue(), 'changed-name'); assert.equal(await page.locator('#model-api-key').inputValue(), '');
    await f.restart(); await page.goto(`${f.base}/#/settings`); await page.locator('#model-settings-message').getByText(/已读取生效来源/).waitFor();
    assert.equal(await page.locator('#model-name').inputValue(), 'changed-name');
    await page.locator('#model-key-action').selectOption('replace'); await page.locator('#model-api-key').fill('synthetic-replacement');
    await page.getByRole('button', { name: '保存模型配置', exact: true }).click(); await page.locator('#model-settings-message').getByText(/已保存本机配置/).waitFor();
    assert.equal(JSON.parse(readFileSync(modelSettingsPath(f.dir), 'utf8')).apiKey, 'synthetic-replacement');
    await page.locator('#model-key-action').selectOption('clear'); await page.getByRole('button', { name: '保存模型配置', exact: true }).click();
    await page.locator('#model-settings-message').getByText(/已保存本机配置/).waitFor();
    assert.equal(readModelSettings(f.dir).effective.keyConfigured, false);
    assert.match(await page.locator('#model-effective').innerText(), /已显式清除.*不完整/s);
    await page.locator('#model-key-action').selectOption('replace'); await page.locator('#model-api-key').fill(secret);
    await page.getByRole('button', { name: '插件与扩展', exact: true }).click();
    assert.equal(await page.locator('.model-settings').isVisible(), false);
    assert.equal(await page.locator('#model-api-key').inputValue(), '');
    await page.getByRole('button', { name: '预算与提示词', exact: true }).click();
    await page.locator('#model-key-action').selectOption('keep');
    assert.ok(!await page.evaluate(() => JSON.stringify({ url: location.href, local: { ...localStorage }, session: { ...sessionStorage }, html: document.body.innerHTML })).then(value => value.includes(secret)));
    assert.ok(responses.every(text => !text.includes(secret) && !text.includes('synthetic-replacement')));
    mkdirSync(resolve('.artifacts/issue-58'), { recursive: true });
    for (const width of [390, 601, 668, 700, 900, 1366, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const button = page.getByRole('button', { name: '保存模型配置', exact: true }); await button.scrollIntoViewIfNeeded();
      assert.equal(await button.evaluate(element => { const box = element.getBoundingClientRect(); return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') === element; }), true);
      if ([390, 1440].includes(width)) await page.screenshot({ path: resolve(`.artifacts/issue-58/settings-${width}.png`), fullPage: true });
    }
    assert.ok(requests.every(path => path === '/api/settings/model'));
    assert.deepEqual(f.counts(), { models: 0, runtime: 0, leases: 0 }); assert.deepEqual(errors, []);
  } finally { await browser.close(); await f.close(); }
});

test('read/save failure, delayed duplicate click and lost response fail closed, erase password and require reread', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const f = await managementFixture(), { chromium } = await import('playwright'), browser = await chromium.launch({ headless: true });
  let release: (() => void) | undefined;
  try {
    const page = await browser.newPage();
    await page.route('**/api/settings/model', route => route.fulfill({ status: 503, json: { error: 'synthetic-read-failure' } }));
    await page.goto(`${f.base}/#/settings`); await page.locator('#model-settings-message').getByText(/读取失败/).waitFor();
    const save = page.getByRole('button', { name: '保存模型配置', exact: true }); assert.equal(await save.isDisabled(), true);
    await page.unroute('**/api/settings/model'); await page.getByRole('button', { name: '重新读取模型配置', exact: true }).click();
    await page.locator('#model-settings-message').getByText(/已读取生效来源/).waitFor();
    await page.locator('#model-endpoint').fill('https://synthetic.invalid/v1'); await page.locator('#model-name').fill('synthetic-model');
    await page.locator('#model-key-action').selectOption('replace'); await page.locator('#model-api-key').fill('synthetic-not-returned');
    let entered!: () => void, puts = 0;
    const received = new Promise<void>(done => { entered = done; }), waiting = new Promise<void>(done => { release = done; });
    await page.route('**/api/settings/model', async route => {
      if (route.request().method() !== 'PUT') return route.continue();
      puts++; await route.fetch(); entered(); await waiting;
      await route.fulfill({ status: 503, json: { error: 'synthetic-not-returned' } });
    });
    await save.click(); await received; assert.equal(await page.locator('#model-api-key').inputValue(), '');
    await save.dispatchEvent('click'); assert.equal(puts, 1); assert.equal(await save.isDisabled(), true);
    release!(); release = undefined; await page.locator('#model-settings-message').getByText(/保存未确认/).waitFor();
    assert.equal(await save.isDisabled(), true); assert.ok(!(await page.locator('#model-settings-message').innerText()).includes('synthetic-not-returned'));
    await page.unroute('**/api/settings/model'); await page.getByRole('button', { name: '重新读取模型配置', exact: true }).click();
    await page.locator('#model-settings-message').getByText(/已读取生效来源/).waitFor(); assert.match(await page.locator('#model-effective').innerText(), /Key 已配置/);
    await page.locator('#model-endpoint').fill('ftp://invalid.example'); await save.click();
    await page.locator('#model-settings-message').getByText(/保存未确认/).waitFor(); assert.equal(await save.isDisabled(), true);
    writeFileSync(modelSettingsPath(f.dir), '{broken-private-file');
    await page.getByRole('button', { name: '重新读取模型配置', exact: true }).click(); await page.locator('#model-settings-message').getByText(/读取失败/).waitFor();
    assert.match(await page.locator('#model-effective').innerText(), /UNKNOWN/);
    assert.deepEqual(f.counts(), { models: 0, runtime: 0, leases: 0 });
  } finally { release?.(); await browser.close(); await f.close(); }
});

test('environment overrides are explained after saving or clearing private Key; env-local fallback is not silently restored', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const names = ['COMPUTER_USE_BASE_URL', 'COMPUTER_USE_MODEL', 'COMPUTER_USE_API_KEY'], before = names.map(name => process.env[name]);
  process.env.COMPUTER_USE_BASE_URL = 'https://environment.invalid/v1'; process.env.COMPUTER_USE_MODEL = 'environment-model'; process.env.COMPUTER_USE_API_KEY = 'synthetic-env-key';
  const f = await managementFixture(), { chromium } = await import('playwright'), browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); await page.goto(`${f.base}/#/settings`); await page.locator('#model-settings-message').getByText(/已读取生效来源/).waitFor();
    await page.locator('#model-endpoint').fill('https://local.invalid/v1'); await page.locator('#model-name').fill('local-model');
    await page.locator('#model-key-action').selectOption('clear'); await page.getByRole('button', { name: '保存模型配置', exact: true }).click();
    await page.locator('#model-settings-message').getByText(/已保存本机配置/).waitFor();
    assert.match(await page.locator('#model-effective').innerText(), /environment-model.*Key 已配置.*环境变量.*已显式清除.*正在覆盖/s);
    assert.equal(await page.locator('#model-name').inputValue(), 'local-model'); assert.equal(await page.locator('#model-api-key').inputValue(), '');
    names.forEach(name => { delete process.env[name]; }); writeFileSync(resolve(f.dir, '.env.local'), 'COMPUTER_USE_API_KEY=synthetic-legacy-key');
    await page.reload(); await page.locator('#model-settings-message').getByText(/已读取生效来源/).waitFor();
    assert.match(await page.locator('#model-effective').innerText(), /local-model.*Key 未配置.*已显式清除.*不完整/s);
  } finally { await browser.close(); await f.close(); names.forEach((name, i) => { if (before[i] === undefined) delete process.env[name]; else process.env[name] = before[i]; }); }
});
