import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputerAction } from "../src/actions/schema.js";
import type { ModelAdapter } from "../src/agent/model-adapter.js";
import { createAgentLoop } from "../src/graph/graph.js";
import { initialState } from "../src/graph/state.js";
import { PlaywrightRuntime } from "../src/runtime/browser/playwright-runtime.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";
import { workflowDigest } from "../src/workflows/recovery.js";
import { prepareWorkflowExecution, routeWorkflowDestination, stageReplaySucceeded } from "../src/workflows/execution.js";
import { WorkflowReplayModel } from "../src/workflows/replay-model.js";
import type { Workflow } from "../src/workflows/schema.js";
import type { ComputerState } from "../src/graph/state.js";

function windowsWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return { id: "wfw", version: 1, workflowSchemaVersion: 2, status: "verified",
    environment: "windows", taskPattern: "输入 {{value}}",
    inputs: [{ name: "value", example: "A", kind: "text", boundTo: { stepId: "s1", argument: "text" } }],
    preconditions: [], steps: [
      { stepId: "s1", goal: "输入 {{value}}",
        action: { kind: "type", target: { kind: "role", role: "Edit", name: "input" }, text: "{{value}}" },
        preferredMethods: [], successCondition: { kind: "state_changed" } },
    ], successConditions: { pageTextIncludes: "{{value}}" }, knownFailures: [],
    sourceTaskId: "seed", sourceTrace: "seed", createdAt: "", successCount: 1, failureCount: 0,
    ...overrides,
  };
}

function browserWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return { id: "bfw", version: 1, workflowSchemaVersion: 2, status: "verified",
    environment: "browser", taskPattern: "搜索 {{q}}",
    inputs: [{ name: "q", example: "test", kind: "text", boundTo: { stepId: "s1", argument: "text" } }],
    preconditions: [], steps: [
      { stepId: "s1", goal: "输入 {{q}}",
        action: { kind: "type", target: { kind: "label", label: "搜索" }, text: "{{q}}" },
        preferredMethods: [], successCondition: { kind: "state_changed" } },
      { stepId: "s2", goal: "提交查询",
        action: { kind: "keypress", keys: "Enter" }, preferredMethods: [],
        successCondition: { kind: "url_includes", value: "/results" } },
    ], successConditions: { urlIncludes: "/results" }, knownFailures: [],
    sourceTaskId: "seed", sourceTrace: "seed", createdAt: "", successCount: 1, failureCount: 0,
    ...overrides,
  };
}

test("routeWorkflowDestination：仅接受 windows/browser，其余拒绝", () => {
  assert.equal(routeWorkflowDestination(windowsWorkflow()), "windows");
  assert.equal(routeWorkflowDestination(browserWorkflow()), "browser");
  assert.throws(() => routeWorkflowDestination(
    { ...browserWorkflow(), environment: "ios" as never }), /不受支持/);
});

test("prepareWorkflowExecution：destination 必须与 workflow.environment 一致", () => {
  const win = windowsWorkflow();
  const brw = browserWorkflow();
  const winReq = { id: win.id, version: win.version, definitionHash: workflowDigest(win),
    values: { value: "A" }, destination: "windows" as const };
  const brwReq = { id: brw.id, version: brw.version, definitionHash: workflowDigest(brw),
    values: { q: "test" }, destination: "browser" as const };
  assert.equal(prepareWorkflowExecution(win, winReq).workflow.environment, "windows");
  assert.equal(prepareWorkflowExecution(brw, brwReq).workflow.environment, "browser");
  assert.throws(() => prepareWorkflowExecution(brw, { ...brwReq, destination: "windows" }),
    /不匹配，已在第一步动作前拒绝/);
  assert.throws(() => prepareWorkflowExecution(win, { ...winReq, destination: "browser" }),
    /不匹配，已在第一步动作前拒绝/);
  assert.throws(() => prepareWorkflowExecution(win, { ...winReq, destination: "host" as never }),
    /目标环境无效/);
});

