import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { routeTask } from "../src/app/task-routing.js";
import { DesktopTaskController } from "../src/app/task-runner.js";
import { ExtensionRegistry, type AgentExtension, type TaskProfile,
  type SpecializedTaskCapability } from "../src/contracts/extension.js";
import type { ModelProvider, PlanningModel } from "../src/contracts/model-provider.js";
import type { WorkerClient } from "../src/contracts/worker-client.js";
import { createHearthstoneExtension } from "../src/extensions/hearthstone/hearthstone-extension.js";
import { createNeteaseExtension } from "../src/extensions/netease/netease-extension.js";
import { createNteExtension } from "../src/extensions/nte/nte-extension.js";
import { createTestbenchExtension } from "../src/extensions/testbench/testbench-extension.js";
import { initialState } from "../src/graph/state.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";

const BUSINESS_GOALS = [
  "打开网易云播放稻香",
  "在异环里把主音量调到 50%",
  "进入炉石传说佣兵之书",
  "打开 Windows Agent TestBench 模拟商城",
];

function emptyRegistry(): ExtensionRegistry {
  return new ExtensionRegistry();
}


test("禁用全部业务扩展后，应用需求全部进入通用主线（不搜索业务名）", () => {
  const registry = emptyRegistry();
  for (const goal of BUSINESS_GOALS) {
    const route = routeTask(goal, {}, registry);
    assert.deepEqual(route, { kind: "generic", goal }, `业务目标 ${goal} 应走通用兜底`);
    assert.throws(() => routeTask(goal, { admin: true }, registry), /通用任务暂不支持/,
      `无扩展时管理员任务 ${goal} 应被通用路径拒绝`);
  }
  const route = routeTask("VM: 打开网易云播放稻香", {}, registry);
  assert.deepEqual(route, { kind: "generic", goal: "VM: 打开网易云播放稻香" });
});

test("原业务通过扩展注册仍能路由，场景配置由 profile 提供", () => {
  const registry = new ExtensionRegistry();
  registry.register(createNeteaseExtension({ rootDir: process.cwd() }));
  registry.register(createNteExtension({ rootDir: process.cwd() }));
  registry.register(createHearthstoneExtension());
  registry.register(createTestbenchExtension());
  const music = routeTask("打开网易云播放稻香", {}, registry);
  assert.equal(music.kind, "specialized");
  if (music.kind === "specialized") assert.equal(music.capability.id, "netease.play");
  const game = routeTask("在异环里把主音量调到 50%", { admin: true }, registry);
  assert.equal(game.kind, "specialized");
  if (game.kind === "specialized") assert.equal(game.capability.id, "nte.volume.50");
  assert.equal(registry.profileFor("进入炉石传说佣兵之书")?.id, "hearthstone.mercenaries.navigation");
  assert.equal(registry.profileFor("查看炉石传说酒馆战棋战绩")?.id, "hearthstone.battlegrounds.record");
  assert.equal(registry.profileFor("打开 Windows Agent TestBench 模拟商城")?.id,
    "windows-agent-testbench-shopping");
});

test("能力冲突按 priority 大者优先，同优先级按注册顺序", async () => {
  const registry = new ExtensionRegistry();
  const low = makeCapabilityExtension("low", "低优先级", 0, /任意任务/);
  const high = makeCapabilityExtension("high", "高优先级", 10, /任意任务/);
  registry.register(low);
  registry.register(high);
  const hit = registry.resolveCapability("任意任务目标");
  assert.equal(hit?.capability.id, "high.cap");
  assert.equal(registry.ownerOf("high.cap"), "high", "能力归属应指向声明它的扩展");
  assert.equal(registry.ownerOf("low.cap"), "low");
  assert.equal(registry.capabilityById("low.cap")?.id, "low.cap", "可按能力 id 精确查找");
  await registry.unregister("high");
  const fallback = registry.resolveCapability("任意任务目标");
  assert.equal(fallback?.capability.id, "low.cap");
  assert.equal(registry.ownerOf("high.cap"), undefined, "卸载后能力归属应消失");
  assert.equal(registry.capabilityById("high.cap"), undefined);
});

