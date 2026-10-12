import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { managementFixture } from './fixtures/app-management.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRootAssembly } from '../src/composition/root.js';
import { createDashboardServer } from '../src/app/server.js';
import { WorkbenchApps } from '../src/desktop-provider/workbench-apps.js';
import { config, scope, FakeWorkbenchClient } from './fixtures/workbench-apps.js';
import { Script } from 'node:vm';

const target = (providerId: string, environmentId: string) => JSON.stringify([providerId, environmentId]);

test('legacy seed only discovers on an explicit click in the main workbench', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const dir = mkdtempSync(join(tmpdir(), 'workbench-startup-ui-')), client = new FakeWorkbenchClient();
  let models = 0;
  const root = await createRootAssembly({ rootDir: dir,
    workbenchApps: new WorkbenchApps(config, scope.installationScopeId, client, true),
    model: { createModel() { models++; throw Error('no-model'); } } });
  const server = createDashboardServer(dir, root.controller);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { chromium } = await import('playwright'), browser = await chromium.launch();
  try {
    const asset = await fetch(`${base}/workbench-app-launcher.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type')!, /^text\/javascript/);
    assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
    new Script(await asset.text());
    const page = await browser.newPage();
    page.on('request', request => {
      if (request.method() === 'POST') assert.equal(new URL(request.url()).pathname, '/api/desktop/apps');
    });
    await page.goto(base);
    const environment = page.locator('#task-destination'), app = page.locator('#task-application');
    await page.waitForFunction(() => Array.from((document.querySelector('#task-destination') as HTMLSelectElement).options)
      .some(option => option.value.includes('workbench-apps')));
    await environment.selectOption(target(scope.providerId, scope.environmentId));
    await page.getByRole('button', { name: '发现应用', exact: true }).click();
    await app.getByRole('option', { name: /网易云音乐/ }).waitFor({ state: 'attached' });
    assert.equal(await app.isDisabled(), false); assert.equal(client.starts, 0);
    assert.equal(await page.locator('#task-submit').isDisabled(), true);
    await app.selectOption({ index: 1 });
    const panel = page.getByRole('region', { name: '打开环境中的应用' });
    await panel.getByRole('button', { name: '打开应用', exact: true }).click();
    await panel.getByRole('button', { name: '确认并打开', exact: true }).click();
    await page.locator('#task-app-status').getByText('应用已打开', { exact: false }).waitFor();
    assert.equal(client.starts, 1); assert.equal(models, 0);
    await environment.selectOption('browser');
    assert.equal(await app.isDisabled(), true);
  } finally {
    await browser.close(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    await root.dispose(); rmSync(dir, { recursive: true, force: true });
  }
});

test('workbench selects environment/App and opens through the scoped operator port without Task/model/input', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const f = await managementFixture(true, true), { chromium } = await import('playwright'), browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors: string[] = [], requests: Record<string, any>[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.method() !== 'POST') return;
      assert.equal(new URL(request.url()).pathname, '/api/desktop/apps', 'opening an App cannot submit a Task');
      requests.push(request.postDataJSON());
    });
    await page.goto(f.base);
    const environment = page.locator('#task-destination'), app = page.locator('#task-application'), status = page.locator('#task-app-status');
    const panel = page.getByRole('region', { name: '打开环境中的应用' }), open = panel.getByRole('button', { name: '打开应用', exact: true });
    await page.waitForFunction(() => (document.querySelector('#task-destination') as HTMLSelectElement)?.options.length === 6);
    assert.equal(await environment.inputValue(), ''); assert.equal(await app.isDisabled(), true); assert.equal(requests.length, 0);
    await environment.selectOption(target('hyper-v', 'vm:a'));
    await status.getByText('尚无已确认应用', { exact: false }).waitFor();
    assert.equal(f.backends[0].scans, 0); assert.equal(f.backends[0].starts, 0);
    await panel.getByRole('button', { name: '发现应用', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('#task-application') as HTMLSelectElement).options.length === 2);
    assert.equal(await app.inputValue(), ''); assert.equal(await open.isDisabled(), true);
    await app.selectOption({ index: 1 }); assert.equal(f.backends[0].starts, 0);
    assert.match(await page.locator('#task-app-identity').innerText(), /vm:a.*Music.exe/s);
    await open.click();
    const confirm = panel.getByRole('button', { name: '确认并打开', exact: true }); await confirm.waitFor();
    assert.match(await page.locator('#task-app-confirmation').innerText(), /Synthetic Publisher.*vm:a.*Music.exe/s);
    assert.equal(f.backends[0].starts, 0, 'prepare only inspects, never launches');
    await confirm.click(); await status.getByText('应用已打开', { exact: false }).waitFor();
    assert.equal(f.backends[0].starts, 1); assert.match(await app.inputValue(), /^app:/);
    const registeredChoice = await app.inputValue();
    await app.selectOption(''); assert.doesNotMatch(await status.innerText(), /应用已打开/);
    await app.selectOption(registeredChoice); assert.doesNotMatch(await status.innerText(), /应用已打开/);
    await open.click(); await status.getByText('应用已打开', { exact: false }).waitFor();
    assert.equal(f.backends[0].starts, 1, 'reuses the verified original instance instead of launching another');
    assert.equal(requests.filter(item => item.action === 'confirm').length, 1);
    assert.equal(requests.filter(item => item.action === 'verify').length, 1);

    await environment.selectOption(target('hyper-v', 'vm:b'));
    await status.getByText('尚无已确认应用', { exact: false }).waitFor();
    assert.equal(await app.inputValue(), ''); assert.equal(await open.isDisabled(), true);
    assert.equal(await page.locator('#task-app-identity').innerText(), ''); assert.equal(f.backends[1].starts, 0);
    await panel.getByRole('button', { name: '发现应用', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('#task-application') as HTMLSelectElement).options.length === 2);
    await app.selectOption({ index: 1 }); await open.click(); await confirm.click();
    await status.getByText('应用已打开', { exact: false }).waitFor();
    assert.equal(f.backends[1].starts, 1);
    assert.equal(requests.filter(item => item.action === 'confirm' && item.desktopTarget.environmentId === 'vm:b').length, 1);

    // Launch support does not imply generic Task support. A configured Hidden Desktop may open an App independently.
    await environment.selectOption(target('local-workspace', 'hidden'));
    await status.getByText('尚无已确认应用', { exact: false }).waitFor();
    assert.equal(await page.locator('#task-submit').isDisabled(), true);
    await panel.getByRole('button', { name: '发现应用', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('#task-application') as HTMLSelectElement).options.length === 2);
    await app.selectOption({ index: 1 }); await open.click(); await confirm.click();
    await status.getByText('应用已打开', { exact: false }).waitFor(); assert.equal(f.backends[3].starts, 1);
    assert.equal(await page.locator('#task-submit').isDisabled(), true);
    mkdirSync(resolve('.validation/workbench-app-launch'), { recursive: true });
    await page.screenshot({ path: resolve('.validation/workbench-app-launch/desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve('.validation/workbench-app-launch/mobile.png'), fullPage: true });
    await page.reload(); await status.getByText('选择应用后点击', { exact: false }).waitFor();
    assert.equal(await app.inputValue(), ''); assert.equal(await open.isDisabled(), true); assert.equal(f.backends[3].starts, 1);
    await environment.selectOption('browser');
    assert.equal(await app.isDisabled(), true); assert.equal(await open.isDisabled(), true);
    assert.deepEqual(f.counts(), { models: 0, runtime: 0, leases: 0 }); assert.deepEqual(errors, []);
  } finally { await browser.close(); await f.close(); }
});

test('workbench rejects missing launch support and stale/failed launch acknowledgements after environment changes', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const f = await managementFixture(), { chromium } = await import('playwright'), browser = await chromium.launch();
  let release: () => void = () => {};
  try {
    const page = await browser.newPage(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(f.base);
    const environment = page.locator('#task-destination'), app = page.locator('#task-application'), status = page.locator('#task-app-status');
    const panel = page.getByRole('region', { name: '打开环境中的应用' }), open = panel.getByRole('button', { name: '打开应用', exact: true });
    await page.waitForFunction(() => (document.querySelector('#task-destination') as HTMLSelectElement)?.options.length === 6);
    await environment.selectOption(target('physical', 'host'));
    await status.getByText('尚未配置受控启动', { exact: false }).waitFor();
    await panel.getByRole('button', { name: '发现应用', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('#task-application') as HTMLSelectElement).options.length === 2);
    await app.selectOption({ index: 1 }); assert.equal(await open.isDisabled(), true); assert.equal(f.backends[2].starts, 0);

    await environment.selectOption(target('hyper-v', 'vm:a')); await status.getByText('尚无已确认应用', { exact: false }).waitFor();
    await panel.getByRole('button', { name: '发现应用', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('#task-application') as HTMLSelectElement).options.length === 2);
    await app.selectOption({ index: 1 }); await open.click();
    const held = new Promise<void>(done => { release = done; }); f.backends[0].beforeObserve = () => held;
    const confirm = panel.getByRole('button', { name: '确认并打开', exact: true }); await confirm.click();
    await page.waitForFunction(() => document.querySelector('#task-app-status')?.textContent === '正在打开应用…');
    assert.equal(await confirm.isDisabled(), true); assert.equal(await open.isDisabled(), true);
    await assertEventually(() => f.backends[0].starts === 1);
    await environment.selectOption(target('hyper-v', 'vm:b'));
    await status.getByText('尚无已确认应用', { exact: false }).waitFor();
    release();
    await assertEventually(() => f.backends[0].cleanups === 1);
    assert.equal(f.backends[0].running, false); assert.equal(f.backends[1].starts, 0);
    assert.equal(await app.inputValue(), ''); assert.doesNotMatch(await status.innerText(), /应用已打开/);

    // A transport error is not a launch receipt. Never automatically retry the effect.
    await panel.getByRole('button', { name: '发现应用', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('#task-application') as HTMLSelectElement).options.length === 2);
    await app.selectOption({ index: 1 }); await open.click();
    let attempts = 0;
    await page.route('**/api/desktop/apps', route => {
      if (route.request().postDataJSON().action === 'confirm') { attempts++; return route.fulfill({ status: 409, json: { error: 'synthetic-acknowledgement-lost' } }); }
      return route.continue();
    });
    await confirm.click(); await status.getByText('结果未知或打开被拒绝', { exact: false }).waitFor();
    assert.equal(attempts, 1); assert.equal(f.backends[1].starts, 0); assert.doesNotMatch(await status.innerText(), /应用已打开/);
    await page.unroute('**/api/desktop/apps'); f.backends[1].unknown = true;
    await panel.getByRole('button', { name: '刷新 App 列表', exact: true }).click();
    await status.getByText('尚无已确认应用', { exact: false }).waitFor();
    await panel.getByRole('button', { name: '发现应用', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('#task-application') as HTMLSelectElement).options.length === 2);
    await app.selectOption({ index: 1 }); await open.click(); await confirm.click();
    await status.getByText('打开未完成', { exact: false }).waitFor();
    assert.equal(f.backends[1].starts, 1); assert.equal(f.backends[1].cleanups, 1); assert.doesNotMatch(await status.innerText(), /应用已打开/);
    assert.deepEqual(f.counts(), { models: 0, runtime: 0, leases: 0 }); assert.deepEqual(errors, []);
  } finally { release(); await browser.close(); await f.close(); }
});

test('late App directory responses cannot restore a previous environment or leave its operator session active', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const f = await managementFixture(), { chromium } = await import('playwright'), browser = await chromium.launch();
  let release: () => void = () => {};
  try {
    const page = await browser.newPage(), errors: string[] = [], requests: Record<string, any>[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().endsWith('/api/desktop/apps')) requests.push(request.postDataJSON()); });
    const held = new Promise<void>(done => { release = done; }); let returned = false;
    await page.route('**/api/desktop/apps', async route => {
      const body = route.request().postDataJSON();
      if (body.action === 'open' && body.desktopTarget.environmentId === 'vm:a') {
        const response = await route.fetch(); returned = true; await held; return route.fulfill({ response });
      }
      return route.continue();
    });
    await page.goto(f.base);
    const environment = page.locator('#task-destination'), status = page.locator('#task-app-status');
    await page.waitForFunction(() => (document.querySelector('#task-destination') as HTMLSelectElement)?.options.length === 6);
    await environment.selectOption(target('hyper-v', 'vm:a')); await assertEventually(() => returned);
    await environment.selectOption(target('hyper-v', 'vm:b')); await status.getByText('尚无已确认应用', { exact: false }).waitFor();
    release();
    await assertEventually(() => requests.some(item => item.action === 'close' && item.desktopTarget.environmentId === 'vm:a'));
    assert.equal(await environment.inputValue(), target('hyper-v', 'vm:b'));
    const panel = page.getByRole('region', { name: '打开环境中的应用' });
    await panel.getByRole('button', { name: '发现应用', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('#task-application') as HTMLSelectElement).options.length === 2);
    await page.locator('#task-application').selectOption({ index: 1 });
    assert.match(await page.locator('#task-app-identity').innerText(), /vm:b/);
    assert.equal(f.backends[0].scans, 0); assert.equal(f.backends[1].scans, 1);
    assert.ok(f.backends.every(item => item.starts === 0));
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await assertEventually(() => requests.some(item => item.action === 'close' && item.desktopTarget.environmentId === 'vm:b'));
    assert.deepEqual(f.counts(), { models: 0, runtime: 0, leases: 0 }); assert.deepEqual(errors, []);
  } finally { release(); await browser.close(); await f.close(); }
});

async function assertEventually(check: () => boolean) {
  const until = Date.now() + 3000;
  while (!check() && Date.now() < until) await new Promise(done => setTimeout(done, 20));
  assert.equal(check(), true);
}


test('normal workbench manually saves two named EXEs, persists on refresh, opens only on click and observes exit/unknown', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const dir = mkdtempSync(join(tmpdir(), 'workbench-manual-ui-')), client = new FakeWorkbenchClient();
  let models = 0;
  const root = await createRootAssembly({ rootDir: dir, workbenchApps: new WorkbenchApps(undefined, scope.installationScopeId, client, true),
    model: { createModel() { models++; throw Error('no-model'); } } });
  const server = createDashboardServer(dir, root.controller);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { chromium } = await import('playwright'), browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const requests: any[] = [], errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST') { assert.equal(new URL(request.url()).pathname, '/api/desktop/apps'); requests.push(request.postDataJSON()); } });
    await page.goto(base);
    const environment = page.locator('#task-destination'), app = page.locator('#task-application'), status = page.locator('#task-app-status');
    await page.waitForFunction(() => Array.from((document.querySelector('#task-destination') as HTMLSelectElement).options).some(option => option.value.includes('workbench-apps')));
    await environment.selectOption(target(scope.providerId, scope.environmentId));
    await status.getByText('尚无已确认应用', { exact: false }).waitFor();
    for (const [path, name] of [['C:\\Synthetic\\Editor.exe', '我的编辑器'], ['D:\\Synthetic\\Viewer.exe', '我的查看器']]) {
      await page.getByRole('button', { name: '添加 APP', exact: true }).click();
      await page.locator('#task-app-path').fill(path);
      assert.equal(await page.locator('#task-app-name').inputValue(), path.split('\\').at(-1)!.replace('.exe', ''));
      await page.locator('#task-app-name').fill(name);
      await page.getByRole('button', { name: '检查并保存', exact: true }).click();
      await status.getByText('配置已保存', { exact: false }).waitFor();
    }
    assert.equal(client.starts, 0); assert.ok(!requests.some(request => ['scan', 'prepare', 'confirm', 'verify'].includes(request.action)));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.reload();
    await app.getByRole('option', { name: /我的编辑器/ }).waitFor({ state: 'attached' });
    await app.getByRole('option', { name: /我的查看器/ }).waitFor({ state: 'attached' });
    assert.equal(client.starts, 0);
    await app.selectOption({ label: await app.getByRole('option', { name: /我的编辑器/ }).innerText() });
    await page.getByRole('button', { name: '打开应用', exact: true }).click();
    await status.getByText('窗口已确认', { exact: false }).waitFor();
    assert.match(await status.innerText(), /60 秒期限/); assert.equal(client.starts, 1);
    let lostReplies = 0;
    await page.route('**/api/desktop/apps', async route => {
      if (route.request().postDataJSON().action === 'verify') { lostReplies++; await route.fetch(); return route.abort('failed'); }
      return route.continue();
    });
    await page.getByRole('button', { name: '打开应用', exact: true }).click();
    await status.getByText('结果未知或打开被拒绝', { exact: false }).waitFor();
    assert.doesNotMatch(await status.innerText(), /应用已打开/); assert.equal(client.starts, 1); assert.equal(lostReplies, 1);
    await page.unroute('**/api/desktop/apps');
    await page.reload();
    await app.getByRole('option', { name: /我的编辑器/ }).waitFor({ state: 'attached' });
    await app.selectOption({ label: await app.getByRole('option', { name: /我的编辑器/ }).innerText() });
    await status.getByText('窗口已确认', { exact: false }).waitFor(); assert.equal(client.starts, 1);
    client.active = false; client.ended = true;
    await status.getByText('已退出', { exact: false }).waitFor(); assert.equal(client.starts, 1);
    client.unknown = true;
    await status.getByText('结果未知', { exact: false }).waitFor(); assert.equal(client.starts, 1);
    client.unknown = client.ended = false; client.conflict = true;
    await page.getByRole('button', { name: '打开应用', exact: true }).click();
    await status.getByText('workbench-existing-user-instance', { exact: false }).waitFor(); assert.equal(client.starts, 1);
    await page.getByRole('button', { name: '添加 APP', exact: true }).click();
    await page.locator('#task-app-path').fill('C:\\Synthetic\\Missing.exe');
    await page.getByRole('button', { name: '检查并保存', exact: true }).click();
    await status.getByText('app-installation-path-unavailable', { exact: false }).waitFor(); assert.equal(client.starts, 1);
    assert.equal(models, 0); assert.deepEqual(errors, []);
    mkdirSync(resolve('.validation/workbench-app-import'), { recursive: true });
    await page.screenshot({ path: resolve('.validation/workbench-app-import/mobile.png'), fullPage: true });
  } finally {
    await browser.close(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    await root.dispose(); rmSync(dir, { recursive: true, force: true });
  }
});
