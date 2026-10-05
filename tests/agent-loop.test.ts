import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeModel } from "../src/agent/model-adapter.js";
import { createAgentLoop } from "../src/graph/graph.js";
import { initialState } from "../src/graph/state.js";
import { FakeRuntime } from "../src/runtime/runtime-adapter.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";
import { MemorySaver } from "@langchain/langgraph";
import { continuePausedTask } from "../src/graph/resume.js";

function withTrace(run: (trace: SqliteTrace) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "computer-use-"));
    const trace = new SqliteTrace(join(dir, "trace.sqlite"));
    try { await run(trace); } finally { trace.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}

test("D3 通用任务在人工完成后重新观察并直接验证，不执行旧动作", withTrace(async trace => {
  let paused = true, text = "before";
  let executions = 0;
  const runtime = { observe: async () => ({ pageText: text }),
    execute: async () => { executions++; return { ok: true, message: "unexpected" }; } };
  const model = new FakeModel([{ kind: "click", target: { kind: "text", text: "old target" } }]);
  const graph = createAgentLoop({ model, runtime, trace, checkpointer: new MemorySaver(), pauseRequested: () => paused });
  await graph.invoke(initialState("d3-resume", "complete goal", undefined, { pageTextIncludes: "human completed" }),
    { configurable: { thread_id: "d3-resume" } });
  assert.equal(trace.load("d3-resume")?.status, "paused");
  text = "human completed"; paused = false;
  const result = await continuePausedTask(graph, "d3-resume");
  assert.equal(result.status, "done"); assert.equal(executions, 0);
  assert.ok(trace.events("d3-resume").some(event => event.node === "resume_reconcile"));
}));

test("paused browser restores its saved page before fresh verification without replaying actions",withTrace(async trace=>{
  let paused=true;let current='about:blank';let restored=0;let actions=0;
  const runtime={async observe(){return {url:current,pageText:current==='about:blank'?'':'目标已完成'};},
    async restore(observation:{url?:string}){restored++;current=observation.url??'about:blank';},
    async execute(){actions++;return {ok:true,message:'unexpected'};}};
  current='https://example.test/result';
  const graph=createAgentLoop({model:new FakeModel([{kind:'done',summary:'已完成'}]),runtime,trace,
    checkpointer:new MemorySaver(),pauseRequested:()=>paused});
  await graph.invoke(initialState('browser-paused-restore','查看结果',undefined,
    {pageTextIncludes:'目标已完成'}),{configurable:{thread_id:'browser-paused-restore'}});
  assert.equal(trace.load('browser-paused-restore')?.status,'paused');
  current='about:blank';paused=false;
  const result=await continuePausedTask(graph,'browser-paused-restore','browser-paused-restore',runtime);
  assert.equal(result.status,'done');assert.equal(restored,1);assert.equal(actions,0);
  assert.ok(trace.events('browser-paused-restore').some(event=>event.node==='resume_reconcile'));
}));

test("fake model completes multi-step loop and persists trace", withTrace(async (trace) => {
  const runtime = new FakeRuntime();
  const model = new FakeModel([
    { kind: "navigate", url: "https://example.com" },
    { kind: "done", summary: "opened" },
  ]);
  const result = await createAgentLoop({ model, runtime, trace }).invoke(initialState("task-1", "open example",
    undefined, { urlIncludes: "https://example.com" }));
  assert.equal(result.status, "done");
  assert.equal(result.summary, "opened");
  assert.equal(result.observation?.url, "https://example.com");
  assert.equal(runtime.executed.length, 1);
  assert.equal(trace.load("task-1")?.status, "done");
  assert.deepEqual(trace.events("task-1").map((event) => event.node).slice(0, 6),
    ["observe", "decide", "ground", "resolve_action", "risk_check", "execute"]);
  assert.equal(trace.actionResolutions("task-1")[0]?.selected, "模拟运行时");
  const metrics = trace.metrics("task-1");
  assert.ok(metrics.some((item) => item.node === "decide" && item.step === 1 &&
    item.actor === "rule" && item.operator === "脚本决策"));
  assert.ok(metrics.some((item) => item.node === "execute" && item.step === 1 &&
    item.actor === "runtime" && item.operator === "模拟运行时"));
  assert.ok(metrics.every((item) => item.durationMs >= 0 && item.startedAt));
}));