test("重复注册与缺失依赖被拒绝，撤销注册级联且释放资源", async () => {
  const registry = new ExtensionRegistry();
  const disposed: string[] = [];
  const dependent: AgentExtension = { id: "dependent",
    dependsOn: ["base"], capabilities: [makeCapability("dependent.cap", "依赖能力", 0, /依赖目标/)],
    dispose() { disposed.push("dependent"); } };
  const base: AgentExtension = { id: "base",
    capabilities: [makeCapability("base.cap", "基础能力", 0, /依赖目标/)],
    dispose() { disposed.push("base"); } };
  assert.throws(() => registry.register(dependent), /缺少依赖 base/);
  registry.register(base);
  registry.register(dependent);
  assert.throws(() => registry.register(base), /已注册/);
  assert.equal(registry.resolveCapability("依赖目标")?.capability.id, "base.cap");
  await registry.unregister("base");
  assert.equal(registry.has("base"), false);
  assert.equal(registry.has("dependent"), false, "撤销基础扩展应级联撤销依赖者");
  assert.equal(registry.resolveCapability("依赖目标"), undefined);
  assert.deepEqual(disposed.sort(), ["base", "dependent"], "撤销注册应调用 dispose");
  assert.equal(await registry.unregister("base"), false, "重复撤销返回 false");
});

test("异步 dispose 被等待；dispose 抛错时卸载仍完成并上报错误", async () => {
  const registry = new ExtensionRegistry();
  let released = false;
  const asyncExtension: AgentExtension = { id: "async-ext",
    capabilities: [makeCapability("async.cap", "异步能力", 0, /异步目标/)],
    async dispose() {
      await new Promise((done) => setTimeout(done, 10));
      released = true;
    } };
  const failing: AgentExtension = { id: "failing-ext",
    capabilities: [makeCapability("fail.cap", "失败能力", 0, /失败目标/)],
    dispose() { throw new Error("释放资源失败"); } };
  registry.register(asyncExtension);
  registry.register(failing);
  await registry.unregister("async-ext");
  assert.equal(released, true, "unregister 应等待异步 dispose 完成");
  assert.equal(registry.resolveCapability("异步目标"), undefined);
  await assert.rejects(registry.unregister("failing-ext"), /释放资源失败/);
  assert.equal(registry.has("failing-ext"), false, "dispose 抛错后扩展仍应处于已撤销状态");
  assert.equal(registry.resolveCapability("失败目标"), undefined);
});

