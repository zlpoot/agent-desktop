import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ComputerAction, Observation } from "../src/actions/schema.js";
import type { ModelAdapter } from "../src/agent/model-adapter.js";
import { createAgentLoop } from "../src/graph/graph.js";
import { initialState } from "../src/graph/state.js";
import type { RuntimeAdapter } from "../src/runtime/runtime-adapter.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";
import { distillWorkflowV2 } from "../src/workflows/distill.js";
import { selectWorkflow, instantiateWorkflow } from "../src/workflows/matcher.js";
import { applyWorkflowInputs, coerceMatchedInputs } from "../src/workflows/parameterization.js";
import { WorkflowReplayModel } from "../src/workflows/replay-model.js";
import type { Workflow } from "../src/workflows/schema.js";

/** 模拟计算器（语义与真实 Windows 计算器一致：数字按钮 零…九、运算符 加/减、等于）。 */
class CalcRuntime implements RuntimeAdapter {
  readonly name = "模拟计算器";
  readonly executed: ComputerAction[] = [];
  private display = "0";
  private pending: { lhs: number; op: string } | undefined;

  private digitOf(name: string): number | undefined {
    return ({ 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 } as Record<string, number>)[name];
  }

  async observe(): Promise<Observation> {
    const buttons = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "加", "减", "等于", "清除"]
      .map((name) => `按钮 ${name}`).join("\n");
    const expr = this.pending
      ? `表达式为 ${this.pending.lhs} ${this.pending.op === "add" ? "+" : "-"} ${this.display === "0" ? "" : this.display}`
      : `表达式为`;
    const pageText = `显示为 ${this.display}\n${expr}\n${buttons}`;
    return { windowTitle: "计算器", pageText, accessibility: buttons, dom: `<ui>${buttons}</ui>`,
      textEvidence: [{ source: "uia", text: pageText }] };
  }

  async execute(action: ComputerAction): Promise<{ ok: boolean; message: string }> {
    this.executed.push(action);
    if (action.kind !== "click" || action.target.kind === "candidates") {
      return { ok: false, message: "不支持" };
    }
    if (action.target.kind !== "role") return { ok: false, message: "仅支持 role 目标" };
    const name = action.target.name ?? "";
    const digit = this.digitOf(name);
    if (digit !== undefined) {
      this.display = this.display === "0" ? String(digit) : this.display + String(digit);
      return { ok: true, message: `输入 ${name}` };
    }
    if (name === "加" || name === "减") {
      this.pending = { lhs: Number(this.display), op: name === "加" ? "add" : "sub" };
      this.display = "0";
      return { ok: true, message: `${name}` };
    }
    if (name === "等于" && this.pending) {
      this.display = String(this.pending.op === "add"
        ? this.pending.lhs + Number(this.display) : this.pending.lhs - Number(this.display));
      this.pending = undefined;
      return { ok: true, message: "=" };
    }
    if (name === "清除") { this.display = "0"; this.pending = undefined; return { ok: true, message: "清除" }; }
    return { ok: false, message: `未知按钮 ${name}` };
  }
}

class ScriptModel implements ModelAdapter {
  readonly kind = "model" as const;
  readonly name = "脚本探索模型";
  private index = 0;
  constructor(private readonly actions: ComputerAction[]) {}
  async decide(): Promise<ComputerAction> {
    const action = this.actions[this.index++];
    if (!action) throw new Error("探索动作已用尽");
    return action;
  }
}

const click = (name: string): ComputerAction =>
  ({ kind: "click", target: { kind: "role", role: "button", name } });

/** 阿拉伯数字首字符 → 中文数字按钮名（蒸馏产物的锚点按钮名是中文变体）。 */
const zhFirst = (value: string): string =>
  ({ "0": "零", "1": "一", "2": "二", "3": "三", "4": "四", "5": "五", "6": "六", "7": "七", "8": "八", "9": "九" } as Record<string, string>)[value[0] ?? ""] ?? value[0] ?? "";