test("明确未发出点击时同一步改选候选执行器，并记录两次尝试", withTrace(async (trace) => {
  let completed = false;
  const calls: string[] = [];
  const runtime = {
    name: "测试执行器",
    observe: async () => ({ pageText: completed ? "已点击目标" : "等待点击" }),
    resolveAction: async () => ({ selected: "uia", reason: "优先 UIA", candidates: [
      { provider: "uia", available: true, reason: "结构化目标" },
      { provider: "mouse", available: true, reason: "无副作用时兜底" },
    ] }),
    execute: async (_action: unknown, resolution?: { selected: string }) => {
      calls.push(resolution!.selected);
      if (resolution!.selected === "uia") return { ok: false, message: "未找到 InvokePattern",
        effect: "none" as const, provider: "uia" };
      completed = true;
      return { ok: true, message: "已点击", effect: "dispatched" as const, provider: "mouse" };
    },
  };
  const model = new FakeModel([{ kind: "click", target: { kind: "role", role: "button", name: "目标" } },
    { kind: "done", summary: "已完成" }]);
  const result = await createAgentLoop({ model, runtime, trace }).invoke(initialState(
    "action-fallback", "点击目标", undefined, { pageTextIncludes: "已点击目标" }));
  assert.equal(result.status, "done");
  assert.deepEqual(calls, ["uia", "mouse"]);
  assert.deepEqual(trace.providerAttempts("action-fallback").map((item) => [item.provider, item.effect]),
    [["uia", "none"], ["mouse", "dispatched"]]);
  assert.equal(result.executedImpactActions?.length, 1);
}));

test("点击结果不明时不换执行器，重复动作继续等待人工", withTrace(async (trace) => {
  const calls: string[] = [];
  const runtime = {
    name: "测试执行器",
    observe: async () => ({ pageText: "状态未变化" }),
    resolveAction: async () => ({ selected: "uia", reason: "优先 UIA", candidates: [
      { provider: "uia", available: true, reason: "结构化目标" },
      { provider: "mouse", available: true, reason: "候选兜底" },
    ] }),
    execute: async (_action: unknown, resolution?: { selected: string }) => {
      calls.push(resolution!.selected);
      return { ok: false, message: "调用后连接中断", effect: "uncertain" as const, provider: "uia" };
    },
  };
  const click = { kind: "click" as const, target: { kind: "role" as const,
    role: "button", name: "目标" } };
  const result = await createAgentLoop({ model: new FakeModel([click, click]), runtime, trace })
    .invoke(initialState("action-uncertain", "点击目标", undefined,
      { pageTextIncludes: "已点击目标" }));
  assert.equal(result.status, "waiting_user");
  assert.deepEqual(calls, ["uia"]);
  assert.equal(trace.providerAttempts("action-uncertain")[0]?.effect, "uncertain");
  assert.match(result.error ?? "", /重复执行/);
}));

test("failed action recovers through new observation", withTrace(async (trace) => {
  const runtime = new FakeRuntime(new Set([1]));
  const model = new FakeModel([
    { kind: "navigate", url: "https://example.com" },
    { kind: "navigate", url: "https://example.com" },
    { kind: "done", summary: "retried" },
  ]);
  const result = await createAgentLoop({ model, runtime, trace }).invoke(initialState("task-2", "open example",
    undefined, { urlIncludes: "https://example.com" }));
  assert.equal(result.status, "done");
  assert.equal(runtime.executed.length, 2);
  assert.ok(trace.events("task-2").some((event) => event.node === "recover"));
  assert.deepEqual(result.recentHistory?.map((item) => [item.step, item.result?.ok]),
    [[1, false], [2, true]]);
}));

test("risky click stops before execution", withTrace(async (trace) => {
  const runtime = new FakeRuntime();
  const model = new FakeModel([{ kind: "click", target: { kind: "role", role: "button", name: "Pay now" } }]);
  const result = await createAgentLoop({ model, runtime, trace }).invoke(initialState("task-3", "pay"));
  assert.equal(result.status, "waiting_user");
  assert.equal(runtime.executed.length, 0);
}));

