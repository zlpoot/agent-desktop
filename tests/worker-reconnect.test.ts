import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DesktopControl } from "../src/desktop-session/control.js";
import { DesktopSessionManager } from "../src/desktop-session/session-manager.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";
import { initialState } from "../src/graph/state.js";
import { connectionConfig } from "../src/desktop-session/connection-config.js";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "worker-reconnect-"));
  const remote = { id: "vm", epoch: "initial", offline: false, frame: true, compatible: true,
    observable: true, inputReady: true, reportReadiness: true, blockedReason: null as string | null,
    mode: "paused", resets: 0, posts: 0, states: 0, inputs: 0, hold: undefined as Promise<void> | undefined };
  const server = createServer(async (req, res) => {
    if (req.url === "/state") {
      remote.states++; await remote.hold;
      if (remote.offline) { res.writeHead(503).end('{}'); return; }
      res.end(JSON.stringify({ vm_id: remote.id, recovery_epoch: remote.epoch,
        action_rpc: true, control_rpc: true, recovery_rpc: remote.compatible,
        control_epoch_rpc: true, action_id_rpc: true,
        ...(remote.reportReadiness ? { ready_for_observation: remote.observable,
          ready_for_input: remote.inputReady, blocked_reason: remote.blockedReason } : {}) })); return;
    }
    if (req.url === "/frame") {
      if (!remote.frame) { res.writeHead(503).end(); return; }
      res.end(Buffer.from("89504e470d0a1a0a", "hex")); return;
    }
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); remote.posts++;
    if (req.url === "/human-input") { remote.inputs++; res.end(JSON.stringify({ result: {} })); return; }
    if (body.resetTask) { remote.epoch = 'epoch-' + ++remote.resets; }
    remote.mode = body.mode;
    res.end(JSON.stringify({ result: { mode: remote.mode, recovery_rpc: true, lease: body.mode === 'human' ? 'test-lease' : null } }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const sessions = new DesktopSessionManager(dir, 'test'); sessions.register('vm', url, 's');
  const control = new DesktopControl(dir, sessions, 's', 'test',
    { submit: () => '', pause() {}, continue() {}, resume() {} }, true,
    { pollMs: 1, timeoutMs: 500, retryMaxMs: 2 });
  return { dir, remote, sessions, control, url,
    retry: async () => { await new Promise(r => setTimeout(r, 5)); await control.reconnect(); },
    close: async () => { await control.close(); await sessions.close(); await new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }); rmSync(dir, { recursive: true, force: true }); } };
}

test('已就绪 Worker 断线/进程 epoch 变化后重连，只恢复就绪，不恢复人工租约', async () => {
  const f = await fixture();
  try {
    await f.control.reconnect(); assert.equal(f.remote.resets, 1);
    await f.control.command('old', 'take');
    f.remote.offline = true; await f.retry();
    assert.equal(f.control.view().workerReady, false);
    assert.equal(f.control.view().mode, 'PAUSED');
    await assert.rejects(f.control.input('old', { kind: 'text', text: 'never' }));
    assert.equal(f.remote.inputs, 0);
    f.remote.offline = false; f.remote.epoch = 'restarted'; await f.retry();
    assert.equal(f.control.view().workerReady, true); assert.equal(f.remote.resets, 2);
    assert.equal(f.remote.mode, 'paused'); assert.equal(f.control.view().humanClient, null);
    await f.retry(); assert.equal(f.remote.resets, 2);
  } finally { await f.close(); }
});

test('仅截图失败也撤销输入，待 Guest 桌面恢复后才能就绪', async () => {
  const f = await fixture();
  try {
    await f.control.reconnect(); await f.control.command('human', 'take');
    f.remote.frame = false; await f.retry();
    assert.equal(f.remote.mode, 'paused'); assert.equal(f.control.view().workerReady, false);
    assert.match(f.control.view().connection.error!, /登录/);
    f.remote.frame = true; await f.retry(); assert.equal(f.control.view().workerReady, true);
    await assert.rejects(f.control.input('human', { kind: 'text', text: 'never' }));
  } finally { await f.close(); }
});

