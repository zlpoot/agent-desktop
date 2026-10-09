import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createDashboardServer } from "../src/app/server.js";
import { DesktopTaskController, type TaskController } from "../src/app/task-runner.js";
import { createDefaultExtensionRegistry } from "../src/extensions/index.js";
import { parseMusicRequest } from "../src/extensions/netease/netease-extension.js";
import { isNteVolumeRequest } from "../src/extensions/nte/nte-extension.js";
import { MusicModel } from "../src/extensions/netease/music-model.js";
import { initialState } from "../src/graph/state.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";
import { verifyGoal } from "../src/verifier/verifier.js";
import { FacetRegistry } from "../src/contracts/facets.js";
import { ContributorRegistry } from "../src/contracts/verifier-contributor.js";
import { createDomainEvaluator } from "../src/verification/domain-evaluator.js";
import { collectFacets } from "../src/verification/facet-binding.js";
import { musicContributor, musicFacetProvider } from "../src/extensions/netease/music-facet.js";
import type { Observation } from "../src/actions/schema.js";

test('任务提交明确执行位置，保留要求并拒绝冲突', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-destination-'));
  const goals: string[] = [];
  const targets: unknown[] = [];
  const target = { providerId: 'fixture', environmentId: 'env' };
  const controller: TaskController = {
    submit(goal, options) { goals.push(goal); targets.push(options?.desktopTarget); return 'test'; }, resume() {}, pause() {}, continue() {},
  };
  const server = createDashboardServer(dir, controller);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no server');
  const post = (body: object) => fetch(`http://127.0.0.1:${address.port}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await post({ goal: '整理文档', destination: 'guest', desktopTarget: target, criteria: '保留原文件', constraints: '不发送邮件' })).status, 202);
    assert.equal(goals[0], '整理文档\n完成条件：保留原文件\n操作限制：不发送邮件');
    assert.equal((await post({ goal: '整理文档', destination: 'host' })).status, 202);
    assert.equal(goals[1], '整理文档');
    for (const body of [{ goal: '测试', destination: 'guest' }, { goal: '测试', destination: 'host', desktopTarget: target }, { goal: '测试', desktopTarget: { providerId: '' } }, { goal: '测试', destination: 'invalid' },
      { goal: '测试', constraints: 42 }, { goal: '字'.repeat(4001) }]) {
      assert.equal((await post(body)).status, 400);
    }
    assert.equal(goals.length, 2);
    assert.deepEqual(targets, [target, undefined]);
    assert.equal((await post({ goal: '普通文本', destination: 'desktop', desktopTarget: target })).status, 202);
    assert.equal((await post({ goal: 'VM: 普通文本', destination: 'browser' })).status, 202);
    assert.equal(goals[3], 'VM: 普通文本');
    assert.deepEqual(targets.slice(2), [target, undefined]);
    for (const body of [{ goal: '测试', destination: 'desktop' }, { goal: '测试', destination: 'browser', desktopTarget: target },
      { goal: '测试', destination: ['desktop'] }]) assert.equal((await post(body)).status, 400);
    assert.equal((await post({ goal: '字'.repeat(1500), destination: 'guest', desktopTarget: target })).status, 202);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("播放需求提取歌曲，且必须凭当次播放器 facet 核验歌曲与播放状态", async () => {
  assert.deepEqual(parseMusicRequest("打开网易云播放周杰伦的稻香"),
    { search: "周杰伦 稻香", title: "稻香", artist: "周杰伦" });
  assert.throws(() => parseMusicRequest("打开网易云"), /歌曲/);

  const facetRegistry = new FacetRegistry();
  facetRegistry.register(musicFacetProvider);
  const contributors = new ContributorRegistry();
  contributors.register(musicContributor);
  const evaluate = createDomainEvaluator(contributors, facetRegistry);
  const criteria = { domainChecks: [
    { domain: "music.netease", predicate: "titleIncludes", args: { includes: "稻香" } },
    { domain: "music.netease", predicate: "artistIncludes", args: { includes: "周杰伦" } },
    { domain: "music.netease", predicate: "playing", args: { equals: true } },
  ] };
  const now = Date.now();
  const musicObservation = (windowTitle: string, autoId: string): Observation => ({
    windowTitle, windowHandle: 7,
    accessibility: `Button | 播放 |  | autoId=${autoId}`,
    capture: { epoch: "e", sequence: 1, object: "window:7", startedAt: now - 20, finishedAt: now,
      clock: "collector", atomic: false, fields: { uia: { complete: true, source: "uia" } } },
  });
  const capture = async (windowTitle: string, autoId: string) =>
    collectFacets(musicObservation(windowTitle, autoId), [musicFacetProvider]);

  // 暂停中：playing=false → FAIL
  assert.equal(verifyGoal(criteria, await capture("稻香 - 周杰伦", "btn_pc_minibar_play"), evaluate).ok, false);
  // 标题不符 → FAIL
  assert.equal(verifyGoal(criteria, await capture("七里香 - 周杰伦", "btn_pc_minibar_pause"), evaluate).ok, false);
  // 歌手不符 → FAIL
  assert.equal(verifyGoal(criteria, await capture("稻香 - 其他歌手", "btn_pc_minibar_pause"), evaluate).ok, false);
  // 全部满足且播放中 → PASS
  assert.equal(verifyGoal(criteria, await capture("稻香 - 周杰伦", "btn_pc_minibar_pause"), evaluate).ok, true);
  // 无播放器控件：采集不到 facet，即便条件相同也不能确认（UNKNOWN → ok=false）。
  const noPlayer = musicObservation("稻香 - 周杰伦", "");
  assert.equal(verifyGoal(criteria, await collectFacets(noPlayer, [musicFacetProvider]), evaluate).ok, false);
});

test("异环只接受固定的 50 音量目标，且要求显式管理员开关", () => {
  assert.equal(isNteVolumeRequest("在异环里把主音量调到 50%"), true);
  assert.equal(isNteVolumeRequest("异环音量调到 100"), false);
  assert.equal(isNteVolumeRequest("异环音量从 100 调到 50"), false);
  const dir = mkdtempSync(join(tmpdir(), "computer-use-nte-route-"));
  try {
    const controller = new DesktopTaskController(dir,
      { registry: createDefaultExtensionRegistry({ rootDir: dir }) });
    assert.throws(() => controller.submit("异环主音量调到 50"), /勾选开关/);
    assert.throws(() => controller.submit("打开网易云播放稻香", { admin: true }), /仅适用于/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("选曲只选择准确单曲，避免把翻唱当成指定歌手原曲", async () => {
  const accessibility = ["Edit | 搜索 | 稻香 | autoId=", "Text | 稻香 |  | autoId=",
    "TabItem | 单曲 |  | autoId=cmdTab1", "Table | grid |  | autoId=",
    "Group | 01 稻香 jymaster Montagem 青花瓷 like 03:03 |  | autoId=",
    "Group | 02 稻香(治愈版) jymaster 周杰伦. / 其他歌手 like 02:00 |  | autoId="].join("\n");
  const plain = new MusicModel({ search: "稻香", title: "稻香" });
  assert.deepEqual(await plain.decide({ ...initialState("plain", "播放稻香"),
    observation: { accessibility } }),
  { kind: "double_click", target: { kind: "role", role: "Group",
    name: "01 稻香 jymaster Montagem 青花瓷 like 03:03" } });
  const artist = new MusicModel({ search: "周杰伦 稻香", title: "稻香", artist: "周杰伦" });
  await assert.rejects(() => artist.decide({ ...initialState("artist", "播放周杰伦的稻香"),
    observation: { accessibility: accessibility.replaceAll("| 稻香 |", "| 周杰伦 稻香 |") } }), /没有找到准确/);
});

test("本机页面提交任务后显示结果，拒绝跨站和非 JSON 写入", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-web-task-"));
  const tracePath = join(dir, "web-tasks.sqlite");
  let submittedAdmin: boolean | undefined;
  const controller: TaskController = {
    submit(goal, options) {
      submittedAdmin = options?.admin;
      const trace = new SqliteTrace(tracePath);
      trace.save("finish", { ...initialState("web-1", goal,
        ["搜索歌曲", "播放歌曲"], { domainChecks: [
          { domain: "music.netease", predicate: "titleIncludes", args: { includes: "稻香" } },
          { domain: "music.netease", predicate: "playing", args: { equals: true } }] }),
        status: "done", summary: "已播放稻香", step: 2,
        observation: { facets: { "music.netease": { facetId: "music.netease", schemaVersion: 1,
          providerVersion: "1.0.0", captureId: "e:1",
          subjectRef: { kind: "desktop_window", key: "window:1:网易云音乐" },
          source: "uia", capturedAt: Date.now(), complete: true,
          data: { title: "稻香", artist: "", playing: true } } } },
        goalVerification: { ok: true, message: "独立完成条件已通过当前页面状态验证" } });
      trace.close();
      return "web-1";
    },
    resume() { throw new Error("不需要恢复"); },
    pause() { throw new Error("不需要暂停"); },
    continue() { throw new Error("不需要继续"); },
  };
  const server = createDashboardServer(dir, controller);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("页面服务未启动");
  const base = `http://127.0.0.1:${address.port}`;
  let browser: import("playwright").Browser | undefined;
  try {
    const denied = await fetch(`${base}/api/tasks`, { method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({ goal: "打开网易云播放稻香" }) });
    assert.equal(denied.status, 403);
    const wrongType = await fetch(`${base}/api/tasks`, { method: "POST",
      headers: { "Content-Type": "text/plain" }, body: "打开网易云播放稻香" });
    assert.equal(wrongType.status, 415);
    const wrongAdmin = await fetch(`${base}/api/tasks`, { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "异环主音量调到 50", admin: "true" }) });
    assert.equal(wrongAdmin.status, 400);
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".playwright-browsers");
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(base);
    await page.locator('#task-destination').selectOption('browser');
    await page.getByLabel("描述任务").fill("打开网易云播放稻香");
    await page.getByRole("button", { name: /发送任务/ }).click();
    await page.getByRole("heading", { name: "打开网易云播放稻香" }).waitFor();
    assert.match(await page.locator("#summary").innerText(), /已播放稻香/);
    assert.match(await page.locator("#task-message").innerText(), /任务已提交/);
    assert.equal(submittedAdmin, false);
    await page.getByRole('button', { name: '工作台', exact: true }).click();
    await page.getByLabel("描述任务").fill("异环主音量调到 50");
    await page.getByText("更多选项").click();
    await page.locator("#task-admin").check();
    await page.getByRole("button", { name: /发送任务/ }).click();
    assert.equal(submittedAdmin, true);
  } finally {
    await browser?.close();
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    rmSync(dir, { recursive: true, force: true });
  }
});
