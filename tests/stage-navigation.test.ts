import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createAgentLoop } from "../src/graph/graph.js";
import { continuePausedTask, resumeSavedTask } from "../src/graph/resume.js";
import { initialState, type ComputerState } from "../src/graph/state.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";
import { mercenariesGameWindow, mercenariesTarget } from "../src/extensions/hearthstone/hearthstone-extension.js";
import type { ModelAdapter } from "../src/agent/model-adapter.js";
import type { ComputerAction } from "../src/actions/schema.js";
import { StageWorkflowModel } from "../src/agent/stage-workflow-model.js";
import { WorkflowStore } from "../src/workflows/store.js";
import { distillWorkflow } from "../src/workflows/distill.js";

function actionText(action: ComputerAction): string {
  return (action.kind === "click" && action.target.kind === "text") ? action.target.text : "";
}

class StageModel implements ModelAdapter {
  readonly name = "阶段测试模型";
  readonly kind = "model" as const;
  constructor(private readonly visual = false,
    private readonly onDecide?: () => void) {}
  async planStage(state: Readonly<ComputerState>) {
    const final = (state.completedStages?.length ?? 0) > 0;
    return { goal: final ? "进入第一关" : "进入佣兵之书",
      successCondition: final ? "第一关" : "佣兵之书", isFinal: final };
  }
  async verifyStage(stage: NonNullable<ComputerState["stage"]>,
    observation: NonNullable<ComputerState["observation"]>) {
    const ok = observation.pageText?.includes(stage.successCondition) ?? false;
    return { ok, confidence: ok ? 0.95 : 0.1,
      evidence: ok ? stage.successCondition : "尚未进入目标界面",
      source: this.visual ? "visual_model" as const : "uia" as const };
  }
  async reconcileStage(state: Readonly<ComputerState>) {
    return { decision: state.observation?.pageText?.includes("第一关")
      ? "skip" as const : "replan" as const, evidence: state.observation?.pageText ?? "无画面" };
  }
  async decide(state: Readonly<ComputerState>) {
    this.onDecide?.();
    return { kind: "click" as const, target: { kind: "text" as const,
      text: state.stage?.goal ?? "目标" } };
  }
}

function state(taskId: string): ComputerState {
  return { ...initialState(taskId, "进入炉石传说佣兵之书第一关", undefined,
    { pageTextIncludes: "第一关" }),
    taskContract: { target: "第一关", stageActionLimit: 24, taskActionLimit: 80,
      constraint: "只导航至指定关卡" },
    completedStages: [], stagePlanVersion: 0 };
}