function calcWorkflow(lhs: string, op: "加" | "减", rhs: string): Workflow {
  return { id: "calc-digit-family", version: 1, workflowSchemaVersion: 2, status: "candidate",
    environment: "windows", taskPattern: `计算 {{lhs}} ${op} {{rhs}}`,
    inputs: [
      { name: "lhs", example: lhs, kind: "number", boundTo: { stepId: "seq-lhs", argument: "digit_sequence" } },
      { name: "op", example: op, kind: "choice", choices: ["加", "减"],
        boundTo: { stepId: "op-step", argument: "choice" } },
      { name: "rhs", example: rhs, kind: "number", boundTo: { stepId: "seq-rhs", argument: "digit_sequence" } },
    ],
    preconditions: [{ kind: "window_title", value: "计算器" }],
    steps: [
      { stepId: "seq-lhs", goal: "输入左操作数 {{lhs}}",
        action: click(zhFirst(lhs)), preferredMethods: ["accessibility"],
        successCondition: { kind: "state_changed" } },
      { stepId: "op-step", goal: "选择 {{op}}",
        action: click(op), preferredMethods: ["accessibility"],
        successCondition: { kind: "state_changed" } },
      { stepId: "seq-rhs", goal: "输入右操作数 {{rhs}}",
        action: click(zhFirst(rhs)), preferredMethods: ["accessibility"],
        successCondition: { kind: "state_changed" } },
      { stepId: "eq-step", goal: "点击 等于", action: click("等于"),
        preferredMethods: ["accessibility"], successCondition: { kind: "state_changed" } },
    ],
    successConditions: { pageTextIncludes: "95" }, knownFailures: [],
    sourceTaskId: "seed", sourceTrace: "seed", createdAt: "", successCount: 0, failureCount: 0 };
}

function instantiate(workflow: Workflow, values: Record<string, string | number>): Workflow {
  return applyWorkflowInputs(workflow, coerceMatchedInputs(workflow, values));
}

test("digit_sequence：number 值按位展开为数字按钮点击序列（位数可变）", () => {
  const workflow = calcWorkflow("37", "加", "58");
  const two = instantiate(workflow, { lhs: 37, op: "加", rhs: 58 });
  assert.deepEqual(two.steps.map((s) => s.action), [click("三"), click("七"), click("加"),
    click("五"), click("八"), click("等于")]);
  assert.equal(two.steps[0].stepId, "seq-lhs:digit:1");
  assert.equal(two.steps[1].stepId, "seq-lhs:digit:2");
  assert.equal(two.steps[3].stepId, "seq-rhs:digit:1");
  assert.ok(two.steps.every((s) => s.successCondition.kind === "state_changed"));
  // 三位数：lhs=246 → 展开为 3 步（二/四/六），rhs=19 → 2 步
  const three = instantiate(workflow, { lhs: 246, op: "减", rhs: 19 });
  assert.deepEqual(three.steps.map((s) => s.action), [click("二"), click("四"), click("六"),
    click("减"), click("一"), click("九"), click("等于")]);
  // 参数真实改变执行行为：目标按钮名随值变化
  assert.deepEqual(three.steps[0].action, click("二"));
  assert.deepEqual(three.steps[3].action, click("减"));
});

test("digit_sequence：非负整数约束，非法值动作前拒绝", () => {
  const workflow = calcWorkflow("37", "加", "58");
  assert.throws(() => instantiate(workflow, { lhs: 12.5, op: "加", rhs: 58 }), /非负整数/);
  assert.throws(() => instantiate(workflow, { lhs: -37, op: "加", rhs: 58 }), /非负整数/);
  assert.throws(() => instantiate(workflow, { lhs: "abc", op: "加", rhs: 58 }), /有限数字/);
  assert.throws(() => instantiate(workflow, { lhs: 37, op: "乘", rhs: 58 }), /候选之一/);
  assert.throws(() => instantiate(workflow, { lhs: 37, op: "加" }), /未匹配到值/);
});

test("digit_sequence：choice 值不属于候选时在匹配层即拒绝（coerce fail-closed）", () => {
  const workflow = calcWorkflow("37", "加", "58");
  assert.throws(() => coerceMatchedInputs(workflow, { lhs: "37", op: "乘以", rhs: "58" }), /候选之一/);
  // 候选内合法值原样放行，不改变类型
  const coerced = coerceMatchedInputs(workflow, { lhs: "37", op: "减", rhs: "58" });
  assert.deepEqual(coerced, { lhs: 37, op: "减", rhs: 58 });
});

