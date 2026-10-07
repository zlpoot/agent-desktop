import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowStore } from "../src/workflows/store.js";
import { workflowDigest } from "../src/workflows/recovery.js";
import { prepareWorkflowExecution, explicitReplaySucceeded } from "../src/workflows/execution.js";
import { selectWorkflow } from "../src/workflows/matcher.js";
import type { ComputerState } from "../src/graph/state.js";
import type { Workflow } from "../src/workflows/schema.js";

/** 同一 Workflow 族的两个定义版本实例（op 不同 → pattern/inputs/步骤不同）。 */
function calcDefinition(op: "add" | "subtract"): Workflow {
  const stepText = op === "add" ? "加" : "减";
  const operatorButton = op === "add" ? "+" : "-";
  return { id: "calc-family", version: 1, workflowSchemaVersion: 2, status: "candidate",
    environment: "windows", taskPattern: `计算 {{lhs}} ${stepText} {{rhs}}`,
    inputs: [
      { name: "lhs", example: "37", kind: "number", boundTo: { stepId: "s1", argument: "value/text" } },
      { name: "op", example: op, kind: "choice", choices: ["add", "subtract"],
        boundTo: { stepId: "s2", argument: "choice" } },
      { name: "rhs", example: "58", kind: "number", boundTo: { stepId: "s3", argument: "value/text" } },
    ],
    preconditions: [], steps: [
      { stepId: "s1", goal: `输入 ${stepText} 的左操作数 {{lhs}}`,
        action: { kind: "type", target: { kind: "role", role: "Edit", name: "result" }, text: "{{lhs}}" },
        preferredMethods: [], successCondition: { kind: "state_changed" } },
      { stepId: "s2", goal: `选择 ${stepText} 运算符`,
        action: { kind: "click", target: { kind: "role", role: "button", name: operatorButton } },
        preferredMethods: [], successCondition: { kind: "state_changed" } },
      { stepId: "s3", goal: `输入右操作数 {{rhs}}`,
        action: { kind: "type", target: { kind: "role", role: "Edit", name: "result" }, text: "{{rhs}}" },
        preferredMethods: [], successCondition: { kind: "state_changed" } },
    ], successConditions: { pageTextIncludes: "95" }, knownFailures: [],
    sourceTaskId: "seed", sourceTrace: "seed", createdAt: "", successCount: 0, failureCount: 0 };
}

test("同族定义版本实例产生不同 definitionHash", () => {
  const add = calcDefinition("add");
  const sub = calcDefinition("subtract");
  assert.notEqual(workflowDigest(add), workflowDigest(sub));
  assert.equal(workflowDigest(add), workflowDigest(add), "同一定义 hash 稳定");
});

