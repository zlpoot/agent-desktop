import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputerState } from "../src/graph/state.js";
import { initialState } from "../src/graph/state.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";
import { workflowDigest } from "../src/workflows/recovery.js";
import { prepareWorkflowExecution } from "../src/workflows/execution.js";
import { distillWorkflowV2 } from "../src/workflows/distill.js";
import { extractDesktopFileContract, extractDurableContract,
  validateDurableContract } from "../src/workflows/durable-contract.js";
import type { Workflow } from "../src/workflows/schema.js";
import type { CompletionCriteria } from "../src/verifier/verifier.js";

const rebindCriteria: CompletionCriteria = {
  structuredStates: [{ target: { role: "Edit", name: "姓名" }, field: "value",
    equals: "新值", persistedAfter: "rebind" }],
};

function v2Workflow(overrides: Partial<Workflow> = {}): Workflow {
  return { id: "dc", version: 1, workflowSchemaVersion: 2, status: "verified",
    environment: "windows", taskPattern: "修改姓名并保存", inputs: [], preconditions: [],
    steps: [{ stepId: "s1", goal: "输入新值",
      action: { kind: "type", target: { kind: "role", role: "Edit", name: "姓名" }, text: "新值" },
      preferredMethods: [], successCondition: { kind: "state_changed" } }],
    successConditions: rebindCriteria, durableContract: [{ kind: "durable_state",
      structuredStates: [{ target: { role: "Edit", name: "姓名" }, field: "value",
        equals: "新值", persistedAfter: "rebind" }] }],
    knownFailures: [], sourceTaskId: "seed", sourceTrace: "seed", createdAt: "",
    successCount: 1, failureCount: 0, ...overrides };
}

test("extractDurableContract：只从冻结完成条件的 rebind 项提取，绝不从 goal 猜", () => {
  const contracts = extractDurableContract(rebindCriteria);
  assert.equal(contracts.length, 1);
  assert.equal(contracts[0].kind, "durable_state");
  if (contracts[0].kind === "durable_state")
    assert.deepEqual(contracts[0].structuredStates, rebindCriteria.structuredStates);
  assert.equal(extractDurableContract({ pageTextIncludes: "保存成功" }).length, 0,
    "文本条件不构成持久化契约");
  assert.equal(extractDurableContract(undefined).length, 0);
});

test("extractDesktopFileContract：从步骤后置条件提取并按 path 去重", () => {
  const steps = [
    { stepId: "a", goal: "保存", action: { kind: "click" as const, target: { kind: "role" as const, role: "button", name: "保存" },
      postcondition: { kind: "desktop_file" as const, path: "C:\\out\\r.txt", contentEquals: "x" } },
      preferredMethods: [], successCondition: { kind: "state_changed" as const } },
    { stepId: "b", goal: "再保存", action: { kind: "keypress" as const, keys: "s",
      postcondition: { kind: "desktop_file" as const, path: "c:\\out\\r.txt" } },
      preferredMethods: [], successCondition: { kind: "state_changed" as const } },
  ];
  const files = extractDesktopFileContract(steps);
  assert.equal(files.length, 1);
  assert.equal(files[0].kind, "desktop_file");
  if (files[0].kind === "desktop_file") {
    assert.equal(files[0].path.toLowerCase(), "c:\\out\\r.txt");
    assert.equal(files[0].contentEquals, "x");
  }
});

test("validateDurableContract：契约必须与冻结完成条件/步骤后置条件对齐", () => {
  assert.equal(validateDurableContract(v2Workflow()), undefined);
  // 悬空契约：声明 criteria 没有的 rebind 目标（从 goal 猜）→ 拒绝
  const guess = v2Workflow({
    durableContract: [{ kind: "durable_state", structuredStates: [
      { target: { role: "Edit", name: "手机号" }, field: "value", equals: "1", persistedAfter: "rebind" }] }],
  });
  const violation = validateDurableContract(guess);
  assert.ok(violation?.reason.includes("不在冻结完成条件中"));
  // 非 rebind 项混入 durable_state → 拒绝
  const mixed = v2Workflow({
    durableContract: [{ kind: "durable_state", structuredStates: [
      { target: { role: "Edit", name: "姓名" }, field: "value", equals: "新值" }] }],
  });
  assert.ok(validateDurableContract(mixed)?.reason.includes("非 rebind"));
  // desktop_file 契约没有对应后置条件 → 拒绝
  const fileGuess = v2Workflow({ durableContract: [
    { kind: "desktop_file", path: "C:\\out\\nope.txt" }] });
  assert.ok(validateDurableContract(fileGuess)?.reason.includes("不在任何步骤后置条件中"));
  // 无契约 → 通过
  assert.equal(validateDurableContract(v2Workflow({ durableContract: undefined })), undefined);
});

