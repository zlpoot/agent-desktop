import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { PlaywrightRuntime } from '../src/runtime/browser/playwright-runtime.js';
import { ingestRebindObservation, captureRebindBaseline, evaluateRebindTask } from '../src/verification/structured-rebind.js';
import type { CompletionCriteria } from '../src/verifier/verifier.js';
import type { Observation } from '../src/actions/schema.js';

function fixtureHtml(enabled: boolean, theme: string): string {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"></head><body>
<h1>设置</h1>
<form id="settings-form">
  <label><input type="checkbox" id="enable-reminders" aria-label="启用提醒" ${enabled ? 'checked' : ''}>启用提醒</label>
  <label for="theme-select">主题</label>
  <select id="theme-select" aria-label="主题">
    <option value="light">light</option><option value="dark">dark</option><option value="system">system</option>
  </select>
  <button type="submit" aria-label="保存设置">保存设置</button>
</form>
</body></html>`;
}

test('browser set_checked sets target state without blind toggle', async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    const query = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams;
    response.end(fixtureHtml(query.get('enabled') === 'true', query.get('theme') ?? 'light'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('server unavailable');
  const dir = mkdtempSync(join(tmpdir(), 'b4b-form-'));
  const runtime = await PlaywrightRuntime.launch({ headless: true, artifactDir: join(dir, 'shots') });
  try {
    const base = `http://127.0.0.1:${address.port}/`;
    // 初态 false → set_checked(true)：执行一次设置，结果 true。
    await runtime.execute({ kind: 'navigate', url: base + '?enabled=false' });
    await runtime.execute({ kind: 'set_checked', target: { kind: 'role', role: 'checkbox', name: '启用提醒' }, checked: true });
    let observation = await runtime.observe();
    assert.equal(observation.structured?.items.find((item) => item.role === 'checkbox')?.checked, true);
    // 初态已 true → set_checked(true)：不得产生多余 toggle（仍为 true）。
    await runtime.execute({ kind: 'set_checked', target: { kind: 'role', role: 'checkbox', name: '启用提醒' }, checked: true });
    observation = await runtime.observe();
    assert.equal(observation.structured?.items.find((item) => item.role === 'checkbox')?.checked, true);
    // true → false：真实取消勾选。
    await runtime.execute({ kind: 'set_checked', target: { kind: 'role', role: 'checkbox', name: '启用提醒' }, checked: false });
    observation = await runtime.observe();
    assert.equal(observation.structured?.items.find((item) => item.role === 'checkbox')?.checked, false);
  } finally {
    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const target = resolvePath(dir);
    if (dirname(target) !== resolvePath(tmpdir()) || !basename(target).startsWith('b4b-form-'))
      throw new Error('Refusing to remove an unexpected test directory');
    rmSync(target, { recursive: true, force: true });
  }
});

