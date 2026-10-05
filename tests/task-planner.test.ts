import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from "node:test";
import { ChatCompletionsModel, TaskPlanningError } from "../src/agent/chat-completions-model.js";
import { FakeModel } from '../src/agent/model-adapter.js';
import { parseTaskPlan } from "../src/agent/task-planner.js";
import { createAgentLoop } from '../src/graph/graph.js';
import { initialState } from '../src/graph/state.js';
import { SqliteTrace } from '../src/trace/sqlite-trace.js';
import { taskProfile } from "../src/app/task-profiles.js";
import { createDefaultExtensionRegistry } from "../src/extensions/index.js";
import { verifyGoal } from "../src/verifier/verifier.js";
import type { WindowInfo } from "../src/runtime/desktop/desktop-runtime.js";

const window: WindowInfo = { handle: 42, title: "示例应用", windowClass: "Example",
  processId: 1, processPath: "C:\\example.exe", targetElevated: false,
  visible: true, minimized: false, foreground: true,
  rect: { left: 0, top: 0, width: 100, height: 100 } };
const goal = '测试目标';
const contract = (criteria: Record<string, unknown>, target = goal) => ({goal:target,
  successConditions:criteria, evidenceSources:Object.fromEntries(Object.keys(criteria).map(key => [key,
    key === 'accessibilityIncludes' ? 'uia' : key === 'windowTitleIncludes' ? 'window' :
      key === 'urlIncludes' ? 'browser' : 'dom'])), verifierStrategy:'rules_then_jev'});

test("规划结果只接受已发现的可见 Windows 窗口和独立完成条件", () => {
  const json = (handle: number, criteria: Record<string, unknown>) => JSON.stringify({ environment: "windows",
    windowHandle: handle, plan: ["打开设置"], verificationContract:contract(criteria) });
  assert.deepEqual(parseTaskPlan(json(42, { accessibilityIncludes: "声音设置" }), [window], goal),
    { environment: "windows", windowHandle: 42, plan: ["打开设置"],
      completionCriteria: { accessibilityIncludes: "声音设置" },
      verificationContract: contract({ accessibilityIncludes: "声音设置" }) });
  assert.throws(() => parseTaskPlan(json(43, { accessibilityIncludes: "声音设置" }), [window], goal), /窗口/);
  assert.throws(() => parseTaskPlan(json(42, { urlIncludes: "example" }), [window], goal), /文本完成条件/);
  assert.throws(() => parseTaskPlan(JSON.stringify({ environment: "browser", plan: ["搜索"],
    verificationContract: contract({}) }), [], goal), /Success Conditions/);
});

test("规划器只能选择已登记应用，启动任务可由窗口标题验收", () => {
  const apps = [{ id: "demo", name: "示例应用", executable: "C:\\demo.exe", args: [] }];
  const plan = (appId: string) => JSON.stringify({ environment: "windows", appId,
    plan: ["启动示例应用"], verificationContract: contract({ windowTitleIncludes: "示例应用" }, '启动示例应用') });
  assert.deepEqual(parseTaskPlan(plan("demo"), [], "启动示例应用", apps), {
    environment: "windows", appId: "demo", plan: ["启动示例应用"],
    completionCriteria: { windowTitleIncludes: "示例应用" },
    verificationContract: contract({ windowTitleIncludes: "示例应用" }, '启动示例应用'),
  });
  assert.throws(() => parseTaskPlan(plan("invented"), [], "启动示例应用", apps), /已登记应用/);
  assert.equal(verifyGoal({ windowTitleIncludes: "示例应用" }, { windowTitle: "示例应用" }).ok, true);
});

test('规划契约拒绝目标漂移、遗漏证据来源、未知字段和类型错误', () => {
  const plan = (verificationContract: unknown) => JSON.stringify({environment:'browser',plan:['打开页面'],verificationContract});
  assert.throws(() => parseTaskPlan(plan(contract({pageTextIncludes:'已完成'}, '另一个目标')), [], goal), /Goal/);
  assert.throws(() => parseTaskPlan(plan({...contract({pageTextIncludes:'已完成'}),evidenceSources:{}}), [], goal), /Evidence Sources/);
  assert.throws(() => parseTaskPlan(plan(contract({pageTextIncludes:'已完成',invented:'假条件'})), [], goal), /Success Conditions/);
  assert.throws(() => parseTaskPlan(plan(contract({accessibilityIncludes:['已完成']})), [], goal), /accessibilityIncludes/);
  assert.throws(() => parseTaskPlan(plan({...contract({pageTextIncludes:'已完成'}),verifierStrategy:'model_only'}), [], goal), /Verifier Strategy/);
  assert.throws(() => parseTaskPlan(JSON.stringify({environment:'browser',plan:['打开页面'],
    completionCriteria:{pageTextIncludes:'旧格式'}}), [], goal), /任务验证契约/);
});

