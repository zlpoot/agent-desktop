// Explicit Windows-only integration. Browser input uses Playwright's page
// protocol; hidden application input remains the worker's guarded HWND messages.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

if (!process.argv.includes('--real') || process.platform !== 'win32') {
  throw Error('Explicit --real on Windows required');
}
const takeover = process.argv.includes('--takeover');
const directory = resolve(takeover ? '.artifacts/local-workspace-takeover-real' : '.artifacts/local-workspace-viewer-real');
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
  const getState = async () => JSON.parse(await page.locator('#status').textContent());
  const post = async (path, body) => fetch(origin + path, { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const readyOwner = async owner => page.waitForFunction(owner => {
    const s = JSON.parse(document.querySelector('#status').textContent);
    return s.owner === owner && s.control_ready;
  }, owner);
  if (takeover) {
    await page.waitForFunction(() => JSON.parse(document.querySelector('#status').textContent).agent_progress >= 2);
    const agentEpoch = (await getState()).epoch;
    await page.locator('#takeover').click(); await readyOwner('human');
    const paused = await getState();
    assert.ok(paused.agent_progress > 0 && paused.agent_progress < paused.agent_total);
    await page.waitForTimeout(350);
    assert.equal((await getState()).agent_progress, paused.agent_progress);
    assert.equal((await post('/act', { run_id: runId, epoch: agentEpoch })).status, 409);
    // Half-size display proves CSS pixels are converted back to native pixels.
    await page.locator('#frame').evaluate(frame => { frame.style.width = '280px'; });
    const clickFrame = async (x, y) => {
      const before = (await getState()).human_actions;
      const box = await page.locator('#frame').boundingBox();
      await page.locator('#frame').click({ position: { x: 1 + x * (box.width - 2) / 560, y: 1 + y * (box.height - 2) / 310 } });
      await page.waitForFunction(n => JSON.parse(document.querySelector('#status').textContent).human_actions > n, before);
    };
    await clickFrame(420, 80); // EDIT near its end, not title bar or border.
    const beforeTyping = await getState();
    await page.locator('#frame').pressSequentially('HUMAN', { delay: 50 });
    await page.locator('#frame').press('Backspace');
    await page.waitForFunction(n => JSON.parse(document.querySelector('#status').textContent).human_actions >= n + 6, beforeTyping.human_actions);
    assert.equal((await getState()).text_length, paused.text_length + 4);
    const humanPosts = [];
    page.on('request', request => { if (request.url().endsWith('/human')) humanPosts.push(request.postData()); });
    await page.locator('#frame').press('Control+V');
    await page.locator('#parallel').fill('default-page-synthetic');
    await page.waitForTimeout(250);
    assert.equal(humanPosts.length, 0);
    await clickFrame(180, 130); // BUTTON, same half-size mapping.
    assert.equal((await getState()).clicks, 1);
    const humanEpoch = (await getState()).epoch;
    await page.locator('#resume').click(); await readyOwner('agent');
    assert.equal((await post('/human', { run_id: runId, epoch: humanEpoch, event: { kind: 'char', value: 'X' } })).status, 409);
    report.takeover = { outcome: 'PASS', paused_progress: paused.agent_progress,
      scale: 0.5, keyboard: 'ASCII_AND_BACKSPACE_PASS', unsupported_modifier: 'NO_FORWARD',
      parallel_text: 'NO_FORWARD', old_agent_epoch: 'REJECTED', old_human_epoch: 'REJECTED' };
  }
  await page.waitForFunction(() => JSON.parse(document.querySelector('#status').textContent).input === 'PASS');
  if (takeover) {
    const completed = await getState();
    assert.equal(completed.agent_progress, completed.agent_total);
    assert.equal(completed.text_length, completed.agent_total + 4);
    assert.equal(completed.clicks, 2);
    report.takeover.resume = 'CONTINUED_WITHOUT_REPLAY_PASS';
    // A second handoff is independent; closing the Viewer in human mode must stop.
    await page.locator('#takeover').click(); await readyOwner('human');
    report.takeover.repeated_handoff = 'PASS';
  }
  const sequence = JSON.parse(await page.locator('#status').textContent()).frame.sequence;
  await page.waitForFunction(n => JSON.parse(document.querySelector('#status').textContent).frame.sequence >= n + 5, sequence);
  await page.screenshot({ path: resolve(directory, 'viewer.png'), fullPage: true });
  report.before_stop = JSON.parse(await page.locator('#status').textContent());
  report.viewer_render = 'PASS';
  if (takeover) {
    await page.close();
    await new Promise(resolve => setTimeout(resolve, 4200));
    const response = await fetch(origin + '/status', { headers: { Authorization: `Bearer ${token}` } });
    report.result = await response.json();
    assert.equal(report.result.stop_reason, 'viewer_disconnected_or_lease_expired');
    report.takeover.disconnect_in_human_mode = 'STOPPED_PASS';
  } else {
    await page.locator('#stop').click();
    await page.waitForFunction(() => JSON.parse(document.querySelector('#status').textContent).status === 'stopped');
    report.result = JSON.parse(await page.locator('#status').textContent());
  }
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
