// 只测试纯流程状态机；全部能力返回由 Fake 提供，不连接服务、不访问真实窗口。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../ui.html'), 'utf8');
const engine = html.match(/<script id="song-flow-engine">([\s\S]*?)<\/script>/)[1];
const Flow = vm.runInNewContext(engine + '\nSongOpenFlow;');
const row = (roleName, name, extra = {}) => ({ roleName, name, enabled: true, offscreen: false, autoId: '', ...extra });
const edit = row('Edit', '占位文字', { runtimeId: [1] });
const search = row('Button', '搜索');
const title = row('Text', Flow.title);
const artist = row('Text', Flow.artist);

function fixture() {
  const state = { facts: { targetWindow: 123 } };
  const f = { calls: [], rows: [search], complete: true, failClick: false, pid: 10, actual: Flow.query,
    instanceId: 'fake-instance', observeRid: [1] };
  f.flow = new Flow(async (id, args) => {
    f.calls.push({ id, args });
    let result = {};
    if (id === 'verify.target.identity') result = { ok: true, inJob: true, sameUser: true,
      sameSession: true, alive: true, desktopName: 'fake-owned', pid: f.pid, session: 5, instanceId: f.instanceId };
    if (id === 'observe.uia.tree') result = { items: args.role === '50004' ? [{...edit, runtimeId: f.observeRid}] : f.rows, enumerationComplete: f.complete };
    if (id === 'locate.structured') result = { ...args, identity: { runtimeId: [1], identityRebound: true, globalUnique: true } };
    if (id === 'verify.structured.equals') result = { ok: true, actual: f.actual };
    if (id === 'act.click') {
      if (f.failClick) throw new Error('dispatch-effect-unknown');
      result = { dispatched: true };
      if (args.target.value === '搜索') f.rows = [title, artist];
    }
    if (id === 'observe.capture') result = { token: 'synthetic-frame', unrendered: false };
    return { ok: true, result, state };
  });
  return f;
}
async function toEntry(f) { for (let n = 0; n < 4; n++) await f.flow.execute(); }
async function toSong(f) { await toEntry(f); await f.flow.execute({ entry: 0 }); }

test('定位身份证据传给后续输入和独立回读；原实例变化在输入前停止', async () => {
  const f = fixture();
  await f.flow.execute(); await f.flow.execute(); await f.flow.execute();
  assert.deepEqual(f.calls.find(c => c.id === 'act.set_value').args.target.expectedIdentity.runtimeId, [1]);
  assert.deepEqual(f.calls.find(c => c.id === 'verify.structured.equals').args.target.expectedIdentity.runtimeId, [1]);
  const changed = fixture();
  await changed.flow.execute(); await changed.flow.execute();
  changed.instanceId = 'rebuilt';
  await changed.flow.execute();
  assert.equal(changed.flow.failed, true);
  assert.ok(!changed.calls.some(c => c.id.startsWith('act.')));
});

test('独立观察出现另一个同角色搜索框时，不把局部匹配当成原目标', async () => {
  const f = fixture();
  await f.flow.execute(); f.observeRid = [999]; await f.flow.execute();
  assert.equal(f.flow.failed, true);
  assert.match(f.flow.message, /已被替换/);
  assert.ok(!f.calls.some(c => c.id.startsWith('act.')));
});

test('兼容实际 UIA 的英文 search 入口，不将 research 或危险动作当搜索', () => {
  const f = fixture();
  assert.ok(f.flow.searchEntry(row('Button', 'search')));
  assert.ok(f.flow.searchEntry(row('Button', 'Search')));
  assert.equal(f.flow.searchEntry(row('Button', 'research')), false);
  assert.equal(f.flow.searchEntry(row('Button', 'search download')), false);
  assert.equal(f.flow.searchEntry(row('Edit', 'search')), false);
});

