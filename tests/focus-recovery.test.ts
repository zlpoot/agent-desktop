import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { FakeModel } from "../src/agent/model-adapter.js";
import { createAgentLoop } from "../src/graph/graph.js";
import { continuePausedTask } from "../src/graph/resume.js";
import { initialState } from "../src/graph/state.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";

const click = { kind: "click" as const, target: { kind: "role" as const,
  role: "button", name: "进入游戏" } };
const resolved = { selected: "uia", reason: "唯一控件", candidates: [
  { provider: "uia", available: true, reason: "唯一控件" }] };

test("执行前失焦时先恢复焦点并重新观察，不执行旧定位动作", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-focus-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  let focused = false;
  let observed = 0;
  let executed = 0;
  const runtime = {
    async observe() { observed++; return { pageText: executed ? "已进入游戏" : "进入游戏" }; },
    async resolveAction() {
      if (!focused) throw new Error("目标窗口前台或权限条件不满足");
      return resolved;
    },
    async recoverFocus() { focused = true; },
    async execute() { executed++; return { ok: true, message: "已点击" }; },
  };
  try {
    const model = new FakeModel([click, click, { kind: "done", summary: "已进入游戏" }]);
    const result = await createAgentLoop({ model, runtime, trace }).invoke(initialState(
      "focus-restored", "进入游戏", undefined, { pageTextIncludes: "已进入游戏" }));
    assert.equal(result.status, "done");
    assert.equal(executed, 1);
    assert.ok(observed >= 3);
    assert.equal(trace.events("focus-restored").filter((event) => event.node === "focus_recover").length, 1);
  } finally { trace.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("焦点无法恢复时暂停；继续后重新观察再执行，不耗尽普通重试", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-focus-pause-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  const saver = SqliteSaver.fromConnString(join(dir, "checkpoints.sqlite"));
  let focused = false;
  let executed = 0;
  const runtime = {
    async observe() { return { pageText: executed ? "已进入游戏" : "进入游戏" }; },
    async resolveAction() {
      if (!focused) throw new Error("目标窗口前台或权限条件不满足");
      return resolved;
    },
    async recoverFocus() { if (!focused) throw new Error("系统拒绝聚焦"); },
    async execute() { executed++; return { ok: true, message: "已点击" }; },
  };
  const model = new FakeModel([click, click, { kind: "done", summary: "已进入游戏" }]);
  try {
    const graph = createAgentLoop({ model, runtime, trace, checkpointer: saver });
    await graph.invoke(initialState("focus-paused", "进入游戏", undefined,
      { pageTextIncludes: "已进入游戏" }), { configurable: { thread_id: "focus-paused" } });
    assert.equal(trace.load("focus-paused")?.status, "paused");
    assert.match(trace.load("focus-paused")?.error ?? "", /无法恢复目标窗口焦点/);
    assert.equal(executed, 0);
    assert.equal(trace.events("focus-paused").filter((event) => event.node === "recover").length, 0);
    focused = true;
    const result = await continuePausedTask(graph, "focus-paused");
    assert.equal(result.status, "done");
    assert.equal(executed, 1);
  } finally { saver.db.close(); trace.close(); rmSync(dir, { recursive: true, force: true }); }
});
