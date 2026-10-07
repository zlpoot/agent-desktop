import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputerAction, Observation } from "../src/actions/schema.js";
import type { ModelAdapter } from "../src/agent/model-adapter.js";
import { createAgentLoop } from "../src/graph/graph.js";
import { initialState } from "../src/graph/state.js";
import type { RuntimeAdapter } from "../src/runtime/runtime-adapter.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";
import { distillWorkflowV2, verifyWorkflowStep } from "../src/workflows/distill.js";
import { workflowDigest } from "../src/workflows/recovery.js";
import { prepareWorkflowExecution } from "../src/workflows/execution.js";
import { applyWorkflowInputs, coerceMatchedInputs } from "../src/workflows/parameterization.js";
import type { Workflow } from "../src/workflows/schema.js";
import { WorkflowStore } from "../src/workflows/store.js";

function v2Workflow(overrides: Partial<Workflow> = {}): Workflow {
  return { id: "typed", version: 1, workflowSchemaVersion: 2, status: "verified",
    environment: "windows", taskPattern: "输入 {{text1}} 并滚动 {{num1}} 行，选择 {{choice1}}，勾选 {{bool1}}",
    inputs: [
      { name: "text1", example: "hello", kind: "text", boundTo: { stepId: "step-1", argument: "text" } },
      { name: "num1", example: "3", kind: "number", boundTo: { stepId: "step-2", argument: "value/text" } },
      { name: "choice1", example: "A", kind: "choice", choices: ["A", "B"], boundTo: { stepId: "step-3", argument: "choice" } },
      { name: "bool1", example: "true", kind: "bool", boundTo: { stepId: "step-4", argument: "checked" } },
    ],
    preconditions: [], steps: [
      { stepId: "step-1", goal: "输入 {{text1}}",
        action: { kind: "type", target: { kind: "role", role: "Edit", name: "input" }, text: "{{text1}}" },
        preferredMethods: [], successCondition: { kind: "text_includes", value: "{{text1}}" } },
      { stepId: "step-2", goal: "滚动 {{num1}} 行",
        action: { kind: "scroll", direction: "down", amount: 3 }, preferredMethods: [],
        successCondition: { kind: "state_changed" } },
      { stepId: "step-3", goal: "选择 {{choice1}}",
        action: { kind: "click", target: { kind: "role", role: "button", name: "{{choice1}}" } },
        preferredMethods: [], successCondition: { kind: "state_changed" } },
      { stepId: "step-4", goal: "勾选",
        action: { kind: "click", target: { kind: "role", role: "checkbox", name: "agree" } },
        preferredMethods: [], successCondition: { kind: "state_changed" } },
    ], successConditions: { pageTextIncludes: "{{text1}}" }, knownFailures: [],
    sourceTaskId: "seed", sourceTrace: "seed", createdAt: "", successCount: 1, failureCount: 0,
    ...overrides,
  };
}

test("text 参数注入 type 动作文本与占位符", () => {
  const out = applyWorkflowInputs(v2Workflow(),
    { text1: "world", num1: 5, choice1: "B", bool1: true });
  const step = out.steps[0];
  assert.equal(step.action.kind, "type");
  if (step.action.kind === "type") assert.equal(step.action.text, "world");
  assert.equal(out.successConditions.pageTextIncludes, "world");
});

test("number 参数注入 scroll.amount（数值）与 type.text（文本）", () => {
  const out = applyWorkflowInputs(v2Workflow(),
    { text1: "hello", num1: 12, choice1: "A", bool1: false });
  const step = out.steps[1];
  assert.equal(step.action.kind, "scroll");
  if (step.action.kind === "scroll") assert.equal(step.action.amount, 12);
  const textBound = v2Workflow({
    inputs: [{ name: "n", example: "7", kind: "number",
      boundTo: { stepId: "step-1", argument: "value/text" } }],
    taskPattern: "输入 {{n}}",
    steps: [{ stepId: "step-1", goal: "输入 {{n}}",
      action: { kind: "type", target: { kind: "role", role: "Edit", name: "input" }, text: "{{n}}" },
      preferredMethods: [], successCondition: { kind: "text_includes", value: "{{n}}" } }],
    successConditions: { pageTextIncludes: "{{n}}" },
  });
  const out2 = applyWorkflowInputs(textBound, { n: 7 });
  assert.equal(out2.steps[0].action.kind, "type");
  if (out2.steps[0].action.kind === "type") assert.equal(out2.steps[0].action.text, "7");
});