test("模型提前宣布完成时必须先通过独立页面条件", withTrace(async (trace) => {
  const runtime = new FakeRuntime();
  const model = new FakeModel([
    { kind: "done", summary: "提前宣布完成" },
    { kind: "navigate", url: "https://example.com" },
    { kind: "done", summary: "已打开页面" },
  ]);
  const result = await createAgentLoop({ model, runtime, trace }).invoke(initialState("verify-goal", "打开示例页",
    undefined, { urlIncludes: "https://example.com" }));
  assert.equal(result.status, "done");
  assert.equal(result.summary, "已打开页面");
  const checks = trace.events("verify-goal").filter((event) => event.node === "verify_task");
  assert.deepEqual(checks.map((event) => event.state.goalVerification?.ok), [false, true]);
  assert.equal(runtime.executed.length, 1);
}));

test("没有独立完成条件时不能接受 done", withTrace(async (trace) => {
  const model = new FakeModel([
    { kind: "done", summary: "自称完成" },
    { kind: "done", summary: "再次自称完成" },
  ]);
  const result = await createAgentLoop({ model, runtime: new FakeRuntime(), trace, maxRetries: 1 })
    .invoke(initialState("no-criteria", "未知目标"));
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /未配置独立的任务完成条件/);
}));

test("点击无响应后重新观察，重复点击在再次执行前暂停", withTrace(async (trace) => {
  const runtime = new FakeRuntime();
  const action = { kind: "click" as const, target: { kind: "text" as const, text: "继续" } };
  const model = new FakeModel([action, action]);
  const result = await createAgentLoop({ model, runtime, trace }).invoke(initialState("no-effect", "点击继续"));
  assert.equal(result.status, "waiting_user");
  assert.equal(runtime.executed.length, 1);
  assert.match(result.error ?? "", /重复执行/);
  const nodes = trace.events("no-effect").map((event) => event.node);
  assert.equal(trace.events("no-effect").find((event) => event.node === "verify")?.state.lastVerification?.ok, false);
  assert.ok(nodes.indexOf("execute") < nodes.indexOf("observe", nodes.indexOf("execute") + 1));
  assert.ok(nodes.indexOf("observe", nodes.indexOf("execute") + 1) < nodes.indexOf("verify"));
}));

test("返回后再次进入同一只读页面不触发重复点击审批", withTrace(async (trace) => {
  let page = "酒馆战棋\n完整数据";
  const runtime = {
    executed: [] as string[],
    async observe() { return { pageText: page, dom: "<main>炉石传说</main>",
      textEvidence: [{ source: "uia" as const, text: page }] }; },
    async execute(action: { kind: string; target?: { kind: string; text?: string } }) {
      const label = action.target?.text ?? action.kind;
      this.executed.push(label);
      page = label === "返回" ? "酒馆战棋\n完整数据"
        : "单人完整数据\n978\n四强玩家\n302\n夺冠次数";
      return { ok: true, message: "已点击" };
    },
  };
  const full = { kind: "click" as const, target: { kind: "text" as const, text: "完整数据" } };
  const back = { kind: "click" as const, target: { kind: "text" as const, text: "返回" } };
  const model = new FakeModel([full, back, full, { kind: "done", summary: "已查看战绩" }]);
  const result = await createAgentLoop({ model, runtime, trace }).invoke(initialState(
    "view-stats-again", "查看酒馆战棋战绩", undefined,
    { pageTextIncludes: "完整数据", pageTextNumberLabels: ["四强玩家", "夺冠次数"] }));
  assert.equal(result.status, "done");
  assert.deepEqual(runtime.executed, ["完整数据", "返回", "完整数据"]);
}));

test("连续失败达到重试上限后结束", withTrace(async (trace) => {
  const runtime = new FakeRuntime(new Set([1, 2]));
  const model = new FakeModel([
    { kind: "navigate", url: "https://example.com" },
    { kind: "navigate", url: "https://example.com" },
  ]);
  const result = await createAgentLoop({ model, runtime, trace, maxRetries: 1 })
    .invoke(initialState("retry-limit", "打开示例页", undefined,
      { urlIncludes: "https://example.com" }));
  assert.equal(result.status, "failed");
  assert.equal(runtime.executed.length, 2);
  assert.equal(trace.events("retry-limit").filter((event) => event.node === "verify").length, 2);
}));

test("SQLite task state survives closing and reopening the store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-"));
  const path = join(dir, "trace.sqlite");
  try {
    const first = new SqliteTrace(path);
    first.save("observe", initialState("persisted", "keep this task"));
    first.close();
    const second = new SqliteTrace(path);
    try {
      assert.equal(second.load("persisted")?.goal, "keep this task");
      assert.equal(second.events("persisted").length, 1);
    } finally { second.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
