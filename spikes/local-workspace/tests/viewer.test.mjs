import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('D0-A Fake Viewer: effective frame, fixed script, stale run, private typing and stop', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-d0-viewer-'));
  const host = spawn('python', ['spikes/local-workspace/host.py', '--fake', '--artifacts', directory],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  const errors = [];
  try {
    const url = await new Promise((resolveUrl, reject) => {
      const timer = setTimeout(() => reject(Error('host_start_timeout')), 5000);
      host.once('error', reject);
      host.once('exit', () => reject(Error('host_exited_before_ready')));
      host.stdout.on('data', data => {
        const match = data.toString().match(/http:\/\/127\.0\.0\.1:\d+\/#[\w-]+/);
        if (match) { clearTimeout(timer); resolveUrl(match[0]); }
      });
    });
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const bodies = [];
    page.on('request', request => { if (request.method() === 'POST') bodies.push(request.postData()); });
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#mode').textContent.includes('FAKE'));
    assert.equal(new URL(page.url()).hash, '');
    await page.locator('#run').click();
    await page.waitForFunction(() => !document.querySelector('#act').disabled);
    await page.waitForFunction(() => document.querySelector('#frame').naturalWidth === 320);
    assert.equal(await page.locator('#frame').isVisible(), true);
    await page.locator('#parallel').fill('synthetic text stays in this page');
    await page.locator('#act').click();
    await page.waitForFunction(() => JSON.parse(document.querySelector('#status').textContent).input === 'SIMULATED');
    assert.equal(await page.locator('#act').isDisabled(), true);
    assert.ok(bodies.every(body => !body.includes('synthetic text stays')));
    assert.equal(JSON.parse(await page.locator('#status').textContent()).human_parallel_input, 'NOT_RUN');
    await page.locator('#stop').click();
    await page.waitForFunction(() => !document.querySelector('#run').disabled);
    assert.equal(await page.locator('#frame').isVisible(), false);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (host.exitCode === null && host.signalCode === null) {
      const exited = new Promise(resolveExit => host.once('exit', resolveExit));
      host.kill();
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
