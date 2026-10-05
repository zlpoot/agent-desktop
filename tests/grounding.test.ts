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

test("定位按优先级回退，并记录各方法的命中与执行成功率", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`
      <input id="query" aria-label="查询词">
      <button id="first" onclick="document.querySelector('#result').textContent='第一步完成'">重复</button>
      <button>重复</button>
      <button id="second" onclick="document.querySelector('#result').textContent='全部完成'">继续</button>
      <p id="result"></p>
    `);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const dir = mkdtempSync(join(tmpdir(), "computer-use-grounding-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  let runtime: PlaywrightRuntime | undefined;
  try {
    runtime = await PlaywrightRuntime.launch({ artifactDir: join(dir, "screenshots") });
    const model = new FakeModel([
      { kind: "navigate", url: `http://127.0.0.1:${address.port}` },
      { kind: "type", target: { kind: "candidates", options: [
        { kind: "selector", selector: "#query" },
        { kind: "label", label: "不存在" },
      ] }, text: "LangGraph" },
      { kind: "click", target: { kind: "candidates", options: [
        { kind: "selector", selector: "#first" },
        { kind: "text", text: "重复" },
        { kind: "role", role: "button", name: "不存在" },
      ] } },
      { kind: "click", target: { kind: "candidates", options: [
        { kind: "selector", selector: "#second" },
        { kind: "text", text: "继续" },
      ] } },
      { kind: "done", summary: "已完成两次点击" },
    ]);
    const result = await createAgentLoop({ model, runtime, trace, maxSteps: 8 })
      .invoke(initialState("grounding-task", "按顺序完成页面操作", undefined,
        { pageTextIncludes: "全部完成" }));
    assert.equal(result.status, "done");
    assert.match(result.observation?.pageText ?? "", /全部完成/);
    const attempts = trace.events("grounding-task").filter((event) => event.node === "ground");
    assert.deepEqual(attempts.map((event) => event.state.groundingStrategy),
      [undefined, "selector", "selector", "text"]);
    const stats = Object.fromEntries(trace.groundingStats("grounding-task").map((row) => [row.strategy, row]));
    assert.equal(stats.label.attempts, 1);
    assert.equal(stats.label.matches, 0);
    assert.equal(stats.role.attempts, 1);
    assert.equal(stats.text.attempts, 2);
    assert.equal(stats.text.matches, 1);
    assert.equal(stats.text.executedSuccesses, 1);
    assert.equal(stats.text.matchRate, 0.5);
    assert.equal(stats.text.executionSuccessRate, 1);
    assert.equal(stats.selector.selections, 2);
    assert.equal(stats.selector.executedSuccesses, 2);
  } finally {
    await runtime?.close();
    trace.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
