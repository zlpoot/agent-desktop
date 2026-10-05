import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseModelAction } from "../src/agent/chat-completions-model.js";
import type { ModelAdapter } from "../src/agent/model-adapter.js";
import { createAgentLoop } from "../src/graph/graph.js";
import { initialState } from "../src/graph/state.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";
import { verifyAction } from "../src/verifier/verifier.js";

test("指定区域滚动不能把时钟变化当成进展", () => {
  const action = parseModelAction(JSON.stringify({ kind: "scroll", direction: "down", amount: 300,
    target: { kind: "vision", description: "右侧冒险模式列表" } }));
  assert.equal(action.kind, "scroll");
  assert.equal(action.kind === "scroll" && action.target?.kind, "vision");
  assert.equal(verifyAction(action, { ok: true, message: "已滚动" },
    { pageText: "卡拉赞\n17:10" }, { pageText: "卡拉赞\n17:11" }).ok, false);
  assert.equal(verifyAction(action, { ok: true, message: "已滚动" },
    { pageText: "卡拉赞\n17:10" }, { pageText: "佣兵之书\n17:11" }).ok, true);
});

test("阶段连续三步未完成时诊断原因，并让普通决策执行新策略", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-diagnosis-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  let actions = 0;
  let diagnoses = 0;
  const model: ModelAdapter = {
    name: "诊断模型", kind: "model",
    async planStage() { return { goal: "找到目标入口", successCondition: "目标入口", isFinal: true }; },
    async verifyStage(_stage, observation) { return { ok: observation.pageText === "目标入口",
      confidence: 1, evidence: observation.pageText ?? "", source: "uia" }; },
    async diagnoseStage() { diagnoses++; return { decision: "continue" as const,
      reason: "原方法未到达目标", remedy: "改用可见的新入口" }; },
    async decide(state) { return { kind: "click", target: { kind: "text",
      text: state.diagnosis ? "新入口" : `旧入口${state.step}` } }; },
  };
  const runtime = {
    async observe() { return { pageText: actions === 4 ? "目标入口" : `页面 ${actions}` }; },
    async execute() { actions++; return { ok: true, message: "已点击" }; },
  };
  try {
    const state = { ...initialState("diagnosis-1", "找到目标入口"),
      taskContract: { target: "目标入口", stageActionLimit: 24,
        taskActionLimit: 80, constraint: "只导航" } };
    const result = await createAgentLoop({ model, runtime, trace, maxSteps: 80 }).invoke(state);
    assert.equal(result.status, "done");
    assert.equal(actions, 4);
    assert.equal(diagnoses, 1);
    assert.equal(trace.events("diagnosis-1").find((event) => event.node === "stage_diagnosis")
      ?.state.diagnosis?.remedy, "改用可见的新入口");
    assert.equal(trace.events("diagnosis-1").filter((event) => event.node === "decide").at(-1)
      ?.state.lastAction?.kind, "click");
  } finally { trace.close(); rmSync(dir, { recursive: true, force: true }); }
});