test("choice 参数注入点击目标文本", () => {
  const out = applyWorkflowInputs(v2Workflow(),
    { text1: "hello", num1: 3, choice1: "B", bool1: true });
  const step = out.steps[2];
  assert.equal(step.action.kind, "click");
  if (step.action.kind === "click") assert.deepEqual(step.action.target,
    { kind: "role", role: "button", name: "B" });
});

test("bool 参数注入 checked_equals 条件并受结构化证据门约束", () => {
  const out = applyWorkflowInputs(v2Workflow(),
    { text1: "hello", num1: 3, choice1: "A", bool1: true });
  const step = out.steps[3];
  assert.deepEqual(step.successCondition,
    { kind: "checked_equals", target: { kind: "role", role: "checkbox", name: "agree" }, value: true });
  assert.equal(verifyWorkflowStep(step, undefined,
    { structured: { source: "uia", complete: true, items: [{ role: "checkbox", name: "agree", checked: true }] } }), true);
  assert.equal(verifyWorkflowStep(step, undefined,
    { structured: { source: "uia", complete: true, items: [{ role: "checkbox", name: "agree", checked: false }] } }), false);
  assert.equal(verifyWorkflowStep(step, undefined,
    { structured: { source: "uia", complete: false, items: [{ role: "checkbox", name: "agree", checked: true }] } }), false,
    "incomplete 结构化枚举不得用于判定勾选成功");
  assert.equal(verifyWorkflowStep(step, undefined,
    { structured: { source: "uia", complete: true, items: [] } }), false);
});

test("fail-closed：缺参/非有限数/非法布尔/choice 不符/未知参数全部在动作前拒绝", () => {
  const wf = v2Workflow();
  assert.throws(() => applyWorkflowInputs(wf, { num1: 3, choice1: "A", bool1: true }), /缺少参数 text1/);
  assert.throws(() => applyWorkflowInputs(wf, { text1: "x", num1: NaN, choice1: "A", bool1: true }), /有限数字/);
  assert.throws(() => applyWorkflowInputs(wf, { text1: "x", num1: Infinity, choice1: "A", bool1: true }), /有限数字/);
  assert.throws(() => applyWorkflowInputs(wf, { text1: "x", num1: 3, choice1: "A", bool1: "yes" }), /布尔值/);
  assert.throws(() => applyWorkflowInputs(wf, { text1: "x", num1: 3, choice1: "C", bool1: true }), /候选/);
  assert.throws(() => applyWorkflowInputs(wf,
    { text1: "x", num1: 3, choice1: "A", bool1: true, extra: "y" }), /未知参数/);
});

test("fail-closed：boundTo stepId 不存在视为定义无效", () => {
  const wf = v2Workflow({ inputs: [{ name: "x", example: "v", kind: "text",
    boundTo: { stepId: "no-such-step", argument: "text" } }] });
  assert.throws(() => applyWorkflowInputs(wf, { x: "v" }), /不存在/);
  assert.throws(() => applyWorkflowInputs(wf, { x: "v" }), /不存在/);
});

test("goal 匹配的字符串值按 kind 转换（number/bool），非法解析拒绝", () => {
  const wf = v2Workflow();
  const out = applyWorkflowInputs(wf,
    coerceMatchedInputs(wf, { text1: "hello", num1: "5", choice1: "A", bool1: "true" }));
  const scroll = out.steps[1];
  assert.equal(scroll.action.kind, "scroll");
  if (scroll.action.kind === "scroll") assert.equal(scroll.action.amount, 5);
  assert.deepEqual(out.steps[3].successCondition,
    { kind: "checked_equals", target: { kind: "role", role: "checkbox", name: "agree" }, value: true });
  assert.throws(() => coerceMatchedInputs(wf,
    { text1: "hello", num1: "abc", choice1: "A", bool1: "true" }), /有限数字/);
  assert.throws(() => coerceMatchedInputs(wf,
    { text1: "hello", num1: "5", choice1: "A", bool1: "maybe" }), /布尔/);
});

test("prepareWorkflowExecution：v2 typed 参数通过；错类型/缺参在第一步动作前拒绝", () => {
  const wf = v2Workflow();
  const req = { id: "typed", version: 1, definitionHash: workflowDigest(wf),
    values: { text1: "hello", num1: 5, choice1: "B", bool1: true }, destination: "windows" as const };
  const prepared = prepareWorkflowExecution(wf, req);
  assert.equal(prepared.goal, "输入 hello 并滚动 5 行，选择 B，勾选 true");
  assert.throws(() => prepareWorkflowExecution(wf,
    { ...req, values: { text1: "hello", num1: "x", choice1: "B", bool1: true } }), /有限数字/);
  assert.throws(() => prepareWorkflowExecution(wf,
    { ...req, values: { text1: "hello", num1: 5, choice1: "B" } }), /缺少参数 bool1/);
  assert.throws(() => prepareWorkflowExecution(wf,
    { ...req, values: { text1: "hello", num1: 5, choice1: "B", bool1: 1 } }), /布尔值/);
});