test("digit_sequence：定义校验 fail-closed（kind 不匹配 / 锚点非点击 / 锚点缺失）", () => {
  const badKind: Workflow = { ...calcWorkflow("37", "加", "58"),
    inputs: [{ name: "lhs", example: "37", kind: "choice", choices: ["37", "58"],
      boundTo: { stepId: "seq-lhs", argument: "digit_sequence" } }] };
  assert.throws(() => applyWorkflowInputs(badKind, { lhs: "37" as never, op: "加", rhs: 58 }),
    /argument=digit_sequence 要求 kind=number/);
  const badAnchor: Workflow = { ...calcWorkflow("37", "加", "58"),
    inputs: [{ name: "lhs", example: "37", kind: "number",
      boundTo: { stepId: "eq-step", argument: "digit_sequence" } }] };
  assert.throws(() => applyWorkflowInputs(badAnchor, { lhs: 37 }), /数字按钮/);
  const missing: Workflow = { ...calcWorkflow("37", "加", "58"),
    inputs: [{ name: "lhs", example: "37", kind: "number",
      boundTo: { stepId: "nope", argument: "digit_sequence" } }] };
  assert.throws(() => applyWorkflowInputs(missing, { lhs: 37, op: "加", rhs: 58 }), /不存在/);
});

test("v2 蒸馏：真实计算器点击轨迹提炼 lhs/rhs（digit_sequence）+ op（choice）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-digit-"));
  const tracePath = join(dir, "trace.sqlite");
  const trace = new SqliteTrace(tracePath);
  try {
    const actions = [click("三"), click("七"), click("加"), click("五"), click("八"), click("等于"),
      { kind: "done", summary: "计算完成" } as const];
    const result = await createAgentLoop({ model: new ScriptModel(actions),
      runtime: new CalcRuntime(), trace })
      .invoke(initialState("calc-1", "计算 37 加 58", undefined,
        { pageTextIncludes: "95" }));
    assert.equal(result.status, "done");
    const proposed = distillWorkflowV2(trace, "calc-1", tracePath, "windows");
    assert.ok(proposed);
    assert.equal(proposed.workflowSchemaVersion, 2);
    const byName = new Map(proposed.inputs.map((i) => [i.name, i]));
    assert.equal(byName.size, 3, `期望 lhs/op/rhs 三个参数，实际 ${proposed.inputs.map((i) => i.name).join(",")}`);
    assert.equal(byName.get("input1")?.kind, "number");
    assert.equal(byName.get("input1")?.boundTo?.argument, "digit_sequence");
    assert.equal(byName.get("input1")?.example, "37");
    assert.equal(byName.get("input2")?.kind, "number");
    assert.equal(byName.get("input2")?.boundTo?.argument, "digit_sequence");
    assert.equal(byName.get("input2")?.example, "58");
    assert.equal(byName.get("input3")?.kind, "choice");
    assert.equal(byName.get("input3")?.boundTo?.argument, "choice");
    assert.equal(byName.get("input3")?.example, "加");
    assert.deepEqual(byName.get("input3")?.choices, ["加", "减", "乘", "除以"]);
    // 数字序列非锚点步骤已从定义移除（37 只剩锚点"三"，58 只剩锚点"五"）；
    // 运算符步骤目标为 choice 占位 {{input3}}（replay 时注入真实按钮名）
    const stepNames = proposed.steps.map((s) =>
      (s.action.kind === "click" && s.action.target.kind === "role") ? s.action.target.name : "");
    assert.deepEqual(stepNames, ["三", "{{input3}}", "五", "等于"]);
    assert.equal(proposed.taskPattern, "计算 {{input1}} {{input3}} {{input2}}");
    // 参数变体回放：246 减 19 → 展开为 二/四/六/减/一/九/等于
    const match = selectWorkflow([proposed], "计算 246 减 19", true);
    assert.ok(match);
    const replay = instantiateWorkflow(match);
    const replayNames = replay.steps.map((s) =>
      (s.action.kind === "click" && s.action.target.kind === "role") ? s.action.target.name : "");
    assert.deepEqual(replayNames, ["二", "四", "六", "减", "一", "九", "等于"]);
    const runtime = new CalcRuntime();
    const replayResult = await createAgentLoop({ model: new WorkflowReplayModel(replay, new ScriptModel([]),
      undefined, { pageTextIncludes: "227" }), runtime, trace }).invoke(initialState("calc-2", "计算 246 减 19",
        undefined, { pageTextIncludes: "227" }));
    assert.equal(replayResult.status, "done");
    assert.equal(runtime.executed.length, 7);
    assert.ok(runtime.executed.every((a) =>
      a.kind === "click" && a.target.kind === "role" &&
      ["二", "四", "六", "减", "一", "九", "等于"].includes(a.target.name ?? "")));
  } finally { trace.close(); rmSync(dir, { recursive: true, force: true }); }
});