test("步骤条件种类不存在 durable_* 分支：持久化不能被压成单步条件", () => {
  // 编译期 schema 已保证；运行时再断言条件种类集合不含持久化分支。
  const kinds = ["url_includes", "text_includes", "accessibility_includes", "state_changed",
    "checked_equals", "structured_equals"];
  for (const kind of kinds) assert.ok(!kind.startsWith("durable_"), `${kind} 不得存在`);
  assert.equal(kinds.some((kind) => kind.includes("rebind")), false,
    "rebind 只能是任务级 persistedAfter 语义，不是步骤条件");
});

test("prepareWorkflowExecution：合法持久化契约通过；悬空契约在第一步动作前拒绝", () => {
  const wf = v2Workflow();
  const req = { id: wf.id, version: wf.version, definitionHash: workflowDigest(wf),
    values: {}, destination: "windows" as const };
  assert.ok(prepareWorkflowExecution(wf, req).workflow.durableContract);
  const dangling = v2Workflow({ durableContract: [
    { kind: "durable_state", structuredStates: [
      { target: { role: "Edit", name: "手机号" }, field: "value", equals: "1", persistedAfter: "rebind" }] }] });
  assert.throws(() => prepareWorkflowExecution(dangling, { ...req,
    definitionHash: workflowDigest(dangling) }), /持久化契约校验失败/);
});

test("distillWorkflowV2：从冻结 completionCriteria 提取 durableContract（rebind 项）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-durable-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  try {
    const base = initialState("t-rebind", "修改姓名并保存", ["修改"],
      rebindCriteria) as ComputerState & { step: number };
    trace.save("decide", { ...base, step: 1 });
    trace.recordNodeMetric("t-rebind", { step: 1, node: "decide", actor: "model",
      startedAt: new Date().toISOString(), durationMs: 0, operator: "规划" });
    const action = { kind: "type" as const,
      target: { kind: "role" as const, role: "Edit", name: "姓名" }, text: "新值" };
    trace.save("execute", { ...base, step: 1, lastAction: action,
      lastResult: { ok: true, message: "ok" } });
    trace.save("verify", { ...base, step: 1, lastAction: action,
      lastResult: { ok: true, message: "ok" }, lastVerification: { ok: true, message: "ok" },
      observation: { windowTitle: "w", pageText: "x" } });
    trace.save("observe", { ...base, step: 1, lastAction: action,
      lastResult: { ok: true, message: "ok" }, lastVerification: { ok: true, message: "ok" },
      observation: { windowTitle: "w", pageText: "x" }, status: "done",
      goalVerification: { ok: true, message: "ok", evidence: [{ criterion: "x", source: "uia", strength: "strong" }], source: "uia" } as ComputerState["goalVerification"] });
    const v2 = distillWorkflowV2(trace, "t-rebind", "trace.sqlite", "windows");
    assert.ok(v2);
    assert.equal(v2.workflowSchemaVersion, 2);
    assert.ok(v2.durableContract?.length);
    assert.equal(v2.durableContract?.[0].kind, "durable_state");
    if (v2.durableContract?.[0].kind === "durable_state") {
      assert.equal(v2.durableContract[0].structuredStates[0].persistedAfter, "rebind");
      assert.equal(v2.durableContract[0].structuredStates[0].target.name, "姓名");
    }
    assert.equal(validateDurableContract(v2), undefined,
      "蒸馏产出的契约必须与 successConditions 对齐");
  } finally { trace.close(); rmSync(dir, { recursive: true, force: true }); }
});
