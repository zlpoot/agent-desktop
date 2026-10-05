import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ComputerAction } from "../src/actions/schema.js";
import { StageWorkflowModel } from "../src/agent/stage-workflow-model.js";
import { ChatCompletionsModel } from "../src/agent/chat-completions-model.js";
import type { ModelAdapter } from "../src/agent/model-adapter.js";
import { taskContract, taskProfile } from "../src/app/task-profiles.js";
import { createDefaultExtensionRegistry } from "../src/extensions/index.js";
import { createAgentLoop } from "../src/graph/graph.js";
import { initialState, type ComputerState } from "../src/graph/state.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";
import {createLiveShadowVerifier} from '../src/verification/live-shadow.js';
import { WorkflowStore } from "../src/workflows/store.js";

test("普通任务获得通用阶段契约，应用限制仅由匹配的场景配置注入", () => {
  const registry = createDefaultExtensionRegistry({ rootDir: process.cwd() });
  const generic = taskContract("在记事本输入测试文字", taskProfile("在记事本输入测试文字", registry));
  assert.equal(generic.target, "在记事本输入测试文字");
  assert.equal(generic.allowedActions, undefined);
  assert.equal(generic.requireTargetedScroll, undefined);
  const game = taskContract("进入炉石传说佣兵之书", taskProfile("进入炉石传说佣兵之书", registry));
  assert.equal(game.target, "佣兵之书");
  assert.equal(game.requireTargetedScroll, true);
  assert.equal(game.allowedActions?.includes("type"), false);
});

