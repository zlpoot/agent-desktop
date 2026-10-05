// Explicit Windows-only integration. Browser input uses Playwright's page
// protocol; hidden application input remains the worker's guarded HWND messages.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

if (!process.argv.includes('--real') || process.platform !== 'win32') {
  throw Error('Explicit --real on Windows required');
}
const directory = resolve('.artifacts/local-workspace-viewer-real');
mkdirSync(directory, { recursive: true });
const host = spawn('python', ['spikes/local-workspace/host.py', '--real', '--artifacts', directory],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, page, runId, token, origin;
const report = { human_parallel_input: 'NOT_RUN', app: 'fixture', viewer_render: 'NOT_RUN' };
try {
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(Error('host_start_timeout')), 8000);
    host.once('error', reject);
    host.once('exit', () => reject(Error('host_exited_before_ready')));
    host.stdout.on('data', data => {
      const match = data.toString().match(/http:\/\/127\.0\.0\.1:\d+\/#[\w-]+/);
      if (match) { clearTimeout(timer); resolveUrl(match[0]); }
    });
  });
  token = new URL(url).hash.slice(1); origin = new URL(url).origin;
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.playwright-browsers');
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  report.browser = browser.version();
  page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => JSON.parse(document.querySelector('#status').textContent).mode === 'real');
  await page.locator('#run').click();
  await page.waitForFunction(() => !document.querySelector('#act').disabled);
  runId = JSON.parse(await page.locator('#status').textContent()).run_id;
  await page.waitForFunction(() => document.querySelector('#frame').naturalWidth === 560);
  await page.locator('#act').click();
  await page.waitForFunction(() => JSON.parse(document.querySelector('#status').textContent).input === 'PASS');
  const sequence = JSON.parse(await page.locator('#status').textContent()).frame.sequence;
  await page.waitForFunction(n => JSON.parse(document.querySelector('#status').textContent).frame.sequence >= n + 5, sequence);
  await page.screenshot({ path: resolve(directory, 'viewer.png'), fullPage: true });
  report.before_stop = JSON.parse(await page.locator('#status').textContent());
  report.viewer_render = 'PASS';
  await page.locator('#stop').click();
  await page.waitForFunction(() => JSON.parse(document.querySelector('#status').textContent).status === 'stopped');
  report.result = JSON.parse(await page.locator('#status').textContent());
  assert.equal(report.result.cleanup.status, 'PASS');
  assert.equal(report.before_stop.text_verified, true);
  assert.equal(report.before_stop.click_verified, true);
  assert.deepEqual(errors, []);
  report.outcome = 'AUTOMATED_SUBSET_PASS';
} catch (error) {
  report.outcome = 'FAIL'; report.reason = error.message;
  process.exitCode = 1;
} finally {
  if (origin && runId) {
    try { await fetch(origin + '/stop', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ run_id: runId }) }); }
    catch { /* KILL_ON_JOB_CLOSE handles abrupt host exit. */ }
  }
  await browser?.close();
  if (host.exitCode === null && host.signalCode === null) {
    const exited = new Promise(resolveExit => host.once('exit', resolveExit));
    host.kill(); await exited;
  }
  writeFileSync(resolve(directory, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
