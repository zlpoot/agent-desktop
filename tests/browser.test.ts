import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeModel } from "../src/agent/model-adapter.js";
import { createAgentLoop } from "../src/graph/graph.js";
import { initialState } from "../src/graph/state.js";
import { PlaywrightRuntime } from "../src/runtime/browser/playwright-runtime.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";

test("Chromium 在网页上完成输入、导航、点击、滚动与截图", async () => {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/") {
      response.end('<form action="/results"><label for="q">搜索</label><input id="q" name="q"><button>查询</button></form>');
    } else if (url.pathname === "/results") {
      response.end(`<main>搜索结果：${url.searchParams.get("q")}<a href="/detail">打开结果</a></main>`);
    } else {
      response.end("<main>目标详情页</main>");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const base = `http://127.0.0.1:${address.port}`;
  const dir = mkdtempSync(join(tmpdir(), "computer-use-browser-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  let runtime: PlaywrightRuntime | undefined;
  try {
    runtime = await PlaywrightRuntime.launch({ artifactDir: join(dir, "screenshots") });
    const model = new FakeModel([
      { kind: "navigate", url: base },
      { kind: "type", target: { kind: "label", label: "搜索" }, text: "LangGraph" },
      { kind: "keypress", keys: "Enter" },
      { kind: "click", target: { kind: "role", role: "link", name: "打开结果" } },
      { kind: "scroll", direction: "down", amount: 200 },
      { kind: "wait", ms: 20 },
      { kind: "screenshot" },
      { kind: "done", summary: "已打开目标详情页" },
    ]);
    const shadow:import('../src/verification/host-shadow.js').HostShadowRecord[]=[];
    const result = await createAgentLoop({ model, runtime, trace, maxSteps: 10,
      shadowSink:record=>{shadow.push(record);throw new Error('simulated shadow disk error');} })
      .invoke(initialState("browser-task", "搜索并打开结果", undefined,
        { urlIncludes: "/detail", pageTextIncludes: "目标详情页" }));
    assert.equal(result.status, "done");
    assert.ok(shadow.some(r=>r.kind==='contract'));
    assert.ok(shadow.some(r=>r.kind==='observation'));
    assert.ok(shadow.filter(r=>r.kind==='observation').some(r=>r.status==='ready_for_normalization'));
    assert.ok(shadow.filter(r=>r.kind==='observation').some(r=>r.status==='blocked'));
    assert.equal(result.observation?.capture?.clock,'collector');
    assert.equal(result.observation?.capture?.fields.pageText.complete,true);
    assert.ok(result.observation!.capture!.finishedAt>=result.observation!.capture!.startedAt);
    assert.equal(result.observation?.url, `${base}/detail`);
    assert.match(result.observation?.pageText ?? "", /目标详情页/);
    assert.equal(result.observation?.textEvidence?.[0]?.source, "dom");
    assert.deepEqual(await runtime.extractDom("main"), [{ text: "目标详情页", attributes: {} }]);
    await assert.rejects(runtime.extractDom("main", ["onclick"]), /参数无效/);
    assert.match(result.observation?.accessibility ?? "", /目标详情页/);
    assert.ok(result.observation?.screenshot);
    assert.ok(trace.events("browser-task").filter((event) => event.node === "observe").length >= 7);
    assert.ok(trace.metrics("browser-task").some((metric) =>
      metric.node === "execute" && metric.operator === "browser.playwright.act"));
    assert.ok(trace.actionResolutions("browser-task").some((entry) =>
      entry.selected === "browser.playwright.act" && entry.actual === "browser.playwright.act" &&
      entry.executedOk));
    assert.equal(trace.groundingStats("browser-task").find((row) => row.strategy === "role")?.executedSuccesses, 1);
    assert.ok(trace.events("browser-task").some((event) => event.node === "ground" &&
      event.state.targetBinding?.semantic?.label === "打开结果" &&
      event.state.targetBinding.strategy === "role"));
    const verifications = trace.events("browser-task").filter((event) => event.node === "verify");
    assert.equal(verifications.length, 7);
    assert.ok(verifications.every((event) => event.state.lastVerification?.ok));
    assert.equal(result.goalVerification?.ok, true);
  } finally {
    await runtime?.close();
    trace.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("按 Enter 打开新标签页后切换观察目标", async () => {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(request.url === "/result"
      ? "<main>搜索结果已打开</main>"
      : '<input aria-label="搜索" onkeydown="if(event.key===\'Enter\') window.open(\'/result\', \'_blank\')">');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const dir = mkdtempSync(join(tmpdir(), "computer-use-popup-"));
  let runtime: PlaywrightRuntime | undefined;
  try {
    runtime = await PlaywrightRuntime.launch({ artifactDir: join(dir, "screenshots") });
    await runtime.execute({ kind: "navigate", url: `http://127.0.0.1:${address.port}/` });
    await runtime.execute({ kind: "type", target: { kind: "role", role: "textbox", name: "搜索" },
      text: "LangGraph" });
    const action = await runtime.execute({ kind: "keypress", keys: "Enter" });
    assert.equal(action.ok, true);
    const observation = await runtime.observe();
    assert.equal(observation.url, `http://127.0.0.1:${address.port}/result`);
    assert.match(observation.pageText ?? "", /搜索结果已打开/);
  } finally {
    await runtime?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("浏览器双击实际触发页面 dblclick 事件", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end('<button ondblclick="document.querySelector(\'#result\').textContent=\'双击已完成\'">双击目标</button><p id="result">等待</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const dir = mkdtempSync(join(tmpdir(), "computer-use-double-click-"));
  let runtime: PlaywrightRuntime | undefined;
  try {
    runtime = await PlaywrightRuntime.launch({ artifactDir: join(dir, "screenshots") });
    await runtime.execute({ kind: "navigate", url: `http://127.0.0.1:${address.port}/` });
    const result = await runtime.execute({ kind: "double_click",
      target: { kind: "role", role: "button", name: "双击目标" } });
    assert.equal(result.ok, true);
    assert.equal(result.provider, "browser.playwright.act");
    assert.match((await runtime.observe()).pageText ?? "", /双击已完成/);
  } finally {
    await runtime?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("浏览器拖拽需要唯一 DOM 目标，并产生可观察结果", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<div aria-label="物品" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','物品')">物品</div>
      <div aria-label="目标区域" ondragover="event.preventDefault()"
        ondrop="event.preventDefault();this.textContent='已放入：'+event.dataTransfer.getData('text/plain')">目标区域</div>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const dir = mkdtempSync(join(tmpdir(), "computer-use-drag-"));
  let runtime: PlaywrightRuntime | undefined;
  try {
    runtime = await PlaywrightRuntime.launch({ artifactDir: join(dir, "screenshots") });
    await runtime.execute({ kind: "navigate", url: `http://127.0.0.1:${address.port}/` });
    const action = await runtime.execute({ kind: "drag",
      source: { kind: "selector", selector: '[aria-label="物品"]' },
      destination: { kind: "selector", selector: '[aria-label="目标区域"]' } });
    assert.equal(action.ok, true, action.message);
    assert.equal(action.provider, "browser.playwright.act");
    assert.match((await runtime.observe()).pageText ?? "", /已放入：物品/);
  } finally {
    await runtime?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