test("阶段验收模型超时保留现场，继续时不重放已执行动作", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-stage-timeout-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  const checkpointer = SqliteSaver.fromConnString(join(dir, "checkpoints.sqlite"));
  let page = "起点";
  let executions = 0;
  let checks = 0;
  const model: ModelAdapter = {
    name: "超时测试模型", kind: "model",
    async planStage() { return { goal: "到达终点", successCondition: "终点", isFinal: true }; },
    async decide() { return { kind: "click" as const, target: { kind: "text" as const, text: "终点" } }; },
    async verifyStage() {
      checks++;
      if (page === "终点" && checks === 2) throw Object.assign(new Error("The operation was aborted due to timeout"),
        { name: "TimeoutError" });
      return { ok: page === "终点", confidence: 1, evidence: page, source: "uia" as const };
    },
  };
  const runtime = {
    async observe() { return { pageText: page, accessibility: page }; },
    async execute() { executions++; page = "终点"; return { ok: true, message: "已点击" }; },
  };
  try {
    const graph = createAgentLoop({ model, runtime, trace, checkpointer, maxSteps: 10 });
    const input = { ...state("stage-timeout"), goal: "到达终点",
      completionCriteria: { pageTextIncludes: "终点" } };
    const first = await graph.invoke(input, { configurable: { thread_id: "stage-timeout" } });
    assert.equal(first.status, "paused");
    assert.equal(first.recoveryRequired, true);
    assert.equal(executions, 1);
    assert.ok(trace.events("stage-timeout").some(event => event.node === "stage_check_timeout"));
    const resumed = await continuePausedTask(graph, "stage-timeout", "stage-timeout", runtime);
    assert.equal(resumed.status, "waiting_user");
    assert.equal(executions, 1);
  } finally {
    trace.close();
    checkpointer.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("冻结的最终结果契约在保存前保持 UNKNOWN，保存后直接验收且不调用截图阶段模型", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-final-result-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  let page = "记录旧值";
  const actions: string[] = [];
  let stageVisualCalls = 0;
  let stageAcceptanceCalls = 0;
  const goal = "修改记录并保存新值";
  const criteria = { pageTextIncludes: "已保存新值" };
  const model: ModelAdapter = {
    name: "结果契约测试模型", kind: "model",
    async planStage() { return { goal, successCondition: "已保存新值", isFinal: true }; },
    async verifyStage() { stageVisualCalls++; throw new Error("截图不能证明持久化结果"); },
    async decide() { return { kind: "click" as const, target: { kind: "text" as const,
      text: actions.length ? "保存" : "编辑" } }; },
  };
  const runtime = {
    async observe() { return { pageText: page, accessibility: page }; },
    async execute(action: ComputerAction) {
      actions.push(actionText(action));
      page = actions.length === 1 ? "编辑中：新值" : "已保存新值";
      return { ok: true, message: "已点击" };
    },
  };
  try {
    const input = { ...initialState("final-result", goal, undefined, criteria),
      verificationContract: { goal, successConditions: criteria,
        evidenceSources: { pageTextIncludes: "uia" as const }, verifierStrategy: "rules_then_jev" as const },
      taskContract: { target: goal, constraint: "仅修改指定记录", stageActionLimit: 6,
        taskActionLimit: 8 } };
    const result = await createAgentLoop({ model, runtime, trace, maxSteps: 8,
      acceptanceVerifier: { async evaluate(_goal, _criteria, observation, scope) {
        if (scope === "stage") stageAcceptanceCalls++;
        const pass = observation?.pageText === "已保存新值";
        return { mode: "assist" as const, verdict: pass ? "pass" as const : "unknown" as const,
          observationId: observation?.pageText ?? "", checks: [{ criterion: "saved-result",
            verdict: pass ? "pass" as const : "unknown" as const, message: pass ? "当前结果" : "尚未保存" }],
          message: pass ? "当前结果已验收" : "尚未保存" };
      } } }).invoke(input);
    assert.equal(result.status, "done", result.error ?? "");
    assert.deepEqual(actions, ["编辑", "保存"]);
    assert.equal(stageVisualCalls, 0);
    assert.equal(stageAcceptanceCalls, 0);
    assert.equal(result.acceptanceReport?.verdict, "pass");
  } finally { trace.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("冻结的最终结果仍为 UNKNOWN 时，done 不会跳过验收或执行副作用", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-final-unknown-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  let executions = 0;
  const goal = "保存记录";
  const criteria = { pageTextIncludes: "已保存" };
  try {
    const result = await createAgentLoop({ model: {
      name: "未完成测试模型", kind: "model",
      async planStage() { return { goal, successCondition: "已保存", isFinal: true }; },
      async verifyStage() { throw new Error("不应调用截图阶段模型"); },
      async decide() { return { kind: "done" as const, summary: "声称完成" }; },
    }, runtime: {
      async observe() { return { pageText: "编辑中" }; },
      async execute() { executions++; throw new Error("不应执行动作"); },
    }, trace, maxSteps: 3, acceptanceVerifier: { async evaluate() {
      return { mode: "assist" as const, verdict: "unknown" as const, observationId: "editing",
        checks: [], reason: "evidence_unavailable" as const, message: "缺少持久化结果" };
    } } }).invoke({ ...initialState("final-unknown", goal, undefined, criteria),
      verificationContract: { goal, successConditions: criteria,
        evidenceSources: { pageTextIncludes: "uia" as const }, verifierStrategy: "rules_then_jev" as const },
      taskContract: { target: goal, constraint: "仅当前记录", stageActionLimit: 3, taskActionLimit: 3 } });
    assert.equal(result.status, "waiting_user");
    assert.equal(result.acceptanceReport?.verdict, "unknown");
    assert.equal(executions, 0);
  } finally { trace.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("中间阶段的 JEV UNKNOWN 不把已到达页面的 done 当作最终任务失败", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-intermediate-stage-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  const checkpointer = SqliteSaver.fromConnString(join(dir, "checkpoints.sqlite"));
  let url = "http://local/blank";
  let checks = 0;
  let decisions = 0;
  let executions = 0;
  try {
    const result = await createAgentLoop({ model: {
      name: "中间阶段模型", kind: "model",
      async planStage() { return { goal: "打开表单", successCondition: "表单可交互", isFinal: false }; },
      async verifyStage() { checks++; return { ok: checks === 3, confidence: 1,
        evidence: checks === 3 ? "表单已可交互" : "仍在加载", source: "uia" as const }; },
      async decide() { decisions++; return decisions === 1
        ? { kind: "navigate" as const, url: "http://local/form" }
        : { kind: "done" as const, summary: "表单已打开" }; },
    }, runtime: {
      async observe() { return { url, pageText: url.endsWith("form") ? "表单已打开" : "空白页" }; },
      async execute() { executions++; url = "http://local/form"; return { ok: true, message: "已打开" }; },
    }, trace, checkpointer, maxSteps: 5,
      acceptanceVerifier: { async evaluate() { return { mode: "assist" as const,
        verdict: "unknown" as const, observationId: url, checks: [],
        reason: "evidence_unavailable" as const, message: "JEV 无法从阶段描述确认" }; } },
      onStageCompleted: async () => { trace.requestPause("intermediate-stage"); },
      pauseRequested: (id) => trace.pauseRequested(id),
    }).invoke({ ...initialState("intermediate-stage", "打开表单后提交"),
      taskContract: { target: "提交表单", constraint: "仅当前表单", stageActionLimit: 5,
        taskActionLimit: 6 } }, { configurable: { thread_id: "intermediate-stage" } });
    assert.equal(result.status, "paused");
    assert.equal(result.completedStages?.length, 1);
    assert.equal(result.completedStages?.[0]?.goal, "打开表单");
    assert.equal(executions, 1);
    assert.equal(checks, 3);
  } finally { trace.close(); checkpointer.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("中间阶段 done 后画面仍不满足条件时安全停下", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-intermediate-unknown-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  let executions = 0;
  try {
    const result = await createAgentLoop({ model: {
      name: "中间阶段未达成模型", kind: "model",
      async planStage() { return { goal: "打开表单", successCondition: "表单可交互", isFinal: false }; },
      async verifyStage() { return { ok: false, confidence: 1, evidence: "仍是空白页", source: "uia" as const }; },
      async decide() { return { kind: "done" as const, summary: "声称已打开" }; },
    }, runtime: {
      async observe() { return { pageText: "空白页" }; },
      async execute() { executions++; throw new Error("不应执行动作"); },
    }, trace, maxSteps: 3,
      acceptanceVerifier: { async evaluate() { return { mode: "assist" as const,
        verdict: "unknown" as const, observationId: "blank", checks: [],
        reason: "evidence_unavailable" as const, message: "中间阶段证据不足" }; } },
    }).invoke({ ...initialState("intermediate-unknown", "打开表单后提交"),
      taskContract: { target: "提交表单", constraint: "仅当前表单", stageActionLimit: 3,
        taskActionLimit: 3 } });
    assert.equal(result.status, "waiting_user");
    assert.equal(result.completedStages?.length ?? 0, 0);
    assert.equal(executions, 0);
  } finally { trace.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("未知画面逐段规划，阶段验收后进入指定关卡", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-stages-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  let page = "主界面";
  const actions: string[] = [];
  const runtime = {
    async observe() { return { pageText: page, accessibility: page }; },
    async execute(action: ComputerAction) {
      actions.push(actionText(action));
      page = actions.length === 1 ? "佣兵之书" : "第一关";
      return { ok: true, message: "已点击" };
    },
  };
  try {
    const result = await createAgentLoop({ model: new StageModel(), runtime, trace, maxSteps: 80 })
      .invoke(state("stage-1"));
    assert.equal(result.status, "done");
    assert.deepEqual(result.completedStages?.map((item) => item.goal),
      ["进入佣兵之书", "进入第一关"]);
    assert.equal(result.stagePlanVersion, 2);
    assert.equal(actions.length, 2);
    assert.ok(trace.events("stage-1").filter((item) => item.node === "stage_completed").length === 2);
  } finally { trace.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("执行前请求暂停，继续后重新观察并跳过人工已完成的阶段", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-stage-pause-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  let page = "主界面";
  let executions = 0;
  const runtime = {
    async observe() { return { pageText: page, accessibility: page }; },
    async execute(action: ComputerAction) {
      executions++;
      page = actionText(action) === "进入第一关" ? "第一关" : "佣兵之书";
      return { ok: true, message: "已点击" };
    },
  };
  const checkpointPath = join(dir, "checkpoints.sqlite");
  const first = SqliteSaver.fromConnString(checkpointPath);
  try {
    const graph = createAgentLoop({ model: new StageModel(false, () => trace.requestPause("pause-1")),
      runtime, trace, checkpointer: first, maxSteps: 80,
      pauseRequested: (id) => trace.pauseRequested(id) });
    await graph.invoke(state("pause-1"), { configurable: { thread_id: "pause-1" } });
    assert.equal(trace.load("pause-1")?.status, "paused");
    assert.equal(executions, 0);
  } finally { first.db.close(); }
  page = "佣兵之书";
  trace.clearPause("pause-1");
  const second = SqliteSaver.fromConnString(checkpointPath);
  try {
    const graph = createAgentLoop({ model: new StageModel(), runtime, trace,
      checkpointer: second, maxSteps: 80,
      pauseRequested: (id) => trace.pauseRequested(id) });
    const result = await continuePausedTask(graph, "pause-1");
    assert.equal(result.completedStages?.[0]?.goal, "进入佣兵之书");
    assert.equal(executions, 1);
    assert.equal(result.status, "done");
  } finally { second.db.close(); trace.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("最终关卡只有截图判断时先等待人工确认", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-stage-review-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  const checkpoint = SqliteSaver.fromConnString(join(dir, "checkpoints.sqlite"));
  const runtime = { async observe() { return { pageText: "第一关" }; },
    async restore() {}, async execute() { throw new Error("无需执行动作"); } };
  const initial = state("review-1");
  initial.completedStages = [{ id: "old", goal: "进入佣兵之书", successCondition: "佣兵之书",
    startStep: 0, endStep: 1, evidence: "佣兵之书", source: "uia" }];
  try {
    const graph = createAgentLoop({ model: new StageModel(true), runtime, trace,
      checkpointer: checkpoint, maxSteps: 80 });
    await graph.invoke(initial, { configurable: { thread_id: "review-1" } });
    assert.equal(trace.load("review-1")?.status, "waiting_user");
    const result = await resumeSavedTask(graph, runtime, "review-1", { approved: true });
    assert.equal(result.status, "done");
    assert.equal(result.goalVerification?.evidence?.[0]?.strength, "weak");
    assert.equal(result.goalVerification?.ok, false);
    assert.equal(result.humanReview?.approved, true);
  } finally { checkpoint.db.close(); trace.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("动作执行中请求暂停，先完成动作与验证，再安全停下", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-stage-atomic-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  const checkpoint = SqliteSaver.fromConnString(join(dir, "checkpoints.sqlite"));
  let page = "主界面";
  let executions = 0;
  const runtime = { async observe() { return { pageText: page, accessibility: page }; },
    async execute(action: ComputerAction) {
      executions++;
      page = actionText(action) === "进入佣兵之书" ? "佣兵之书" : "第一关";
      if (executions === 1) trace.requestPause("atomic-1");
      return { ok: true, message: "已完成原子点击" };
    } };
  try {
    const graph = createAgentLoop({ model: new StageModel(), runtime, trace,
      checkpointer: checkpoint, maxSteps: 80,
      pauseRequested: (id) => trace.pauseRequested(id) });
    await graph.invoke(state("atomic-1"), { configurable: { thread_id: "atomic-1" } });
    assert.equal(trace.load("atomic-1")?.status, "paused");
    assert.equal(executions, 1);
    assert.equal(trace.events("atomic-1").filter((item) => item.node === "verify").length, 1);
    trace.clearPause("atomic-1");
    const result = await continuePausedTask(graph, "atomic-1");
    assert.equal(result.status, "done");
    assert.equal(executions, 2);
  } finally { checkpoint.db.close(); trace.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("暂停时人工直接进入关卡，恢复后跳过旧阶段且不学习人工动作", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-stage-manual-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  const path = join(dir, "checkpoints.sqlite");
  let page = "主界面";
  let executions = 0;
  const runtime = { async observe() { return { pageText: page, accessibility: page }; },
    async execute() { executions++; return { ok: true, message: "已点击" }; } };
  const first = SqliteSaver.fromConnString(path);
  try {
    await createAgentLoop({ model: new StageModel(false, () => trace.requestPause("manual-1")),
      runtime, trace, checkpointer: first, maxSteps: 80,
      pauseRequested: (id) => trace.pauseRequested(id) })
      .invoke(state("manual-1"), { configurable: { thread_id: "manual-1" } });
  } finally { first.db.close(); }
  page = "第一关";
  trace.clearPause("manual-1");
  const second = SqliteSaver.fromConnString(path);
  let learned = 0;
  try {
    const graph = createAgentLoop({ model: new StageModel(), runtime, trace,
      checkpointer: second, maxSteps: 80, pauseRequested: (id) => trace.pauseRequested(id),
      onStageCompleted: async (_current, stage) => { if (stage.endStep > stage.startStep) learned++; } });
    const result = await continuePausedTask(graph, "manual-1");
    assert.equal(result.status, "done");
    assert.equal(result.completedStages?.[0]?.source, "manual");
    assert.equal(executions, 0);
    assert.equal(learned, 0);
  } finally { second.db.close(); trace.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("暂停后画面偏离当前阶段时重新规划，不重发旧动作", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-stage-replan-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  const path = join(dir, "checkpoints.sqlite");
  let page = "主界面";
  const actions: string[] = [];
  const runtime = { async observe() { return { pageText: page, accessibility: page }; },
    async execute(action: ComputerAction) {
      actions.push(actionText(action));
      page = actions.length === 1 ? "佣兵之书" : "第一关";
      return { ok: true, message: "已点击" };
    } };
  const first = SqliteSaver.fromConnString(path);
  try {
    await createAgentLoop({ model: new StageModel(false, () => trace.requestPause("replan-1")),
      runtime, trace, checkpointer: first, maxSteps: 80,
      pauseRequested: (id) => trace.pauseRequested(id) })
      .invoke(state("replan-1"), { configurable: { thread_id: "replan-1" } });
    assert.equal(actions.length, 0);
  } finally { first.db.close(); }
  page = "意外的登录界面";
  trace.clearPause("replan-1");
  const second = SqliteSaver.fromConnString(path);
  try {
    const graph = createAgentLoop({ model: new StageModel(), runtime, trace,
      checkpointer: second, maxSteps: 80,
      pauseRequested: (id) => trace.pauseRequested(id) });
    const result = await continuePausedTask(graph, "replan-1");
    assert.equal(result.status, "done");
    assert.equal(result.stagePlanVersion, 3);
    assert.equal(actions.length, 2);
    assert.ok(trace.events("replan-1").some((item) => item.node === "stage_reconciled"));
  } finally { second.db.close(); trace.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("佣兵之书页面可作为终点，游玩关卡仍须明确目标", () => {
  assert.equal(mercenariesTarget("游玩炉石传说冒险模式的佣兵之书"), undefined);
  assert.equal(mercenariesTarget("进入炉石传说佣兵之书第一关"), "第一关");
  assert.equal(mercenariesTarget("进入炉石传说佣兵之书"), "佣兵之书");
});

test("佣兵之书导航只绑定已打开的游戏窗口，不把战网当作起点", () => {
  const base = { processId: 1, processPath: null, targetElevated: false,
    visible: true, minimized: false, foreground: false,
    rect: { left: 0, top: 0, width: 100, height: 100 } };
  const launcher = { ...base, handle: 1, title: "战网", windowClass: "Chrome_WidgetWin_1" };
  const game = { ...base, handle: 2, title: "炉石传说", windowClass: "UnityWndClass" };
  assert.throws(() => mercenariesGameWindow([launcher]), /先打开《炉石传说》游戏窗口/);
  assert.equal(mercenariesGameWindow([launcher, game]).handle, 2);
});

test("阶段首次探索产生候选，第二次按语义回放后升级为已验证", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-stage-learning-"));
  const tracePath = join(dir, "trace.sqlite");
  const trace = new SqliteTrace(tracePath);
  const store = new WorkflowStore(join(dir, "workflows.sqlite"));
  let decisions = 0;
  const run = async (taskId: string) => {
    let page = "主界面";
    const runtime = { async observe() { return { pageText: page, accessibility: page,
      windowTitle: "炉石传说" }; },
      async execute(action: ComputerAction) {
        page = actionText(action) === "进入佣兵之书" ? "佣兵之书" : "第一关";
        return { ok: true, message: "已点击" };
      } };
    const model = new StageWorkflowModel(new StageModel(false, () => { decisions++; }), store);
    return createAgentLoop({ model, runtime, trace, maxSteps: 80,
      onStageCompleted: async (current, stage) => {
        if (current.workflowRef?.stageId === stage.id &&
            current.workflowReplayState?.exploring === false) {
          store.recordReplay(current.workflowRef.id, current.workflowRef.version, taskId, true);
        } else {
          const workflow = distillWorkflow(trace, taskId, tracePath, "windows", {
            goal: stage.goal, successCondition: stage.successCondition,
            startStep: stage.startStep, endStep: stage.endStep });
          if (workflow) store.addCandidate(workflow);
        }
      } }).invoke(state(taskId));
  };
  try {
    const firstResult = await run("learn-first");
    assert.equal(firstResult.status, "done", firstResult.error ?? "");
    assert.equal(store.list("windows").filter((item) => item.scope === "stage").length, 2);
    assert.ok(store.list("windows").every((item) => item.status === "candidate"));
    const before = decisions;
    const secondResult = await run("learn-second");
    assert.equal(secondResult.status, "done", `${secondResult.error}; ${JSON.stringify(trace.events("learn-second")
      .filter((item) => ["decide", "stage_plan", "stage_completed", "risk_check"].includes(item.node))
      .map((item) => ({ node: item.node, step: item.step, action: item.state.lastAction,
        stage: item.state.stage?.goal, error: item.state.error })))}`);
    assert.equal(decisions, before);
    assert.ok(store.list("windows").every((item) => item.status === "verified"));

    let page = "主界面";
    let executions = 0;
    let requestPause = true;
    const runtime = { async observe() { return { pageText: page, accessibility: page,
      windowTitle: "炉石传说" }; },
      async resolveAction() {
        if (requestPause) { trace.requestPause("learn-paused"); requestPause = false; }
        return { selected: "test", reason: "测试执行器",
          candidates: [{ provider: "test", available: true, reason: "可用" }] };
      },
      async execute(action: ComputerAction) {
        executions++;
        page = actionText(action) === "进入佣兵之书" ? "佣兵之书" : "第一关";
        return { ok: true, message: "已点击" };
      } };
    const checkpointPath = join(dir, "paused-checkpoints.sqlite");
    const checkpoint1 = SqliteSaver.fromConnString(checkpointPath);
    try {
      await createAgentLoop({ model: new StageWorkflowModel(new StageModel(false, () => { decisions++; }), store),
        runtime, trace, checkpointer: checkpoint1, maxSteps: 80,
        pauseRequested: (id) => trace.pauseRequested(id) })
        .invoke(state("learn-paused"), { configurable: { thread_id: "learn-paused" } });
      assert.equal(trace.load("learn-paused")?.status, "paused");
      assert.equal(executions, 0);
    } finally { checkpoint1.db.close(); }
    trace.clearPause("learn-paused");
    const checkpoint2 = SqliteSaver.fromConnString(checkpointPath);
    try {
      const graph = createAgentLoop({ model: new StageWorkflowModel(new StageModel(false,
        () => { decisions++; }), store), runtime, trace, checkpointer: checkpoint2,
        maxSteps: 80, pauseRequested: (id) => trace.pauseRequested(id) });
      const result = await continuePausedTask(graph, "learn-paused");
      assert.equal(result.status, "done", result.error ?? "");
      assert.equal(executions, 2);
      assert.equal(decisions, before);
    } finally { checkpoint2.db.close(); }
  } finally { store.close(); trace.close(); rmSync(dir, { recursive: true, force: true }); }
});


test("视觉阶段成功不能覆盖总目标条件冲突，也不能生成成功候选", async () => {
  const dir = mkdtempSync(join(tmpdir(), "generic-final-conflict-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  let learned = 0;
  const model: ModelAdapter = {
    name: 'conflicting-verifier', kind: 'model',
    async planStage() { return { goal: '结果已展示', successCondition: '结果', isFinal: true }; },
    async verifyStage() { return { ok: true, confidence: 1, evidence: '结果可见', source: 'visual_model' }; },
    async decide() { return { kind: 'click', target: { kind: 'text', text: '继续' } }; },
  };
  const runtime = { async observe() { return { pageText: '结果 B 继续', windowTitle: '结果 B' }; },
    async execute() { return { ok: true, message: '已执行' }; } };
  try {
    const initial = { ...initialState('conflict', '确认结果 A', undefined, { windowTitleIncludes: '结果 A' }),
      taskContract: { target: '确认结果 A', constraint: '不更改要求', stageActionLimit: 2, taskActionLimit: 2 } };
    const result = await createAgentLoop({ model, runtime, trace, maxSteps: 2,
      onStageCompleted: async () => { learned++; } }).invoke(initial);
    assert.notEqual(result.status, 'done');
    assert.notEqual(result.goalVerification?.ok, true);
    assert.notEqual(result.finalReviewPending, true);
    assert.equal(learned, 0);
    assert.ok(trace.events('conflict').some(event => event.node === 'stage_check' && JSON.stringify(event).includes('总目标尚未验收')));
  } finally { trace.close(); rmSync(dir, { recursive: true, force: true }); }
});