test('Worker 在线但桌面锁定时区分观察与输入就绪，撤权且不自动恢复人工租约', async () => {
  const f = await fixture();
  try {
    await f.control.reconnect(); await f.control.command('human', 'take');
    f.remote.observable = false; f.remote.inputReady = false; f.remote.blockedReason = 'desktop_locked';
    await f.retry();
    const connection = f.control.view().connection;
    assert.equal(connection.status, 'not_ready'); assert.equal(connection.workerOnline, true);
    assert.equal(connection.readyForObservation, false); assert.equal(connection.readyForInput, false);
    assert.equal(connection.blockedReason, 'desktop_locked');
    assert.equal(f.control.view().mode, 'PAUSED'); assert.equal(f.remote.mode, 'paused');
    await assert.rejects(f.control.input('human', { kind: 'text', text: 'never' }));
    assert.equal(f.remote.inputs, 0);
    f.remote.observable = true; f.remote.inputReady = true; f.remote.blockedReason = null;
    await f.retry();
    assert.equal(f.control.view().connection.status, 'ready');
    assert.equal(f.control.view().humanClient, null);
  } finally { await f.close(); }
});

test('截图可观察但 Guest 不允许输入时仍冻结控制权', async () => {
  const f = await fixture();
  try {
    f.remote.inputReady = false; f.remote.blockedReason = 'permission_mismatch';
    await f.control.reconnect();
    assert.equal(f.control.view().connection.status, 'not_ready');
    assert.equal(f.control.view().connection.readyForObservation, true);
    assert.equal(f.control.view().connection.readyForInput, false);
    await assert.rejects(f.control.beginTask('never'));
    assert.equal(f.remote.inputs, 0);
  } finally { await f.close(); }
});

test('地址变化到错误 VM/不兼容 Worker 时不发送 reset 或输入', async () => {
  const f = await fixture(), other = await fixture();
  try {
    await f.control.reconnect(); await f.control.command('old-human', 'take');
    other.remote.id = 'another-vm';
    f.sessions.updateWorkerEndpoint('s', other.url);
    await assert.rejects(f.control.input('old-human', { kind: 'text', text: 'never' }), /地址已变化/);
    assert.equal(other.remote.posts, 0);
    assert.equal(f.control.view().mode, 'PAUSED');
    await f.retry();
    assert.equal(f.control.view().connection.status, 'incompatible'); assert.equal(other.remote.posts, 0);
    other.remote.id = 'vm'; other.remote.compatible = false; await f.retry();
    assert.equal(other.remote.posts, 0);
    other.remote.compatible = true; await f.retry();
    assert.equal(f.control.view().workerReady, true); assert.equal(other.remote.resets, 1);
    assert.equal(f.control.view().mode, 'PAUSED'); assert.equal(f.control.view().humanClient, null);
    await assert.rejects(f.control.input('old-human', { kind: 'text', text: 'never' }));
    assert.equal(other.remote.inputs, 0);
  } finally { await f.close(); await other.close(); }
});

test('旧 Worker 未上报桌面就绪信号时不把在线误判为可输入', async () => {
  const f = await fixture();
  try {
    f.remote.reportReadiness = false;
    await f.control.reconnect();
    assert.equal(f.control.view().workerReady, false);
    assert.equal(f.control.view().connection.status, 'incompatible');
    assert.match(f.control.view().connection.error!, /Desktop Readiness/);
    assert.equal(f.remote.posts, 0);
  } finally { await f.close(); }
});

