import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { ComputerAction, Observation, ActionResult } from "../src/actions/schema.js";
import { FakeModel } from "../src/agent/model-adapter.js";
import { createAgentLoop } from "../src/graph/graph.js";
import { resumeSavedTask } from "../src/graph/resume.js";
import { initialState } from "../src/graph/state.js";
import type { RuntimeAdapter } from "../src/runtime/runtime-adapter.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";

class ApprovalRuntime implements RuntimeAdapter {
  readonly executed: ComputerAction[] = [];
  private submitted = false;
  private restored = false;
  constructor(private readonly changedOnRestore = false) {}
  async restore(observation: Observation): Promise<void> {
    assert.equal(observation.url, "https://example.com/form");
    this.restored = true;
  }
  async observe(): Promise<Observation> {
    const text = this.submitted ? "提交成功" : this.changedOnRestore && this.restored ? "待提交，内容已变化" : "待提交";
    return { url: "https://example.com/form", pageText: text, dom: `<main>${text}</main>` };
  }
  async execute(action: ComputerAction): Promise<ActionResult> {
    this.executed.push(action);
    this.submitted = true;
    return { ok: true, message: "已执行" };
  }
}

test("高风险动作中断，关闭检查点连接后批准并恢复", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-human-"));
  const checkpointPath = join(dir, "checkpoints.sqlite");
  const tracePath = join(dir, "trace.sqlite");
  const config = { configurable: { thread_id: "approval-task" } };
  const action = { kind: "click" as const, target: { kind: "role" as const, role: "button", name: "提交" } };
  try {
    const firstCheckpoint = SqliteSaver.fromConnString(checkpointPath);
    const firstTrace = new SqliteTrace(tracePath);
    const firstRuntime = new ApprovalRuntime();
    const firstGraph = createAgentLoop({ model: new FakeModel([action]), runtime: firstRuntime,
      trace: firstTrace, checkpointer: firstCheckpoint });
    const paused = await firstGraph.invoke(initialState("approval-task", "提交表单", undefined,
      { pageTextIncludes: "提交成功" }), config);
    assert.equal(paused.status, "waiting_user");
    assert.equal(firstRuntime.executed.length, 0);
    assert.equal((await firstGraph.getState(config)).tasks.length, 1);
    firstTrace.close();
    firstCheckpoint.db.close();

    const secondCheckpoint = SqliteSaver.fromConnString(checkpointPath);
    const secondTrace = new SqliteTrace(tracePath);
    const secondRuntime = new ApprovalRuntime();
    try {
      const resumedGraph = createAgentLoop({ model: new FakeModel([{ kind: "done", summary: "提交完成" }]),
        runtime: secondRuntime, trace: secondTrace, checkpointer: secondCheckpoint });
      const result = await resumeSavedTask(resumedGraph, secondRuntime, "approval-task", { approved: true });
      assert.equal(result.status, "done");
      assert.equal(result.goalVerification?.ok, true);
      assert.equal(secondRuntime.executed.length, 1);
      assert.equal(secondTrace.load("approval-task")?.status, "done");
    } finally { secondTrace.close(); secondCheckpoint.db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("批准后页面内容变化时再次暂停，不执行旧动作", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-changed-"));
  const checkpoint = SqliteSaver.fromConnString(join(dir, "checkpoints.sqlite"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  const firstRuntime = new ApprovalRuntime();
  const action = { kind: "click" as const, target: { kind: "role" as const,
    role: "button", name: "发送" } };
  const config = { configurable: { thread_id: "changed-task" } };
  try {
    const firstGraph = createAgentLoop({ model: new FakeModel([action]), runtime: firstRuntime,
      trace, checkpointer: checkpoint });
    await firstGraph.invoke(initialState("changed-task", "发送内容"), config);
    const changedRuntime = new ApprovalRuntime(true);
    const resumedGraph = createAgentLoop({ model: new FakeModel([]), runtime: changedRuntime,
      trace, checkpointer: checkpoint });
    const pausedAgain = await resumeSavedTask(resumedGraph, changedRuntime,
      "changed-task", { approved: true });
    assert.equal(pausedAgain.status, "waiting_user");
    assert.equal(changedRuntime.executed.length, 0);
    assert.equal((await resumedGraph.getState(config)).tasks.length, 1);
  } finally { trace.close(); checkpoint.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("重复点击经人工批准后只再执行一次", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-repeat-"));
  const checkpoint = SqliteSaver.fromConnString(join(dir, "checkpoints.sqlite"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  const action = { kind: "click" as const,
    target: { kind: "role" as const, role: "button", name: "继续" } };
  const runtime: RuntimeAdapter & { count: number } = {
    count: 0,
    async restore() {},
    async observe() { return { pageText: this.count >= 2 ? "完成" : "等待" }; },
    async execute() { this.count++; return { ok: true, message: "已点击" }; },
  };
  const config = { configurable: { thread_id: "repeat-task" } };
  try {
    const first = createAgentLoop({ model: new FakeModel([action, action]), runtime, trace,
      checkpointer: checkpoint });
    const paused = await first.invoke(initialState("repeat-task", "点击直到完成", undefined,
      { pageTextIncludes: "完成" }), config);
    assert.equal(paused.status, "waiting_user");
    assert.equal(runtime.count, 1);
    const resumed = createAgentLoop({ model: new FakeModel([{ kind: "done", summary: "已完成" }]),
      runtime, trace, checkpointer: checkpoint });
    const result = await resumeSavedTask(resumed, runtime, "repeat-task", { approved: true });
    assert.equal(result.status, "done");
    assert.equal(runtime.count, 2);
  } finally { trace.close(); checkpoint.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("拒绝高风险动作后结束，且不执行动作", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-reject-"));
  const checkpoint = SqliteSaver.fromConnString(join(dir, "checkpoints.sqlite"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  const runtime = new ApprovalRuntime();
  const graph = createAgentLoop({ model: new FakeModel([
    { kind: "click", target: { kind: "role", role: "button", name: "删除" } },
  ]), runtime, trace, checkpointer: checkpoint });
  try {
    await graph.invoke(initialState("reject-task", "删除内容"),
      { configurable: { thread_id: "reject-task" } });
    const result = await resumeSavedTask(graph, runtime, "reject-task", { approved: false });
    assert.equal(result.status, "failed");
    assert.equal(runtime.executed.length, 0);
  } finally { trace.close(); checkpoint.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("模型提问在检查点中显示等待人工，并可带回答恢复", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-question-"));
  const checkpoint = SqliteSaver.fromConnString(join(dir, "checkpoints.sqlite"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  const runtime = new ApprovalRuntime();
  const config = { configurable: { thread_id: "question-task" } };
  try {
    const firstGraph = createAgentLoop({ model: new FakeModel([
      { kind: "ask_user", question: "请确认是否继续" },
    ]), runtime, trace, checkpointer: checkpoint });
    const paused = await firstGraph.invoke(initialState("question-task", "继续处理", undefined,
      { pageTextIncludes: "提交成功" }), config);
    assert.equal(paused.status, "waiting_user");
    assert.equal(trace.load("question-task")?.status, "waiting_user");
    const resumedGraph = createAgentLoop({ model: new FakeModel([
      { kind: "click", target: { kind: "role", role: "button", name: "继续" } },
      { kind: "done", summary: "已继续" },
    ]), runtime, trace, checkpointer: checkpoint });
    const result = await resumeSavedTask(resumedGraph, runtime, "question-task", { answer: "继续" });
    assert.equal(result.status, "done");
    assert.equal(result.userAnswer, "继续");
  } finally { trace.close(); checkpoint.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