test('歌名只统一括号与空白；不接受伴奏、合唱、翻唱、Live 或重复版本', async () => {
  const f = fixture();
  assert.ok(f.flow.songNameMatches('甲乙丙丁 (你我怎么两清)'));
  for (const name of ['甲乙丙丁 (你我怎么两清伴奏)', '甲乙丙丁 (合唱版)',
                      '甲乙丙丁 (Cover 李佳薇)', Flow.title + ' Live', '甲乙丙丁']) {
    assert.equal(f.flow.songNameMatches(name), false, name);
  }
  await toSong(f);
  f.flow.rows = [title, row('Text', '甲乙丙丁 (你我怎么两清)'), artist];
  await assert.rejects(() => f.flow.execute({ song: 0, sameRow: true }), /不唯一/);
});

test('每次只前进一步，核验详情后仍须人工确认，不调用收藏或按键', async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  await f.flow.execute();
  assert.equal(f.flow.step, 1);
  assert.equal(f.calls.length, 1);
  await f.flow.execute();
  await f.flow.execute();
  assert.equal(f.flow.records[2].verification.status, '自动通过');
  await f.flow.execute();
  await f.flow.execute({ entry: 0 });
  await f.flow.execute({ song: 0, sameRow: true });
  await f.flow.execute();
  assert.equal(f.flow.done, false);
  assert.equal(f.flow.step, 7);
  assert.equal(f.flow.records.at(-1).verification.status, '待后续核验');
  await assert.rejects(() => f.flow.execute(), /确认画面/);
  await f.flow.execute({ detailConfirmed: true });
  assert.equal(f.flow.done, true);
  assert.equal(f.flow.records.at(-1).verification.automaticAcceptance, false);
  assert.ok(f.calls.every(call => !/favorite|keypress|type$|invoke$/.test(call.id)));
  assert.ok(f.calls.filter(c => c.id === 'act.click').every(c => c.args.double === false));
  assert.ok(f.flow.records.every(record => record.calls[0].capability === 'verify.target.identity'));
});
test('输入回读不一致会停止，不能推进下一步', async () => {
  const f = fixture();
  await f.flow.execute(); await f.flow.execute();
  f.actual = '其他文本';
  await f.flow.execute();
  assert.equal(f.flow.failed, true);
  assert.equal(f.flow.step, 2);
  await assert.rejects(() => f.flow.execute(), /不能继续/);
});
test('截断观察不能用于选择搜索入口', async () => {
  const f = fixture();
  await f.flow.execute(); await f.flow.execute(); await f.flow.execute();
  f.complete = false;
  await f.flow.execute();
  assert.equal(f.flow.failed, true);
  assert.equal(f.flow.step, 3);
  assert.equal(f.calls.filter(c => c.id === 'act.click').length, 0);
});
test('窗口或进程变化后，在任何输入前拒绝', async () => {
  const f = fixture();
  await f.flow.execute(); await f.flow.execute();
  f.pid = 99;
  await f.flow.execute();
  assert.equal(f.flow.failed, true);
  assert.ok(!f.calls.some(c => c.id.startsWith('act.')));
});
test('搜索框与危险按钮不能选作搜索入口，同名目标不能取第一条', async () => {
  const f = fixture(); await toEntry(f);
  for (const forbidden of [row('Edit', Flow.query), row('Button', '搜索并收藏'), row('Button', '下载搜索结果')]) {
    f.flow.rows = [forbidden];
    await assert.rejects(() => f.flow.execute({ entry: 0 }));
  }
  f.flow.rows = [search, search];
  await assert.rejects(() => f.flow.execute({ entry: 0 }), /不唯一/);
  assert.equal(f.calls.filter(c => c.id === 'act.click').length, 0);
});
test('版本不准确、未确认同一行歌手、点击前歌手消失时不发送打开动作', async () => {
  const f = fixture(); await toSong(f);
  await assert.rejects(() => f.flow.execute({ song: 0 }), /歌手/);
  f.flow.rows = [row('Text', Flow.title + ' Live'), artist];
  await assert.rejects(() => f.flow.execute({ song: 0, sameRow: true }), /准确歌曲/);
  f.flow.rows = [title, artist]; f.rows = [title];
  await f.flow.execute({ song: 0, sameRow: true });
  assert.equal(f.flow.failed, true);
  assert.equal(f.calls.filter(c => c.id === 'act.click').length, 1); // 只有此前搜索点击。
});
test('点击效果未知后不自动重试；新一轮保留旧记录且重新观察', async () => {
  const f = fixture(); await toEntry(f);
  f.failClick = true;
  await f.flow.execute({ entry: 0 });
  assert.equal(f.flow.failed, true);
  await assert.rejects(() => f.flow.execute({ entry: 0 }), /不能继续/);
  assert.equal(f.calls.filter(c => c.id === 'act.click').length, 1);
  f.flow.reset();
  assert.equal(f.flow.history.length, 1);
  assert.equal(f.flow.step, 0);
  assert.equal(f.flow.rows.length, 0);
});
test('补充观察不重复搜索或打开，不推进步骤', async () => {
  const f = fixture(); await toEntry(f);
  f.rows = [row('Button', '搜索 ' + Flow.query)];
  await f.flow.reobserve();
  assert.equal(f.flow.step, 4);
  assert.equal(f.flow.rows[0].name, '搜索 ' + Flow.query);
  assert.equal(f.calls.filter(c => c.id === 'act.click').length, 0);
});
test('本轮执行中拒绝并发执行或重置', async () => {
  let release;
  const f = new Flow(() => new Promise(resolve => { release = resolve; }));
  const pending = f.execute();
  await assert.rejects(() => f.execute(), /不能继续/);
  assert.throws(() => f.reset(), /正在执行/);
  release({ ok: false, error: { code: 'fake-denied' } });
  await pending;
  assert.equal(f.failed, true);
});