test("candidate browser 流程：trial 放行，非 trial 拒绝", () => {
  const brw = { ...browserWorkflow(), status: "candidate" as const };
  const req = { id: brw.id, version: brw.version, definitionHash: workflowDigest(brw),
    values: { q: "test" }, destination: "browser" as const };
  assert.throws(() => prepareWorkflowExecution(brw, req), /试运行/);
  assert.equal(prepareWorkflowExecution(brw, { ...req, trial: true }).ref.trial, true);
});

test("部分 replay 不算成功：nextIndex 未达 steps.length 时 stageReplaySucceeded 为 false", () => {
  const workflow = windowsWorkflow();
  const base: ComputerState = { taskId: "t", goal: "g", plan: [], completionCriteria: {},
    executedImpactActions: [], recentHistory: [], step: 2, retryCount: 0, status: "running",
    lastStageVerification: { ok: true, confidence: 1, evidence: "x", source: "uia" },
    workflowRef: { id: workflow.id, version: workflow.version,
      values: { value: "A" }, definitionHash: "h", explicit: true },
    workflowReplayState: { nextIndex: 0, exploring: false },
    lastResult: { ok: true, message: "ok" }, lastVerification: { ok: true, message: "ok" },
    beforeObservation: {}, observation: {} };
  // nextIndex(0) < steps.length(1)：步骤未走完，不得判为成功
  assert.equal(stageReplaySucceeded(base, { ...workflow, scope: "stage" }), false,
    "探索中或未到终点不算完成");
  const done = { ...base, workflowReplayState: { nextIndex: 1, exploring: false } };
  // steps.length === 1 且 nextIndex === 1 → 全步完成；此处用长度 1 流程验证终点语义
  assert.equal(stageReplaySucceeded(done, { ...workflow, scope: "stage" }), true);
});

test("browser route 离线完整 replay 走通（本地 server + PlaywrightRuntime）", async () => {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/") {
      response.end('<form action="/results"><label for="q">搜索</label><input id="q" name="q"><button>查询</button></form>');
    } else {
      response.end(`<main>搜索结果：${url.searchParams.get("q")}</main>`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const base = `http://127.0.0.1:${address.port}`;
  const dir = mkdtempSync(join(tmpdir(), "computer-use-router-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  let runtime: PlaywrightRuntime | undefined;
  try {
    runtime = await PlaywrightRuntime.launch({ artifactDir: join(dir, "screenshots") });
    const workflow = browserWorkflow();
    const prepared = prepareWorkflowExecution(workflow, { id: workflow.id,
      version: workflow.version, definitionHash: workflowDigest(workflow),
      values: { q: "LangGraph" }, destination: "browser" });
    // 导航到本地页：追加一个导航步骤（离线完整 replay 的前置）
    prepared.workflow.steps = [{ stepId: "s0", goal: `打开 ${base}`,
      action: { kind: "navigate", url: base }, preferredMethods: [],
      successCondition: { kind: "url_includes", value: `127.0.0.1:${address.port}` } },
      ...prepared.workflow.steps];
    const replay = new WorkflowReplayModel(prepared.workflow, new ScriptModel());
    const result = await createAgentLoop({ model: replay, runtime, trace, maxSteps: 12 })
      .invoke(initialState("router-replay", "搜索 LangGraph", undefined,
        prepared.workflow.successConditions));
    assert.equal(result.status, "done");
    assert.equal(replay.mode, "replay");
    assert.equal(replay.snapshotState().nextIndex, prepared.workflow.steps.length,
      "browser 流程必须完整回放全部步骤，部分 replay 不算成功");
    assert.equal(result.observation?.url?.includes("/results"), true);
    assert.match(result.observation?.pageText ?? "", /搜索结果：LangGraph/);
  } finally { server.close(); await runtime?.close(); trace.close(); rmSync(dir, { recursive: true, force: true }); }
});

class ScriptModel implements ModelAdapter {
  readonly kind = "model" as const;
  readonly name = "空回退模型";
  async decide(): Promise<ComputerAction> { throw new Error("replay 不应请求探索动作"); }
}