test("空扩展注册表 + 假模型 + 假 Worker 仍能提交通用任务", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-kernel-no-business-"));
  const tracePath = join(dir, "web-tasks.sqlite");
  const modelProvider: ModelProvider = {
    createModel() {
      return {
        name: "假规划模型", kind: "rule",
        async decide() { throw new Error("不应到达决策"); },
        async planTask() { throw new Error("PLAN_HALT"); },
        async transcribeScreenshot() { return { text: "" }; },
        async locateVisualTarget() { return { x: 0, y: 0, confidence: 0 }; },
        takeVisualUsage() { return undefined; },
      } as PlanningModel;
    },
  };
  const fakeWorker: WorkerClient = {
    async listWindows() { return []; },
    async ensureApp(id) { return { handle: 1, title: id }; },
    async attach() {},
    async observe() { return { pageText: "" }; },
    async probe() { throw new Error("不应到达探测"); },
    async recoverFocus() {},
    async ground(action) { return { attempts: [] }; },
    async resolveAction() { throw new Error("不应到达动作解析"); },
    async execute() { throw new Error("不应到达执行"); },
    async restore() {},
    async close() {},
  };
  const controller = new DesktopTaskController(dir, {
    registry: emptyRegistry(),
    modelProvider,
    workerClientFactory: async () => fakeWorker,
  });
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "agent-desktop-apps.json"), "[]", "utf8");
  try {
    const taskId = controller.submit("VM: 在记事本输入测试文字");
    assert.ok(taskId, "应返回任务 ID");
    await waitFor(async () => {
      const trace = new SqliteTrace(tracePath);
      try { return trace.load(taskId)?.status === "failed"; } finally { trace.close(); }
    });
    const trace = new SqliteTrace(tracePath);
    try {
      const state = trace.load(taskId);
      assert.equal(state?.status, "failed");
      assert.match(state?.error ?? "", /PLAN_HALT/);
      assert.ok(!/仅适用于|勾选开关|管理员/.test(state?.error ?? ""),
        "失败原因不应来自业务扩展");
    } finally { trace.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("空扩展注册表 + 假模型 + 假 Worker：通用任务完整成功（规划→观察→done→验收→完成）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-kernel-success-"));
  const tracePath = join(dir, "web-tasks.sqlite");
  const modelProvider: ModelProvider = {
    createModel() {
      return {
        name: "假规划模型", kind: "rule",
        async decide() { return { kind: "done", summary: "通用任务已由假模型完成" }; },
        async planStage() { return { goal: "完成", successCondition: "完成", isFinal: true }; },
        async verifyStage() { return { ok: true, confidence: 1, evidence: "完成窗口", source: "uia" }; },
        async planTask(goal: string) {
          return { task: { environment: "windows", plan: ["打开记事本", "输入测试文字"],
            completionCriteria: { windowTitleIncludes: "完成窗口" },
            verificationContract: { goal, successConditions: {windowTitleIncludes:"完成窗口"},
              evidenceSources:{windowTitleIncludes:'window'},verifierStrategy:'rules_then_jev' } } };
        },
        async transcribeScreenshot() { return { text: "完成" }; },
        async locateVisualTarget() { return { x: 10, y: 10, confidence: 0.9 }; },
        takeVisualUsage() { return undefined; },
      } as PlanningModel;
    },
  };
  const fakeWorker: WorkerClient = {
    async listWindows() { return []; },
    async ensureApp(id) { return { handle: 1, title: id }; },
    async attach() {},
    async observe() {
      return { windowTitle: "完成窗口", windowHandle: 1,
        screenshot: "data:image/png;base64,iVBORw0KGgo=", screenshotHash: "hash-1" };
    },
    async probe() {
      return { windowClass: "UnityWndClass", foreground: true, elevated: false,
        targetElevated: false, permissionsCompatible: true, title: "完成窗口",
        processId: 1, processPath: null, visible: true, minimized: false,
        rect: { left: 0, top: 0, width: 800, height: 600 }, uiaControls: true };
    },
    async recoverFocus() {},
    async ground(action) { return { attempts: [] }; },
    async resolveAction() { throw new Error("不应到达动作解析"); },
    async execute() { throw new Error("不应到达执行"); },
    async restore() {},
    async close() {},
  };
  const controller = new DesktopTaskController(dir, {
    registry: emptyRegistry(),
    modelProvider,
    workerClientFactory: async () => fakeWorker,
  });
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "agent-desktop-apps.json"), "[]", "utf8");
  try {
    const taskId = controller.submit("VM: 在记事本输入测试文字");
    assert.ok(taskId, "应返回任务 ID");
    await waitFor(async () => {
      const trace = new SqliteTrace(tracePath);
      try { return trace.load(taskId)?.status === "done"; } finally { trace.close(); }
    }).catch(error => {
      const trace = new SqliteTrace(tracePath);
      try {
        const state = trace.load(taskId);
        throw new Error(`通用任务未完成：${JSON.stringify({ status: state?.status,
          summary: state?.summary, error: state?.error })}`, { cause: error });
      } finally { trace.close(); }
    });
    const trace = new SqliteTrace(tracePath);
    try {
      const state = trace.load(taskId);
      assert.equal(state?.status, "done", "通用任务应在空扩展注册表下完整完成");
      assert.equal(state?.goalVerification?.ok, true, "完成验证应通过独立条件");
      assert.equal(state?.executorId, undefined, "通用任务不携带执行器身份");
      assert.match(state?.summary ?? "", /已完成|完成/);
      assert.ok(!/仅适用于|勾选开关|管理员/.test(state?.error ?? ""),
        "完成过程不应出现业务扩展错误");
    } finally { trace.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("专用任务持久化执行器身份：恢复按 executorId 路由，不再按目标文本匹配", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-executor-identity-"));
  const tracePath = join(dir, "web-tasks.sqlite");
  const registry = new ExtensionRegistry();
  const resumed: Array<{ taskId: string; approved?: boolean }> = [];
  let matched = true;
  const capability: SpecializedTaskCapability = {
    id: "fake.exec",
    priority: 5,
    matches: () => matched,
    prepare(goal) {
      return { kind: "specialized", environment: "windows", goal,
        plan: ["执行"], facts: { deterministicIntent: true }, operations: [] };
    },
    submit(request, enqueue) {
      const taskId = "fake-exec-task";
      const trace = new SqliteTrace(tracePath);
      try {
        trace.save("queued", { ...initialState(taskId, request.goal, request.plan,
          request.completionCriteria), executorId: "fake.exec", status: "waiting_user",
          summary: "等待人工确认" });
      } finally { trace.close(); }
      enqueue(async () => { /* 测试执行器不真正运行 */ });
      return taskId;
    },
    resume(taskId, response, enqueue) {
      resumed.push({ taskId, approved: response.approved });
      enqueue(async () => { /* 测试执行器不真正运行 */ });
    },
  };
  registry.register({ id: "fake-ext", name: "假扩展", capabilities: [capability] });
  try {
    const controller = new DesktopTaskController(dir, { registry });
    const taskId = controller.submit("专属任务目标");
    assert.equal(taskId, "fake-exec-task");
    matched = false; // 提交后该能力不再按文本匹配
    controller.resume(taskId, { approved: true });
    assert.deepEqual(resumed, [{ taskId, approved: true }],
      "恢复应路由到提交时的执行器，即使目标文本不再匹配");
    await registry.unregister("fake-ext");
    assert.throws(() => controller.resume(taskId, { approved: true }), /已卸载/,
      "执行器卸载后恢复应明确报错，不静默改路由");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function makeCapability(id: string, name: string, priority: number, pattern: RegExp): SpecializedTaskCapability {
  return {
    id, priority,
    matches: (goal) => pattern.test(goal),
    prepare(goal) {
      return { kind: "specialized", environment: "windows", goal,
        plan: [name], facts: { deterministicIntent: true }, operations: [] };
    },
    submit(request, enqueue) {
      const taskId = `${id}-${Math.random().toString(36).slice(2)}`;
      enqueue(async () => { /* 测试能力不真正执行 */ });
      return taskId;
    },
  };
}

function makeCapabilityExtension(id: string, name: string, priority: number,
  pattern: RegExp): AgentExtension {
  return { id, name, capabilities: [makeCapability(`${id}.cap`, name, priority, pattern)] };
}

/** 轮询直到条件满足或超时。 */
async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("等待条件超时");
}

test("同名能力与同名场景配置被拒绝注册：能力 ID 全局唯一", () => {
  const registry = new ExtensionRegistry();
  const makeProfile = (id: string): TaskProfile => ({ id, matches: () => false });
  const extA: AgentExtension = { id: "ext-a",
    capabilities: [makeCapability("dup.cap", "dup", 0, /dup/)],
    profiles: [makeProfile("dup.profile")] };
  const extB: AgentExtension = { id: "ext-b",
    capabilities: [makeCapability("dup.cap", "dup", 0, /dup/)] };
  const extC: AgentExtension = { id: "ext-c", profiles: [makeProfile("dup.profile")] };
  registry.register(extA);
  // 卸载 A 不再影响 B 的同名能力——因为同名能力根本不允许注册。
  assert.throws(() => registry.register(extB), /能力 dup\.cap 已被其他扩展声明/);
  assert.throws(() => registry.register(extC), /场景配置 dup\.profile 已存在/);
  assert.equal(registry.ownerOf("dup.cap"), "ext-a", "归属无歧义");
  registry.unregister("ext-a");
  assert.equal(registry.capabilityById("dup.cap"), undefined, "卸载 A 后同名能力随之移除");
  registry.register(extB);
  assert.equal(registry.ownerOf("dup.cap"), "ext-b", "A 移除后可被 B 独占声明");
});