test('运行中断线等待安全收尾，保留未决动作并禁止自动恢复', async () => {
  const f = await fixture(); const trace = new SqliteTrace(join(f.dir, 'web-tasks.sqlite'));
  try {
    trace.save('queued', initialState('t', 'VM: test'));
    await f.control.reconnect(); await f.control.beginTask('t');
    trace.save('dispatch_pending', { ...trace.load('t')!, inFlightAction: { kind: 'keypress', keys: 'space' } });
    f.remote.epoch = 'new-process'; await f.retry();
    assert.equal(f.control.view().mode, 'PAUSING'); assert.equal(trace.pauseRequested('t'), true);
    assert.equal(f.remote.resets, 1); // no subprocess reset while task is still in flight
    trace.save('task_error', { ...trace.load('t')!, status: 'paused', error: 'Application window not found', setupPaused: true });
    await f.control.finishTask('t', 'failed');
    assert.equal(trace.load('t')?.status, 'paused'); assert.equal(trace.load('t')?.recoveryRequired, true);
    assert.equal(trace.load('t')?.recoveryUncertain, true);
    assert.equal(trace.load('t')?.error, 'Application window not found');
    assert.match(trace.load('t')!.summary!, /Application window not found/);
    await f.retry(); assert.equal(f.remote.resets, 2);
    assert.equal(f.control.view().mode, 'PAUSED'); assert.equal(f.control.view().taskId, 't');
  } finally { trace.close(); await f.close(); }
});

test('关闭时等待在途探测，迟到结果不能使 Worker 重新就绪', async () => {
  const f = await fixture(); let release!: () => void;
  try {
    await f.control.reconnect();
    f.remote.hold = new Promise<void>(r => { release = r; });
    const probe = f.control.reconnect();
    await new Promise(r => setTimeout(r, 10));
    const closing = f.control.close(); release(); await probe; await closing;
    assert.equal(f.remote.resets, 1); await assert.rejects(f.control.reconnect());
  } finally { release?.(); await f.close(); }
});

test('已完成任务收尾遇到断线时释放绑定，不阻塞后续任务', async () => {
  const f = await fixture(); const trace = new SqliteTrace(join(f.dir, 'web-tasks.sqlite'));
  try {
    trace.save('queued', initialState('t', 'VM: test'));
    await f.control.reconnect(); await f.control.beginTask('t');
    trace.save('done', { ...trace.load('t')!, status: 'done' });
    f.remote.offline = true; await f.control.finishTask('t', 'done');
    assert.equal(trace.load('t')?.status, 'done'); assert.equal(f.control.view().taskId, null);
    f.remote.offline = false; await f.retry(); await f.control.beginTask('next');
    assert.equal(f.control.view().taskId, 'next');
  } finally { trace.close(); await f.close(); }
});

test('连接配置校验拒绝无界/负数退避', () => {
  const dir = mkdtempSync(join(tmpdir(), 'connection-config-')); mkdirSync(join(dir, 'config'));
  try {
    writeFileSync(join(dir, 'config/desktop-connection.json'), JSON.stringify({ pollMs: -1 }));
    assert.throws(() => connectionConfig(dir), /pollMs/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('停止任务在 Worker 重启后仍保持停止，自动重试遵守退避', async () => {
  const f = await fixture();
  try {
    await f.control.reconnect(); await f.control.command('user', 'stop');
    f.remote.offline = true; await f.retry();
    // A longer configured delay makes this assertion deterministic without racing a 1ms deadline.
    const until = f.control.view().connection.retryAt!;
    const now = Date.now; Date.now = () => until - 1;
    try { const states = f.remote.states; await f.control.reconnect(); assert.equal(f.remote.states, states); }
    finally { Date.now = now; }
    f.remote.offline = false; f.remote.epoch = 'new'; await f.retry();
    assert.equal(f.control.view().mode, 'STOPPED'); assert.equal(f.remote.mode, 'stopped');
  } finally { await f.close(); }
});

test('离线时停止仍记录本地意图，重连后同步 stopped', async () => {
  const f = await fixture();
  try {
    await f.control.reconnect(); f.remote.offline = true;
    const state = await f.control.command('user', 'stop');
    assert.equal(state.mode, 'STOPPED'); assert.equal(state.workerReady, false);
    f.remote.offline = false; await f.retry();
    assert.equal(f.remote.mode, 'stopped'); assert.equal(f.control.view().mode, 'STOPPED');
  } finally { await f.close(); }
});