test("v1 workflow 参数行为不变：values 仍按字符串校验", () => {
  const v1: Workflow = { id: "v1", version: 1, status: "verified", environment: "windows",
    taskPattern: "write {{value}}", inputs: [{ name: "value", example: "A" }], preconditions: [],
    steps: [{ goal: "write", action: { kind: "keypress", keys: "a" }, preferredMethods: [],
      successCondition: { kind: "text_includes", value: "{{value}}" } }],
    successConditions: { pageTextIncludes: "{{value}}" }, knownFailures: [], sourceTaskId: "seed",
    sourceTrace: "seed", createdAt: "", successCount: 1, failureCount: 0 };
  const req = { id: "v1", version: 1, definitionHash: workflowDigest(v1), values: { value: "A" },
    destination: "windows" as const };
  assert.equal(prepareWorkflowExecution(v1, req).goal, "write A");
  assert.throws(() => prepareWorkflowExecution(v1, { ...req, values: { value: 5 } }), /最多 300 字/);
  assert.throws(() => prepareWorkflowExecution(v1, { ...req, values: {} }), /最多 300 字/);
});

class SearchRuntime implements RuntimeAdapter {
  readonly name = "受控搜索页";
  private url = "about:blank";
  private query = "";
  async observe(): Promise<Observation> {
    return { url: this.url, pageText: this.url.includes("/result") ? `结果 ${this.query}` :
      this.url.includes("/search") ? `搜索页面 ${this.query}` : "空白页",
      accessibility: `搜索框 ${this.query}`, dom: `<main>${this.url} ${this.query}</main>` };
  }
  async execute(action: ComputerAction) {
    if (action.kind === "navigate") this.url = action.url;
    if (action.kind === "type") this.query = action.text;
    if (action.kind === "click") {
      const name = action.target.kind === "role" ? action.target.name : undefined;
      if (name !== "搜索" && name !== "查找") return { ok: false, message: "未知按钮" };
      this.url = `https://example.com/result?q=${encodeURIComponent(this.query)}`;
    }
    if (action.kind === "done") return { ok: true, message: "完成" };
    return { ok: true, message: "已执行" };
  }
}

class ScriptModel implements ModelAdapter {
  readonly kind = "model" as const;
  readonly name = "模拟探索模型";
  private index = 0;
  constructor(private readonly actions: ComputerAction[]) {}
  async decide(): Promise<ComputerAction> {
    const action = this.actions[this.index++];
    if (!action) throw new Error("探索动作已用尽");
    return action;
  }
}

function exploreActions(query: string): ComputerAction[] {
  return [{ kind: "navigate", url: "https://example.com/search" },
    { kind: "type", target: { kind: "role", role: "textbox", name: "搜索框" }, text: query },
    { kind: "click", target: { kind: "role", role: "button", name: "搜索" } },
    { kind: "done", summary: `已找到 ${query}` }];
}

test("v2 蒸馏：steps 持久化 stepId，inputs 带 kind + boundTo 绑定", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-workflow-v2-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  const store = new WorkflowStore(join(dir, "workflows.sqlite"));
  try {
    const original = await createAgentLoop({ model: new ScriptModel(exploreActions("香蕉")),
      runtime: new SearchRuntime(), trace }).invoke(initialState("explore-v2", "在示例站搜索 香蕉",
      undefined, { urlIncludes: "/result", pageTextIncludes: "香蕉" }));
    assert.equal(original.status, "done");
    const v2 = distillWorkflowV2(trace, "explore-v2", "trace.sqlite", "browser");
    assert.ok(v2);
    assert.equal(v2.workflowSchemaVersion, 2);
    assert.equal(v2.taskPattern, "在示例站搜索 {{input1}}");
    assert.ok(v2.steps.every((step) => typeof step.stepId === "string" && step.stepId.length > 0));
    const typeStep = v2.steps.find((step) => step.action.kind === "type");
    assert.ok(typeStep);
    const bound = v2.inputs.find((input) => input.boundTo?.stepId === typeStep.stepId);
    assert.ok(bound);
    assert.equal(bound.kind, "text");
    assert.equal(bound.boundTo?.argument, "text");
    assert.ok(!v2.inputs.some((input) => !input.boundTo), "v2 蒸馏参数必须全部显式绑定");
    const candidate = store.addCandidate(v2);
    assert.equal(candidate.workflowSchemaVersion, 2);
  } finally { trace.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
