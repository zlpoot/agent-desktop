import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { oracleDir, privateOracleDir, parseOracleRequest, runOracle, startOracleBridge,
  type OracleRequest } from '../testbench/oracle-bridge.js';

const vmId = randomUUID();
const config = { vmName: 'AgentDesktop', vmId };
const request = (check: OracleRequest['check']): OracleRequest =>
  ({ version: 1, requestId: randomUUID(), taskId: randomUUID(), requestedAt: new Date().toISOString(), check });

test('Oracle request only permits registered read-only checks and desktop basenames', () => {
  const file = request({ kind: 'desktop-file', fileName: 'result.txt', expectedText: 'hello' });
  assert.deepEqual(parseOracleRequest(file), file);
  assert.equal(parseOracleRequest({ ...file, check: { ...file.check, fileName: '..\\secret.txt' } }), undefined);
  assert.equal(parseOracleRequest({ ...file, check: { ...file.check, fileName: 'folder/result.txt' } }), undefined);
  assert.equal(parseOracleRequest({ ...file, check: { kind: 'execute', command: 'whoami' } }), undefined);
  assert.equal(parseOracleRequest({ ...file, taskId: 'not-a-uuid' }), undefined);
  assert.equal(parseOracleRequest({ ...file, check: request({ kind: 'testbench-phone', expected: '13912345678' }) }),
    undefined); // A nested request is never a valid check.
  const phone = request({ kind: 'testbench-phone', expected: '13912345678' });
  assert.deepEqual(parseOracleRequest(phone), phone);
  assert.equal(parseOracleRequest({ ...phone, check: { kind: 'testbench-phone', expected: '1; whoami' } }), undefined);
});

test('Todo Oracle reports current independent state, ambiguity and unavailability', async () => {
  const row = request({ kind: 'todo', title: '验收任务', completed: true });
  const mock = (items: unknown): typeof fetch => (async () =>
    new Response(JSON.stringify(items), { status: 200 })) as typeof fetch;
  assert.equal((await runOracle('', config, row, mock([{ title: '验收任务', completed: true }]))).status, 'pass');
  assert.equal((await runOracle('', config, row, mock([{ title: '验收任务', completed: false }]))).status, 'fail');
  const ambiguous = await runOracle('', config, row, mock([
    { title: '验收任务', completed: true }, { title: '验收任务', completed: false },
  ]));
  assert.equal(ambiguous.status, 'unavailable');
  assert.equal(ambiguous.reason, 'target_ambiguous');
  assert.equal((await runOracle('', config, row, (async () => { throw Error('offline'); }) as typeof fetch)).status,
    'unavailable');
});