test('规划验证契约在 Graph 与 Trace 中保持原样，不由后续动作改写', async () => {
  const dir=mkdtempSync(join(tmpdir(),'p0-plan-contract-'));
  const trace=new SqliteTrace(join(dir,'trace.sqlite'));
  const planned=parseTaskPlan(JSON.stringify({environment:'browser',plan:['查看结果'],
    verificationContract:contract({pageTextIncludes:'已完成'})}),[],goal);
  try {
    const state=initialState('p0-frozen',goal,planned.plan,planned.completionCriteria);
    state.verificationContract=planned.verificationContract;
    const result=await createAgentLoop({model:new FakeModel([{kind:'done',summary:'结束'}]),
      runtime:{async observe(){return {pageText:'已完成'};},async execute(){throw Error('不应执行');}},trace})
      .invoke(state);
    assert.deepEqual(result.verificationContract,planned.verificationContract);
    assert.deepEqual(trace.load('p0-frozen')?.verificationContract,planned.verificationContract);
    assert.equal(result.status,'done');
  } finally {trace.close();rmSync(dir,{recursive:true,force:true});}
});

test("查看酒馆战棋战绩按实际数值验收，不采用模型猜测的文字和 UIA 条件", () => {
  const task = parseTaskPlan(JSON.stringify({ environment: "windows", windowHandle: 42,
    plan: ["打开战绩"], verificationContract: contract({ pageTextIncludes: "战绩",
      accessibilityIncludes: "虚假" }, "查看我《炉石传说》的酒馆战棋的战绩") }), [window], "查看我《炉石传说》的酒馆战棋的战绩", [],
    taskProfile("查看我《炉石传说》的酒馆战棋的战绩",
      createDefaultExtensionRegistry({ rootDir: process.cwd() }))?.completionCriteria);
  const criteria = task.completionCriteria;
  assert.deepEqual(criteria, { pageTextIncludes: "完整数据",
    pageTextNumberLabels: ["四强玩家", "夺冠次数"] });
  const observation = { windowTitle: "炉石传说", pageText:
    "炉石传说\n单人完整数据\n978\n四强玩家\n302\n夺冠次数",
    accessibility: "Window | 炉石传说",
    textEvidence: [{ source: "visual_model" as const,
      text: "炉石传说\n单人完整数据\n978\n四强玩家\n302\n夺冠次数" }] };
  assert.equal(verifyGoal(criteria, observation).ok, false);
  assert.match(verifyGoal(criteria, observation).message, /缺少 DOM\/UIA 原始证据/);
  const independentlyRead = { ...observation,
    textEvidence: [...observation.textEvidence, { source: "uia" as const,
      text: "978\n四强玩家\n302\n夺冠次数" }] };
  assert.equal(verifyGoal(criteria, independentlyRead).ok, true);
  assert.equal(verifyGoal(criteria, independentlyRead).evidence?.at(-1)?.source, "uia");
  assert.equal(verifyGoal(criteria, { ...observation,
    pageText: "单人完整数据\n四强玩家\n夺冠次数" }).ok, false);
});

test("画面数值须有结构化来源；普通文字可标注截图转录为弱证据", () => {
  const visual = { pageText: "设置页\n音量 50%",
    textEvidence: [{ source: "visual_model" as const, text: "设置页\n音量 50%" }] };
  assert.equal(verifyGoal({ pageTextIncludes: "音量 50%" }, visual).ok, false);
  assert.equal(verifyGoal({ pageTextIncludesAll: ["音量 50%"] }, visual).ok, false);
  const weak = verifyGoal({ pageTextIncludes: "设置页" }, visual);
  assert.equal(weak.ok, true);
  assert.deepEqual(weak.evidence, [{ criterion: "pageTextIncludes", source: "visual_model",
    strength: "weak" }]);
  const strong = verifyGoal({ pageTextIncludes: "音量 50%" }, { ...visual,
    textEvidence: [...visual.textEvidence, { source: "uia" as const, text: "音量 50%" }] });
  assert.equal(strong.ok, true);
  assert.equal(strong.evidence?.[0]?.strength, "strong");
});

test("模型规划调用记录服务返回的 token 数", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ environment: "browser",
      plan: ["打开搜索页", "查找结果"], verificationContract:contract({ pageTextIncludes: "查询成功" }, '查找示例') }) } }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("服务未启动");
    const model = new ChatCompletionsModel({ apiKey: "test", model: "test-model",
      baseUrl: `http://127.0.0.1:${address.port}/v1` });
    const result = await model.planTask("查找示例", [window]);
    assert.equal(result.task.environment, "browser");
    assert.equal(result.usage?.totalTokens, 20);
  } finally { await new Promise<void>((done) => server.close(() => done())); }
});

test('规划 schema 错误保留该次模型返回用量，且不会产生可执行计划', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type','application/json');
    response.end(JSON.stringify({choices:[{message:{content:JSON.stringify({environment:'browser',
      plan:['打开页面'],verificationContract:contract({accessibilityIncludes:['错误类型']}, '测试目标')})}}],
      usage:{prompt_tokens:9,completion_tokens:4,total_tokens:13}}));
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  try {
    const address=server.address(); if(!address||typeof address==='string')throw Error('server');
    const model=new ChatCompletionsModel({apiKey:'test',model:'test',baseUrl:`http://127.0.0.1:${address.port}`});
    await assert.rejects(()=>model.planTask('测试目标'),error=>{
      assert.ok(error instanceof TaskPlanningError);
      assert.match(error.message,/accessibilityIncludes/);
      assert.equal(error.usage?.totalTokens,13);
      return true;
    });
  } finally {await new Promise<void>(done=>server.close(()=>done()));}
});