test('长子调用显示执行中及单调等待时间，结束后停止计时且保留耗时', async () => {
  const f = fixture();
  let now = 0, release, ready;
  f.flow.clock = () => now;
  await f.flow.execute();
  const entered = new Promise(resolve => { ready = resolve; });
  const invoke = f.flow.invoke;
  f.flow.invoke = async (id, args) => {
    if (id === 'locate.structured') {
      ready();
      await new Promise(resolve => { release = resolve; });
    }
    return invoke(id, args);
  };
  const pending = f.flow.execute();
  await entered;
  assert.equal(f.flow.records.at(-1).verification.status, '执行中');
  assert.equal(f.flow.progress().capability, 'locate.structured');
  now = 2300;
  assert.equal(f.flow.progress().elapsedMs, 2300);
  now = 4100;
  assert.equal(f.flow.progress().elapsedMs, 4100);
  release();
  await pending;
  assert.equal(f.flow.progress(), null);
  const call = f.flow.records.at(-1).calls.find(c => c.capability === 'locate.structured');
  assert.equal(call.elapsedMs, 4100);
  assert.equal(call.status, '调用成功');
  now = 99900;
  assert.equal(call.elapsedMs, 4100);
  assert.equal(f.flow.records.at(-1).verification.status, '自动通过');
});

test('失败子调用清除运行计时，保留失败耗时，不自动重试', async () => {
  let now = 0, release;
  const f = new Flow(() => new Promise(resolve => { release = resolve; }), () => {}, () => now);
  const pending = f.execute();
  now = 5000;
  release({ ok: false, error: { code: 'fake-failure' } });
  await pending;
  assert.equal(f.progress(), null);
  assert.equal(f.records[0].calls[0].elapsedMs, 5000);
  assert.equal(f.records[0].calls[0].status, '失败／效果须核对');
  await assert.rejects(() => f.execute(), /不能继续/);
});

test('页面计时只更新文字，不重绘记录；目录调用也显示等待时间', () => {
  const source = html.replace(/\r\n/g, '\n').match(/function updateFlowProgress\(\) \{[\s\S]*?\n}\n/)[0];
  const live = {}, current = {}, verdict = {};
  const context = { songFlow: { progress: () => ({ capability: 'observe.uia.tree', purpose: '独立观察', elapsedMs: 12300 }) },
    catalogPending: { id: 'locate.structured', started: 0 }, performance: { now: () => 2100 },
    $: () => live, document: { querySelectorAll: () => [current], querySelector: () => verdict } };
  vm.runInNewContext(source + '\nupdateFlowProgress();', context);
  assert.match(live.textContent, /observe.uia.tree.*12\.3 秒/);
  assert.equal(current.textContent, live.textContent);
  assert.match(verdict.textContent, /locate.structured.*2\.1 秒/);
  assert.equal(current.innerHTML, undefined);
});
