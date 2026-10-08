import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { taskAppFixture } from './fixtures/task-app-onboarding.js';
import { createDashboardServer } from '../src/app/server.js';
import { recoverDesktopTasks } from '../src/desktop-session/recovery.js';

test('Browser covers real waiting card/confirm API, explicit single/multi selection, cancellation and no repeated Task submission', { timeout: 60000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const f = await taskAppFixture(), server = createDashboardServer(f.dir, f.controller);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('missing address');
  const { chromium } = await import('playwright'); const browser = await chromium.launch();
  try {
    const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const submissions: string[] = [], confirms: unknown[] = [];
    page.on('request', request => {
      if (request.url().endsWith('/api/tasks') && request.method() === 'POST') submissions.push(request.url());
      if (request.url().endsWith('/app-onboarding')) confirms.push(request.postDataJSON());
    });
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction(() => (document.querySelector('#task-destination') as HTMLSelectElement)?.options.length === 2);
    await page.locator('#task-destination').selectOption(JSON.stringify([f.target.providerId, f.target.environmentId]));
    await page.locator('#task-goal').fill('使用 AA音乐 搜索合成歌曲'); await page.locator('#task-submit').click();
    const card = page.locator('#app-onboarding'); await card.waitFor({ state: 'visible' });
    await page.waitForFunction(() => (document.querySelector('#app-onboarding-candidate') as HTMLSelectElement)?.options.length === 2);
    assert.match(await card.innerText(), /selected-environment/); assert.match(await card.innerText(), /synthetic-installation/);
    assert.equal(await page.locator('#resume-controls').isVisible(), false);
    const confirm = card.getByRole('button', { name: '确认并验证启动', exact: true });
    assert.equal(await confirm.isDisabled(), true); assert.equal(f.counters.leases, 0); assert.equal(f.counters.models, 0);
    assert.equal(await page.locator('#app-onboarding-candidate').inputValue(), '');
    await page.locator('#app-onboarding-candidate').selectOption({ index: 1 });
    assert.match(await card.locator('.app-onboarding-identity').innerText(), /C:\\Synthetic\\Music.exe/);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 1280, height: 800 });
    const response = page.waitForResponse(response => response.url().endsWith('/app-onboarding') && response.request().postDataJSON().action === 'confirm');
    await confirm.click(); assert.equal((await response).status(), 200);
    await page.locator('#resume-controls').waitFor({ state: 'visible' });
    assert.equal(await card.isVisible(), false); assert.equal(submissions.length, 1); assert.equal(f.counters.starts, 1);
    assert.equal(confirms.length, 1);
    // A second task reuses the confirmed profile without showing the card.
    const id = f.submit(); await f.wait(id, state => state.appOnboarding?.state === 'ready' && !!state.observation);
    assert.equal(f.counters.scans, 1); assert.equal(f.counters.starts, 1);
    f.setEntries(f.entries().flatMap(item => [
      { ...item, displayName: 'BB音乐', aliases: [] },
      { ...item, displayName: 'BB音乐', aliases: [], launchSpec: { kind: 'exe' as const, executable: 'D:\\Synthetic\\Music.exe', args: [] } },
    ]));
    const multi = f.controller.submit('使用 BB音乐 搜索合成歌曲', { desktopTarget: f.target });
    await f.wait(multi, state => state.appOnboarding?.candidates.length === 2);
    await page.evaluate(id => document.dispatchEvent(new CustomEvent('workbench:open-run', { detail: `web-tasks.sqlite/${id}` })), multi);
    await page.waitForFunction(() => (document.querySelector('#app-onboarding-candidate') as HTMLSelectElement)?.options.length === 3);
    assert.equal(await page.locator('#app-onboarding-candidate').inputValue(), ''); assert.equal(await confirm.isDisabled(), true);
    await page.locator('#app-onboarding-candidate').selectOption({ index: 2 });
    await card.getByRole('button', { name: '不是这个应用', exact: true }).click();
    await f.wait(multi, state => state.appOnboarding?.state === 'rejected'); assert.equal(f.counters.starts, 1);
    // A new unknown name has no candidates; the same card provides recovery and terminal cancellation.
    const unknown = f.controller.submit('使用 ZZ音乐 搜索合成歌曲', { desktopTarget: f.target });
    await f.wait(unknown, state => state.appOnboarding?.state === 'not_found');
    await page.evaluate(id => document.dispatchEvent(new CustomEvent('workbench:open-run', { detail: `web-tasks.sqlite/${id}` })), unknown);
    await card.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#app-onboarding')?.textContent?.includes('未找到'));
    for (const label of ['指定路径', '重新扫描', '安装后重扫', '取消任务']) assert.equal(await card.getByRole('button', { name: label, exact: true }).count(), 1);
    await card.getByRole('button', { name: '取消任务', exact: true }).click();
    await f.wait(unknown, state => state.status === 'stopped');
    recoverDesktopTasks(f.dir);
    await page.evaluate(task => document.dispatchEvent(new CustomEvent('workbench:open-run', { detail: `web-tasks.sqlite/${task}` })), id);
    await page.waitForFunction(() => document.querySelector('#app-onboarding')?.textContent?.includes('请新建任务'));
    assert.equal(await page.locator('#task-continue').isVisible(), false);
    assert.equal(await page.getByRole('button', { name: '以此任务新建草稿', exact: true }).isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise<void>(done => server.close(() => done())); await f.close(); }
});
