// Only a local fake JEV server and a fresh browser context. No desktop or model calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';

async function start() {
  const child = spawn('python', ['labs/hidden-desktop/jev_server.py', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('Fake server did not start')); }, 10000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/JEV_LAB_URL=(http:\/\/127\.0\.0\.1:\d+\/jev)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); reject(Error(`Fake server exited ${code}`)); });
  });
  return { child, url };
}

test('JEV page: cases, failures, budget, mobile layout; fake server only', { timeout: 60000 }, async () => {
  const { child, url } = await start();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin
      ? route.continue() : route.abort());
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#mode').textContent.includes('FAKE'));
    assert.equal(await page.locator('#case option').count(), 5);
    assert.equal(await page.locator('#fault option').count(), 8);
    assert.equal(await page.locator('.record').count(), 0); // No automatic model request.
    const click = async id => {
      await page.locator('#' + id).click();
      await page.waitForFunction(() => !document.querySelector('#run').disabled);
    };
    await click('models');
    assert.match(await page.locator('.record').first().innerText(), /模型 jev 可用/);
    for (const id of ['choose-search', 'semantic-pass', 'semantic-pending', 'semantic-fail', 'semantic-missing']) {
      await page.selectOption('#case', id);
      assert.match(await page.locator('#request').innerText(), /"model": "jev"/);
      await click('run');
      assert.match(await page.locator('.record').first().innerText(), /符合预期/);
    }
    for (const fault of ['low-confidence', 'invalid-choice', 'invalid-confidence', 'wrong-type', 'missing-answer', 'timeout', 'http-error']) {
      await page.selectOption('#fault', fault);
      await click('run');
      assert.match(await page.locator('.record').first().innerText(), /请求失败 \/ 协议拒绝/);
    }
    assert.match(await page.locator('#config').innerText(), /已用 13\/20/);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.selectOption('#fault', 'none');
    for (let n = 13; n < 19; n++) await click('run');
    await page.locator('#run').click();
    await page.waitForFunction(() => document.querySelector('#config').textContent.includes('20/20'));
    assert.equal(await page.locator('#run').isDisabled(), true);
    assert.equal(await page.locator('#models').isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
});