test("旧阶段检查点缺少新策略字段时仍沿用匹配场景的动作边界", async () => {
  const dir = mkdtempSync(join(tmpdir(), "legacy-stage-policy-"));
  const store = new WorkflowStore(join(dir, "workflows.sqlite"));
  try {
    const goal = "进入炉石传说佣兵之书";
    const profile = taskProfile(goal, createDefaultExtensionRegistry({ rootDir: process.cwd() }))!;
    const state: ComputerState = { ...initialState("old-1", goal),
      taskContract: { target: "佣兵之书", stageActionLimit: 24, taskActionLimit: 80,
        constraint: "只导航" },
      stage: { id: "old-1:1", goal: "找到入口", successCondition: "入口",
        startedAtStep: 0, actionCount: 0, planVersion: 1, isFinal: false } };
    const model: ModelAdapter = { async decide() { return { kind: "type", text: "不可输入",
      target: { kind: "role", role: "Edit" } }; } };
    await assert.rejects(new StageWorkflowModel(model, store, undefined, "windows", profile)
      .decide(state), /任务契约不允许/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("非游戏 Windows 输入任务通过相同阶段图完成", async () => {
  const dir = mkdtempSync(join(tmpdir(), "generic-windows-stage-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  const store = new WorkflowStore(join(dir, "workflows.sqlite"));
  let content = "空白编辑器";
  let captureSequence=0;
  const model: ModelAdapter = {
    name: "阶段测试", kind: "model",
    async planStage() { return { goal: "文本已写入", successCondition: "文本已写入", isFinal: true,
      verification:{requirements:[{id:'stage-result',field:'accessibility',source:'uia'}]} }; },
    async verifyStage(_stage, observation) { const ok = observation.accessibility?.includes("文本已写入") ?? false;
      return { ok, confidence: ok ? 1 : 0, evidence: observation.accessibility ?? "", source: "uia" }; },
    async decide() { return { kind: "type", target: { kind: "role", role: "Edit" }, text: "文本已写入" }; },
  };
  const runtime = {
    async observe() { const n=++captureSequence;return { windowTitle: "示例编辑器",windowHandle:42,
      accessibility: content,dom:JSON.stringify([{name:'',value:content,runtimeId:[1,7],
        nameComplete:true,valueComplete:true,role:'Edit',autoId:'body',className:'Edit',enabled:true,visible:true}]),
      textEvidence:[{source:'uia' as const,text:content}],capture:{epoch:'test',object:'window:test:42',sequence:n,
        startedAt:n*10,finishedAt:n*10+1,clock:'collector' as const,atomic:false as const,
        enumerationComplete:true,fields:{accessibility:{complete:true,source:'uia' as const},
          dom:{complete:true,source:'uia' as const}}} }; },
    async ground(action:ComputerAction) { return {target:action.kind==='type'?action.target as import('../src/actions/schema.js').Target:undefined,
      attempts:[{strategy:'role' as const,matched:true,selected:true,detail:'UIA 唯一匹配'}]}; },
    async execute(action: ComputerAction) { if (action.kind === "type") content = action.text;
      return { ok: true, message: "已输入" }; },
  };
  try {
    const state: ComputerState = { ...initialState("editor-1", "在编辑器输入文本已写入",
      undefined, { accessibilityIncludes: "文本已写入" }),
      taskContract: taskContract("在编辑器输入文本已写入") };
    const receipts:import('../src/verification/host-shadow.js').HostShadowRecord[]=[];
    const shadowVerify=createLiveShadowVerifier({baseUrl:'http://test.invalid',apiKey:'test',instructions:()=>'',
      model:{async evaluate(questions){assert.equal(questions.length,1);assert.ok(questions[0].context);
        return {answers:questions.map(q=>({id:q.id,verdict:'pass',confidence:.99})),usage:{inputTokens:5,outputTokens:1}};}}});
    const result = await createAgentLoop({ model: new StageWorkflowModel(model, store), runtime,shadowSink:r=>receipts.push(r),
      shadowVerify,
      trace, maxSteps: 80 }).invoke(state);
    assert.equal(result.status, "done");
    assert.equal(result.completedStages?.[0]?.source, "uia");
    assert.equal(result.step, 1);
    const normalized=receipts.find(r=>r.kind==='stage-verification'&&r.input);
    assert.ok(normalized?.input);assert.equal(normalized.report?.verdict,'unknown');
    assert.equal(normalized.report?.metrics.modelCalls,1);
    assert.equal(normalized.report?.checks[0].advisory?.verdict,'pass');
    assert.equal(normalized.input.evidence[0].value,'文本已写入');
    const action=receipts.find(r=>r.kind==='action-verification'&&r.input);
    assert.equal(action?.input?.contract.scope,'action');
    assert.equal(action.report?.verdict,'pass');
    assert.equal(action.report?.metrics.modelCalls,0);
    const task=receipts.find(r=>r.kind==='task-verification'&&r.input);
    assert.equal(task?.input?.contract.scope,'task');
    assert.equal(task.report?.checks.find(c=>c.id==='original-task-goal')?.advisory?.verdict,'pass');
  } finally { trace.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("浏览器任务使用阶段图和 DOM 证据，不要求人工确认", async () => {
  const dir = mkdtempSync(join(tmpdir(), "generic-browser-stage-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  const store = new WorkflowStore(join(dir, "workflows.sqlite"));
  let page = "起始页";
  const model: ModelAdapter = {
    name: "阶段测试", kind: "model",
    async planStage(state) { const final = !!state.completedStages?.length;
      return { goal: final ? "结果已显示" : "搜索页已打开",
        successCondition: final ? "结果已显示" : "搜索页已打开", isFinal: final }; },
    async verifyStage(stage, observation) { const ok = observation.dom?.includes(stage.successCondition) ?? false;
      return { ok, confidence: ok ? 1 : 0, evidence: observation.dom ?? "", source: "dom" }; },
    async decide(state) { return state.completedStages?.length
      ? { kind: "click", target: { kind: "text", text: "查询" } }
      : { kind: "navigate", url: "https://example.test/search" }; },
  };
  const runtime = {
    async observe() { return { url: page === "起始页" ? "about:blank" : "https://example.test/search",
      dom: page, pageText: page }; },
    async execute(action: ComputerAction) { page = action.kind === "navigate"
      ? "搜索页已打开" : "结果已显示"; return { ok: true, message: "已执行" }; },
  };
  try {
    const state: ComputerState = { ...initialState("browser-1", "打开搜索页并显示查询结果",
      undefined, { domIncludes: "结果已显示" }),
      taskContract: taskContract("打开搜索页并显示查询结果") };
    const result = await createAgentLoop({ model: new StageWorkflowModel(model, store, undefined, "browser"),
      runtime, trace, maxSteps: 80 }).invoke(state);
    assert.equal(result.status, "done");
    assert.deepEqual(result.completedStages?.map((stage) => stage.source), ["dom", "dom"]);
    assert.equal(result.step, 2);
    const verifier = new ChatCompletionsModel({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "test", model: "test" });
    const checked = await verifier.verifyStage(result.stage ?? {
      id: "final", goal: "结果已显示", successCondition: "结果已显示", startedAtStep: 1,
      actionCount: 1, planVersion: 1, isFinal: true }, { dom: "结果已显示" });
    assert.equal(checked.source, "dom");
  } finally { trace.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
