import assert from "node:assert/strict";
import { test } from "node:test";
import type { Observation } from "../src/actions/schema.js";
import { verifyWorkflowStep } from "../src/workflows/distill.js";
import { preconditionsMet } from "../src/workflows/matcher.js";
import { verifyStructuredAnchor, verifyStructuredEquals } from "../src/workflows/structured-evidence.js";
import type { Workflow, WorkflowStep } from "../src/workflows/schema.js";

const uiaObservation = (items: {
  role: string; name?: string; text?: string; value?: string; checked?: boolean;
}[], complete = true, source: "dom" | "uia" = "uia"): Observation =>
  ({ structured: { source, complete, items } });

test("structured_equals：当次完整枚举 + source 匹配 + 唯一控件 + 字段相等才达成", () => {
  const step: WorkflowStep = { goal: "检查金额", action: { kind: "screenshot" },
    preferredMethods: [], successCondition: { kind: "structured_equals", source: "uia",
      target: { kind: "role", role: "text", name: "总额" }, field: "text", expected: "¥100" } };
  const ok = uiaObservation([{ role: "text", name: "总额", text: "¥100" }]);
  assert.equal(verifyWorkflowStep(step, undefined, ok), true);
  // 字段不等
  const different = uiaObservation([{ role: "text", name: "总额", text: "¥99" }]);
  assert.equal(verifyWorkflowStep(step, undefined, different), false);
  // checked 字段
  const checkStep: WorkflowStep = { goal: "确认勾选", action: { kind: "screenshot" },
    preferredMethods: [], successCondition: { kind: "structured_equals", source: "uia",
      target: { kind: "role", role: "checkbox", name: "同意" }, field: "checked", expected: true } };
  assert.equal(verifyWorkflowStep(checkStep, undefined,
    uiaObservation([{ role: "checkbox", name: "同意", checked: true }])), true);
  assert.equal(verifyWorkflowStep(checkStep, undefined,
    uiaObservation([{ role: "checkbox", name: "同意", checked: false }])), false);
});

test("structured_equals fail-closed：incomplete / source 不符 / 缺失 / ambiguous 全部不 PASS", () => {
  const step: WorkflowStep = { goal: "检查金额", action: { kind: "screenshot" },
    preferredMethods: [], successCondition: { kind: "structured_equals", source: "uia",
      target: { kind: "role", role: "text", name: "总额" }, field: "text", expected: "¥100" } };
  assert.equal(verifyWorkflowStep(step, undefined, undefined), false, "无结构化证据");
  assert.equal(verifyWorkflowStep(step, undefined,
    uiaObservation([{ role: "text", name: "总额", text: "¥100" }], false)),
  false, "incomplete 枚举不得用于判定");
  assert.equal(verifyWorkflowStep(step, undefined,
    uiaObservation([{ role: "text", name: "总额", text: "¥100" }], true, "dom")),
  false, "source 不匹配（uia 条件不能用 dom 证据）");
  assert.equal(verifyWorkflowStep(step, undefined,
    uiaObservation([{ role: "text", name: "其他", text: "¥100" }])),
  false, "目标控件不存在");
  assert.equal(verifyWorkflowStep(step, undefined,
    uiaObservation([
      { role: "text", name: "总额", text: "¥100" },
      { role: "text", name: "总额", text: "¥50" },
    ])), false, "ambiguous（多个同名控件）不得 PASS");
  const nonRole: WorkflowStep = { goal: "x", action: { kind: "screenshot" },
    preferredMethods: [], successCondition: { kind: "structured_equals", source: "uia",
      target: { kind: "label", label: "总额" }, field: "text", expected: "¥100" } };
  assert.equal(verifyWorkflowStep(nonRole, undefined,
    uiaObservation([{ role: "text", name: "总额", text: "¥100" }])),
  false, "非 role target 不可判定");
});

test("structured_equals 不携带任何旧证据快照：判定只依赖当次枚举", () => {
  const condition = { kind: "structured_equals" as const, source: "dom" as const,
    target: { kind: "role" as const, role: "link", name: "详情" }, field: "text" as const,
    expected: "打开详情" };
  // 条件对象本身没有任何 items/快照字段——旧 DOM/UIA 无从被保存进条件
  assert.deepEqual(Object.keys(condition).sort(), ["expected", "field", "kind", "source", "target"]);
  // 同一条件对两次独立枚举分别判定，互不影响
  assert.equal(verifyStructuredEquals(
    { structured: { source: "dom", complete: true, items: [{ role: "link", name: "详情", text: "打开详情" }] } },
    condition), true);
  assert.equal(verifyStructuredEquals(
    { structured: { source: "dom", complete: true, items: [{ role: "link", name: "详情", text: "已失效" }] } },
    condition), false);
});

test("structured_anchor 前置：唯一存在才放行，incomplete/ambiguous/source 不符全 fail closed", () => {
  const wf = (source: "dom" | "uia") => ({ id: "s", version: 1, status: "verified" as const,
    environment: "windows" as const, taskPattern: "p", inputs: [], steps: [],
    successConditions: {}, knownFailures: [], sourceTaskId: "s", sourceTrace: "s",
    createdAt: "", successCount: 0, failureCount: 0,
    preconditions: [{ kind: "structured_anchor" as const, source, role: "button", name: "保存" }] });
  const ok = uiaObservation([{ role: "button", name: "保存" }]);
  assert.equal(preconditionsMet(wf("uia"), ok), true);
  assert.equal(preconditionsMet(wf("dom"), ok), false, "uia 枚举不满足 dom 锚点");
  assert.equal(preconditionsMet(wf("uia"),
    uiaObservation([{ role: "button", name: "保存" }], false)), false,
  "incomplete 枚举不能证明锚点存在");
  assert.equal(preconditionsMet(wf("uia"),
    uiaObservation([
      { role: "button", name: "保存" }, { role: "button", name: "保存" }])), false,
  "锚点不唯一（ambiguous）不得放行");
  assert.equal(preconditionsMet(wf("uia"),
    uiaObservation([{ role: "button", name: "取消" }])), false);
  assert.equal(preconditionsMet(wf("uia"), {}), false, "无结构化证据");
});

test("verifyStructuredAnchor/verifyStructuredEquals 直接语义", () => {
  const anchor = { kind: "structured_anchor" as const, source: "uia" as const,
    role: "textbox", name: "q" };
  assert.equal(verifyStructuredAnchor(
    { structured: { source: "uia", complete: true, items: [{ role: "textbox", name: "q" }] } },
    anchor), true);
  assert.equal(verifyStructuredAnchor(
    { structured: { source: "uia", complete: false, items: [{ role: "textbox", name: "q" }] } },
    anchor), false);
});