test('browser select_option changes actual option and collector exposes combobox options', async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(fixtureHtml(false, 'light'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('server unavailable');
  const dir = mkdtempSync(join(tmpdir(), 'b4b-form-'));
  const runtime = await PlaywrightRuntime.launch({ headless: true, artifactDir: join(dir, 'shots') });
  try {
    await runtime.execute({ kind: 'navigate', url: `http://127.0.0.1:${address.port}/` });
    let observation = await runtime.observe();
    const combobox = observation.structured?.items.find((item) => item.role === 'combobox');
    assert.ok(combobox, 'combobox 应出现在结构化枚举');
    assert.deepEqual(combobox.options, ['light', 'dark', 'system']);
    assert.equal(combobox.value, 'light');
    await runtime.execute({ kind: 'select_option', target: { kind: 'role', role: 'combobox', name: '主题' }, option: 'dark' });
    observation = await runtime.observe();
    assert.equal(observation.structured?.items.find((item) => item.role === 'combobox')?.value, 'dark');
    await runtime.execute({ kind: 'select_option', target: { kind: 'role', role: 'combobox', name: '主题' }, option: 'system' });
    observation = await runtime.observe();
    assert.equal(observation.structured?.items.find((item) => item.role === 'combobox')?.value, 'system');
  } finally {
    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const target = resolvePath(dir);
    if (dirname(target) !== resolvePath(tmpdir()) || !basename(target).startsWith('b4b-form-'))
      throw new Error('Refusing to remove an unexpected test directory');
    rmSync(target, { recursive: true, force: true });
  }
});

test('browser element identity is stable in-page and changes across navigation', async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(fixtureHtml(false, 'light'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('server unavailable');
  const dir = mkdtempSync(join(tmpdir(), 'b4b-form-'));
  const runtime = await PlaywrightRuntime.launch({ headless: true, artifactDir: join(dir, 'shots') });
  try {
    const url = `http://127.0.0.1:${address.port}/`;
    await runtime.execute({ kind: 'navigate', url });
    const first = await runtime.observe();
    const second = await runtime.observe();
    const firstIdentity = first.structured?.items.find((item) => item.role === 'checkbox')?.identity;
    const secondIdentity = second.structured?.items.find((item) => item.role === 'checkbox')?.identity;
    assert.ok(firstIdentity);
    assert.equal(secondIdentity, firstIdentity, '同页内 identity 必须稳定');
    // 重载（导航）后：identity 必须变化——DOM 树已重建，不能把「同 selector」当同身份。
    await runtime.execute({ kind: 'navigate', url });
    const third = await runtime.observe();
    const thirdIdentity = third.structured?.items.find((item) => item.role === 'checkbox')?.identity;
    assert.ok(thirdIdentity);
    assert.notEqual(thirdIdentity, firstIdentity, '跨导航 identity 必须变化');
  } finally {
    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const target = resolvePath(dir);
    if (dirname(target) !== resolvePath(tmpdir()) || !basename(target).startsWith('b4b-form-'))
      throw new Error('Refusing to remove an unexpected test directory');
    rmSync(target, { recursive: true, force: true });
  }
});

type Structured = NonNullable<Observation['structured']>;

function domObservation(items: Structured['items'], sequence: number): Observation {
  return { capture: { epoch: 'e', sequence, object: `page:e`, startedAt: 0, finishedAt: 0,
    clock: 'collector', atomic: false,
    fields: { dom: { complete: true, source: 'dom' }, structured: { complete: true, source: 'dom' } } },
    structured: { source: 'dom', complete: true, items } };
}

const rebindCriteria: CompletionCriteria = {
  structuredStates: [
    { target: { role: 'checkbox', name: '启用提醒' }, field: 'checked', equals: true, persistedAfter: 'rebind' },
  ],
};
const checkbox = (checked: boolean, identity: string): Structured['items'][number] =>
  ({ role: 'checkbox', name: '启用提醒', text: '启用提醒', checked, identity, complete: true });

test('dom rebind chain: baseline → edit → commit → absent → new identity → terminal equals expected → PASS', () => {
  const condition = rebindCriteria.structuredStates![0];
  let state = captureRebindBaseline(undefined, domObservation([checkbox(false, 'r0')], 1), condition);
  assert.ok(state.baseline);
  assert.equal(state.baseline!.value, false);
  // 编辑：同一身份 r0 值变为 true。
  state = ingestRebindObservation(state, domObservation([checkbox(true, 'r0')], 2), condition, false);
  assert.equal(state.editedSequence, 2);
  // 提交：编辑后的首个 dispatched 动作。
  state = ingestRebindObservation(state, domObservation([checkbox(true, 'r0')], 3), condition, true);
  assert.equal(state.committedSequence, 3);
  // 缺席：完整枚举无目标控件。
  state = ingestRebindObservation(state, domObservation([], 4), condition, false);
  assert.equal(state.absentSequence, 4);
  // 重投影：新身份 r1 + 值 true。
  state = ingestRebindObservation(state, domObservation([checkbox(true, 'r1')], 5), condition, false);
  assert.ok(state.rebound);
  assert.equal(state.rebound!.runtimeId, 'r1');
  const report = evaluateRebindTask(rebindCriteria, { 0: state }, domObservation([checkbox(true, 'r1')], 6), 'dom');
  assert.equal(report.verdict, 'pass');
  assert.equal(report.contradiction, false);
});

test('dom rebind chain: stale old value on new identity → FAIL without any banner', () => {
  const condition = rebindCriteria.structuredStates![0];
  let state = captureRebindBaseline(undefined, domObservation([checkbox(false, 'r0')], 1), condition);
  state = ingestRebindObservation(state, domObservation([checkbox(true, 'r0')], 2), condition, false);
  state = ingestRebindObservation(state, domObservation([checkbox(true, 'r0')], 3), condition, true);
  state = ingestRebindObservation(state, domObservation([], 4), condition, false);
  state = ingestRebindObservation(state, domObservation([checkbox(false, 'r1')], 5), condition, false);
  const report = evaluateRebindTask(rebindCriteria, { 0: state }, domObservation([checkbox(false, 'r1')], 6), 'dom');
  assert.equal(report.verdict, 'fail');
  assert.equal(report.contradiction, true);
});

test('dom rebind chain: missing leave boundary stays UNKNOWN (partial durable replay)', () => {
  const condition = rebindCriteria.structuredStates![0];
  let state = captureRebindBaseline(undefined, domObservation([checkbox(false, 'r0')], 1), condition);
  state = ingestRebindObservation(state, domObservation([checkbox(true, 'r0')], 2), condition, false);
  state = ingestRebindObservation(state, domObservation([checkbox(true, 'r0')], 3), condition, true);
  // 故意没有 reopen/absence：即使值已为 true，durable 证明必须 UNKNOWN。
  const report = evaluateRebindTask(rebindCriteria, { 0: state }, domObservation([checkbox(true, 'r0')], 4), 'dom');
  assert.equal(report.verdict, 'unknown');
});

test('dom rebind chain: same identity without navigation is not a rebound identity', () => {
  const condition = rebindCriteria.structuredStates![0];
  let state = captureRebindBaseline(undefined, domObservation([checkbox(false, 'r0')], 1), condition);
  state = ingestRebindObservation(state, domObservation([checkbox(true, 'r0')], 2), condition, false);
  state = ingestRebindObservation(state, domObservation([checkbox(true, 'r0')], 3), condition, true);
  state = ingestRebindObservation(state, domObservation([], 4), condition, false);
  // 控件重新出现但身份仍是 r0（没有 reload/重建）→ 不是新身份，不得 PASS。
  state = ingestRebindObservation(state, domObservation([checkbox(true, 'r0')], 5), condition, false);
  assert.equal(state.rebound, undefined);
  const report = evaluateRebindTask(rebindCriteria, { 0: state }, domObservation([checkbox(true, 'r0')], 6), 'dom');
  assert.equal(report.verdict, 'unknown');
});