test('Dashboard bridge consumes a request once and writes a separate result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-oracle-'));
  const base = oracleDir(root);
  const privateBase = privateOracleDir(root);
  const inbox = join(base, 'requests');
  const outbox = join(base, 'results');
  let calls = 0;
  try {
    await mkdir(inbox, { recursive: true });
    await mkdir(privateBase, { recursive: true });
    await writeFile(join(privateBase, 'bridge.json'), `\uFEFF${JSON.stringify(config)}`);
    const bridge = startOracleBridge(root, vmId, async (_root, _config, item) => {
      calls++;
      return { version: 1, requestId: item.requestId, taskId: item.taskId,
        requestedAt: item.requestedAt, check: item.check,
        capturedAt: new Date().toISOString(), status: 'pass' };
    });
    assert.ok(bridge);
    try {
      const item = request({ kind: 'testbench-phone', expected: '13912345678' });
      const filename = `${item.requestId}.json`;
      await writeFile(join(inbox, filename), JSON.stringify(item));
      for (let i = 0; i < 100 && !existsSync(join(outbox, filename)); i++)
        await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(JSON.parse(await readFile(join(outbox, filename), 'utf8')).status, 'pass');
      assert.equal(existsSync(join(inbox, filename)), false);
      assert.equal(calls, 1);
      await writeFile(join(inbox, filename), JSON.stringify(item));
      // 第二次写入同一 requestId：bridge 见 outbox 已存在，应直接消费 inbox 且不再调 execute。
      // 用轮询代替固定等待，避免全量并行负载下偶发超时。
      for (let i = 0; i < 100 && existsSync(join(inbox, filename)); i++)
        await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(calls, 1);
      assert.equal(existsSync(join(inbox, filename)), false);
      const rejectedId = randomUUID();
      await writeFile(join(inbox, `${rejectedId}.json`), JSON.stringify({
        version: 1, requestId: rejectedId, taskId: randomUUID(),
        check: { kind: 'execute', command: 'whoami' },
      }));
      for (let i = 0; i < 100 && !existsSync(join(outbox, `${rejectedId}.json`)); i++)
        await new Promise(resolve => setTimeout(resolve, 100));
      const rejected = JSON.parse(await readFile(join(outbox, `${rejectedId}.json`), 'utf8'));
      assert.equal(rejected.status, 'unavailable');
      assert.equal(rejected.reason, 'invalid_request');
      assert.equal(calls, 1);
      const expired = { ...item, requestId: randomUUID(), requestedAt: '2020-01-01T00:00:00.000Z' };
      await writeFile(join(inbox, `${expired.requestId}.json`), JSON.stringify(expired));
      for (let i = 0; i < 100 && !existsSync(join(outbox, `${expired.requestId}.json`)); i++)
        await new Promise(resolve => setTimeout(resolve, 100));
      const expiredResult = JSON.parse(await readFile(join(outbox, `${expired.requestId}.json`), 'utf8'));
      assert.equal(expiredResult.status, 'unavailable');
      assert.equal(expiredResult.reason, 'request_expired');
      assert.equal(calls, 1);
    } finally { await bridge.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Oracle bridge refuses a configured VM identity different from the live VM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-oracle-id-'));
  try {
    const base = privateOracleDir(root);
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'bridge.json'), JSON.stringify(config));
    const original = console.error;
    console.error = () => {};
    try { assert.equal(startOracleBridge(root, randomUUID()), undefined); }
    finally { console.error = original; }
    assert.equal(existsSync(join(base, 'bridge-status.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('request CLI receives the privileged bridge report without a Guest command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-oracle-cli-'));
  const base = oracleDir(root);
  const privateBase = privateOracleDir(root);
  try {
    await mkdir(privateBase, { recursive: true });
    await writeFile(join(privateBase, 'bridge.json'), JSON.stringify(config));
    const bridge = startOracleBridge(root, vmId, async (_root, _config, item) => ({
      version: 1, requestId: item.requestId, taskId: item.taskId, requestedAt: item.requestedAt,
      check: item.check, capturedAt: new Date().toISOString(), status: 'pass',
    }));
    assert.ok(bridge);
    try {
      const statusPath = join(base, 'bridge-status.json');
      for (let i = 0; i < 100 && !existsSync(statusPath); i++)
        await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(existsSync(statusPath), true);
      const taskId = randomUUID();
      const script = fileURLToPath(new URL('../scripts/request-oracle.mjs', import.meta.url));
      const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [script, '--task', taskId, '--kind', 'testbench-phone',
          '--expected', '13912345678'], { env: { ...process.env, AGENT_DESKTOP_ORACLE_BASE: base } });
        let stdout = ''; let stderr = '';
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', (part: string) => { stdout += part; });
        child.stderr.on('data', (part: string) => { stderr += part; });
        child.on('error', reject);
        child.on('close', code => resolve({ code, stdout, stderr }));
      });
      assert.equal(output.code, 0, output.stderr);
      const report = JSON.parse(output.stdout) as { taskId: string; status: string };
      assert.equal(report.taskId, taskId);
      assert.equal(report.status, 'pass');
    } finally { await bridge.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