test("新 candidate 不自动继承旧 verified；同族多版本独立晋级", () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-ver-"));
  const store = new WorkflowStore(join(dir, "workflows.sqlite"));
  try {
    const addV1 = store.addCandidate(calcDefinition("add"));
    assert.equal(addV1.version, 1);
    assert.equal(store.recordReplay(addV1.id, 1, "t1", true).status, "verified");
    const subV2 = store.addCandidate(calcDefinition("subtract"));
    assert.equal(subV2.version, 2);
    assert.equal(subV2.status, "candidate", "新 candidate 不得继承旧 verified 状态");
    const oldAfter = store.get(addV1.id, 1);
    assert.equal(oldAfter?.status, "verified", "旧版本不受新 candidate 影响");
    // v2 经完整 replay 独立晋级
    assert.equal(store.recordReplay(subV2.id, 2, "t2", true).status, "verified");
    assert.equal(store.get(addV1.id, 1)?.status, "verified");
    assert.equal(store.get(subV2.id, 2)?.status, "verified");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("active version 选择确定：verified 优先，score 次之，version 兜底", () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-active-"));
  const store = new WorkflowStore(join(dir, "workflows.sqlite"));
  try {
    const addV1 = store.addCandidate(calcDefinition("add"));
    store.recordReplay(addV1.id, 1, "t1", true);
    // 同 goal 只匹配 v1（v2 pattern 是减），选择确定
    const match = selectWorkflow(store.list("windows"), "计算 37 加 58", false);
    assert.ok(match);
    assert.equal(match.workflow.version, 1);
    assert.equal(match.values.lhs, "37");
    // v2 未晋级时即使存在也不参与 verified 选择
    store.addCandidate(calcDefinition("subtract"));
    const again = selectWorkflow(store.list("windows"), "计算 37 加 58", false);
    assert.equal(again?.workflow.version, 1);
    // 减法 goal 匹配 v2（candidate 需 allowCandidate）
    assert.equal(selectWorkflow(store.list("windows"), "计算 246 减 19", false), undefined);
    const subMatch = selectWorkflow(store.list("windows"), "计算 246 减 19", true);
    assert.equal(subMatch?.workflow.version, 2);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("rollback：显式指定旧 verified definition 可恢复执行", () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-rollback-"));
  const store = new WorkflowStore(join(dir, "workflows.sqlite"));
  try {
    const addV1 = store.addCandidate(calcDefinition("add"));
    store.recordReplay(addV1.id, 1, "t1", true);
    const subV2 = store.addCandidate(calcDefinition("subtract"));
    store.recordReplay(subV2.id, 2, "t2", true);
    // 当前 active（减法）匹配后，显式回滚执行旧 v1（加法）定义
    const v1 = store.get(addV1.id, 1)!;
    const prepared = prepareWorkflowExecution(v1, { id: v1.id, version: 1,
      definitionHash: workflowDigest(v1),
      values: { lhs: 37, op: "add", rhs: 58 }, destination: "windows" });
    assert.equal(prepared.goal, "计算 37 加 58");
    assert.equal(prepared.ref.version, 1);
    // 旧定义仍保持 verified 且 hash 未漂移
    assert.equal(store.get(addV1.id, 1)?.status, "verified");
    assert.equal(workflowDigest(store.get(addV1.id, 1)!), workflowDigest(v1));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("definitionHash 不匹配时拒绝 replay 与验证记录", () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-hash-"));
  const store = new WorkflowStore(join(dir, "workflows.sqlite"));
  try {
    const addV1 = store.addCandidate(calcDefinition("add"));
    store.recordReplay(addV1.id, 1, "t1", true);
    const verified = store.get(addV1.id, 1)!;
    assert.equal(verified.status, "verified");
    // 定义已变化 → 第一步动作前拒绝
    assert.throws(() => prepareWorkflowExecution(verified, { id: verified.id, version: 1,
      definitionHash: "deadbeef", values: { lhs: 37, op: "add", rhs: 58 },
      destination: "windows" }), /流程定义已变化/);
    // recordReplay 带错 hash 拒绝（防止旧证据回填）
    assert.throws(() => store.recordReplay(addV1.id, 1, "tX", true, undefined, "wrong-hash"),
      /定义已改变/);
    assert.equal(store.get(addV1.id, 1)?.status, "verified");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("部分 replay / 人工确认 / record_only 单次成功都不能偷偷晋级", () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-gate-"));
  const store = new WorkflowStore(join(dir, "workflows.sqlite"));
  try {
    const candidate = store.addCandidate(calcDefinition("add"));
    // record_only：单次成功只记录证据，不自动晋级 verified
    const recorded = store.recordReplay(candidate.id, candidate.version, "t1", true,
      undefined, undefined, "record_only");
    assert.equal(recorded.status, "candidate");
    assert.equal(recorded.successCount, 1);
    // publish 要求 hash 与计数严格一致，任何偏差都拒绝；全对才允许正式晋级
    assert.throws(() => store.publish(candidate.id, candidate.version,
      workflowDigest(recorded), recorded.successCount + 1, recorded.failureCount), /记录已变化/);
    assert.throws(() => store.publish(candidate.id, candidate.version,
      "wrong-hash", recorded.successCount, recorded.failureCount), /记录已变化/);
    assert.equal(store.publish(candidate.id, candidate.version,
      workflowDigest(recorded), recorded.successCount, recorded.failureCount).status, "verified");
    // 人工确认（humanReview.approved）与部分 replay 不得判成功（explicitReplaySucceeded fail-closed）
    const verified = store.get(candidate.id, candidate.version)!;
    const partialState = { taskId: "p", goal: "g", plan: [], completionCriteria: {},
      executedImpactActions: [], recentHistory: [], step: 1, retryCount: 0, status: "running" as const,
      workflowRef: { id: verified.id, version: verified.version,
        values: { lhs: 37, op: "add", rhs: 58 }, definitionHash: workflowDigest(verified), explicit: true },
      workflowReplayState: { nextIndex: 1, exploring: false },
      lastResult: { ok: true, message: "ok" }, lastVerification: { ok: true, message: "ok" },
      humanReview: { approved: true, answer: "ok" } as unknown as ComputerState["humanReview"] };
    assert.equal(explicitReplaySucceeded(partialState, verified), false,
      "人工确认的 replay 不得判为自动成功");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
