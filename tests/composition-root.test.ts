import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRootAssembly, type RootAssembly } from "../src/composition/root.js";
import { mountSessionScope } from "../src/composition/session-scope.js";
import { DesktopSessionManager } from "../src/desktop-session/session-manager.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";
import type { ModelProvider, PlanningModel } from "../src/contracts/model-provider.js";
import type { WorkerClient } from "../src/contracts/worker-client.js";

/** 假模型：planTask 立即中断，用于证明装配后的控制器真实可提交通用任务。 */
function haltedModel(): ModelProvider {
  return {
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
}

/** 假 Worker：规划前只会用到 listWindows（planTask 在规划步骤抛错）。 */
function fakeWorker(): WorkerClient {
  return {
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

test("装配就绪：Root Context 注册全部服务，控制器可真实提交通用任务", async () => {
  const dir = mkdtempSync(join(tmpdir(), "composition-ready-"));
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "agent-desktop-apps.json"), "[]", "utf8");
  const assembly = await createRootAssembly({
    rootDir: dir,
    model: haltedModel(),
    workerClientFactory: async () => fakeWorker(),
  });
  try {
    assert.ok(assembly.root.extensionRegistry, "应注册业务扩展注册表服务");
    assert.ok(assembly.root.modelProvider, "应注册模型提供方服务");
    assert.ok(assembly.root.taskController, "应注册任务控制器服务");
    assert.ok(assembly.root.desktopProvider, "应注册桌面提供方服务");
    // VM 目标走假 Worker（Guest 路径），规划步骤被假模型中断。
    const taskId = assembly.root.taskController.submit("VM: 在记事本输入测试文字");
    assert.ok(taskId, "装配后的控制器应能提交通用任务");
    await waitFor(async () => {
      const trace = new SqliteTrace(join(dir, "web-tasks.sqlite"));
      try { return trace.load(taskId)?.status === "failed"; } finally { trace.close(); }
    });
    const trace = new SqliteTrace(join(dir, "web-tasks.sqlite"));
    try {
      const state = trace.load(taskId);
      assert.match(state?.error ?? "", /PLAN_HALT/, "任务应到达假模型的规划步骤");
    } finally { trace.close(); }
  } finally {
    await assembly.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("初始化失败回收：任一插件失败即回收整个 Root，已创建服务被关闭", async () => {
  const dir = mkdtempSync(join(tmpdir(), "composition-fail-"));
  let leakedController: { submit(goal: string): string } | undefined;
  const boom = {
    name: "boom",
    inject: ["taskController"],
    apply(ctx: { taskController: { close(): void } }) {
      leakedController = ctx.taskController as unknown as { submit(goal: string): string };
      throw new Error("init-boom");
    },
  };
  await assert.rejects(
    createRootAssembly({ rootDir: dir, model: haltedModel(), extraPlugins: [boom] }),
    /init-boom/,
  );
  assert.ok(leakedController, "失败插件应能看到已装配的控制器");
  assert.throws(() => leakedController!.submit("任意任务"),
    /任务控制器已关闭/, "回收应关闭控制器（disposer 已执行）");
  // 资源已释放：同一目录可再次成功装配（无 sqlite 锁/句柄泄漏）。
  const retry = await createRootAssembly({ rootDir: dir, model: haltedModel() });
  await retry.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test("Session 作用域：两个假 Session 隔离，销毁 A 不影响 B，且无遗留作用域", async () => {
  const dir = mkdtempSync(join(tmpdir(), "composition-scope-"));
  const desktop = new DesktopSessionManager(dir, "", 1000);
  const assembly = await createRootAssembly({
    rootDir: dir, model: haltedModel(), desktop,
  });
  const base = { root: assembly.root, rootDir: dir, token: "", controlBus: assembly.controlBus,
    requireReconnect: false };
  const scopeA = mountSessionScope({ ...base, sessionId: "session-a", vmId: "vm-a",
    endpoint: "http://127.0.0.1:9" });
  const scopeB = mountSessionScope({ ...base, sessionId: "session-b", vmId: "vm-b",
    endpoint: "http://127.0.0.1:9" });
  // 作用域装载为异步：先等 apply 完成（disposer 注册），再交互/卸载。
  await scopeA.fiber;
  await scopeB.fiber;
  try {
    assert.notEqual(scopeA.fiber, scopeB.fiber, "两个 Session 应各有独立作用域 fiber");
    assert.equal(desktop.get("session-a")?.status, "connecting");
    assert.equal(desktop.get("session-b")?.status, "connecting");
    // 两个作用域都接受控制消息（本地校验：无输入权，不联网）。
    await assert.rejects(assembly.controlBus.dispatch("session-a", "c1",
      { command: "input", event: { kind: "text", text: "x" } }),
    /当前页面没有人工输入权/);
    await assert.rejects(assembly.controlBus.dispatch("session-b", "c2",
      { command: "input", event: { kind: "text", text: "x" } }),
    /当前页面没有人工输入权/);
    // 卸载 A：A 的处理器移除，B 的仍有效。
    await scopeA.dispose();
    await assert.rejects(assembly.controlBus.dispatch("session-a", "c1", { command: "input" }),
      /该会话未启用输入控制或已卸载/, "销毁 A 后其控制消息必须被拒绝");
    await assert.rejects(assembly.controlBus.dispatch("session-b", "c2",
      { command: "input", event: { kind: "text", text: "x" } }),
    /当前页面没有人工输入权/, "销毁 A 不影响 B 的输入控制");
    // A 的作用域 ctx 已失效；dispose 可重复调用。
    assert.throws(() => scopeA.scope.effect(() => () => {}),
      /cannot create effect on inactive context/, "已卸载作用域不能创建新 effect");
    await scopeA.dispose();
    assert.equal(desktop.get("session-a")?.status, "connecting",
      "会话登记记录保留（作用域只释放控制资源，不删除持久记录）");
  } finally {
    await scopeB.dispose();
    await assembly.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("重复挂载/卸载同一 Session：登记更新、控制可重新接管、无残留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "composition-remount-"));
  const assembly = await createRootAssembly({
    rootDir: dir, model: haltedModel(), desktop: new DesktopSessionManager(dir, "", 1000),
  });
  const base = { root: assembly.root, rootDir: dir, token: "", controlBus: assembly.controlBus,
    requireReconnect: false };
  try {
    let scope = mountSessionScope({ ...base, sessionId: "session-x", vmId: "vm-old",
      endpoint: "http://127.0.0.1:9" });
    await scope.fiber;
    assert.equal(assembly.root.desktopProvider.get("session-x")?.vmId, "vm-old");
    await scope.dispose();
    // 同一 sessionId 重新挂载（VM 地址变化场景）：记录更新，控制重新可用。
    scope = mountSessionScope({ ...base, sessionId: "session-x", vmId: "vm-new",
      endpoint: "http://127.0.0.1:9" });
    await scope.fiber;
    assert.equal(assembly.root.desktopProvider.get("session-x")?.vmId, "vm-new",
      "重新挂载应更新会话登记");
    await assert.rejects(assembly.controlBus.dispatch("session-x", "c1",
      { command: "input", event: { kind: "text", text: "x" } }),
    /当前页面没有人工输入权/, "重新挂载后控制应恢复可用");
    await scope.dispose();
  } finally {
    await assembly.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Root 卸载：关闭控制器与桌面提供方，释放全部作用域", async () => {
  const dir = mkdtempSync(join(tmpdir(), "composition-root-down-"));
  const desktop = new DesktopSessionManager(dir, "", 1000);
  const assembly: RootAssembly = await createRootAssembly({
    rootDir: dir, model: haltedModel(), desktop,
  });
  const controller = assembly.controller;
  const scope = mountSessionScope({ root: assembly.root, rootDir: dir, sessionId: "s",
    vmId: "vm", endpoint: "http://127.0.0.1:9", token: "",
    controlBus: assembly.controlBus, requireReconnect: false });
  await scope.fiber;
  await scope.dispose();
  await assembly.dispose();
  assert.throws(() => controller.submit("任意任务"),
    /任务控制器已关闭/, "Root 卸载后控制器应拒绝新任务");
  await desktop.close();
  assert.ok(true, "manager.close 可重复调用（关闭责任唯一，卸载后再关不抛错）");
  rmSync(dir, { recursive: true, force: true });
});

test("在途接管完成后卸载必须向 Guest 撤权，再关闭本地数据库", async () => {
  const dir = mkdtempSync(join(tmpdir(), "composition-inflight-"));
  const calls: string[] = [];
  const controlHits: Array<{ mode: string; responded: boolean }> = [];
  let controlReceived!: () => void;
  const firstControl = new Promise<void>((resolve) => { controlReceived = resolve; });
  const worker = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    let raw = ""; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    if (req.url === "/control") {
      calls.push("control");
      controlHits.push({ mode: body.mode, responded: false });
      controlReceived();
      await new Promise((done) => setTimeout(done, 200));
      if (controlHits.length) controlHits[controlHits.length - 1].responded = true;
      res.end(JSON.stringify({ result: { mode: body.mode, lease: body.mode === "human" ? "lease" : null } }));
      return;
    }
    if (req.url === "/state") { calls.push("state"); res.end(JSON.stringify({ vm_id: "vm" })); return; }
    if (req.url === "/frame") { calls.push("frame"); res.end(JSON.stringify({ ok: true })); return; }
    res.end(JSON.stringify({ result: {} }));
  });
  await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
  const address = worker.address();
  if (!address || typeof address === "string") throw new Error("port");
  const desktop = new DesktopSessionManager(dir, "secret", 750);
  const assembly = await createRootAssembly({ rootDir: dir, model: haltedModel(), desktop });
  const base = { root: assembly.root, rootDir: dir, token: "secret",
    controlBus: assembly.controlBus, requireReconnect: false };
  const scope = mountSessionScope({ ...base, sessionId: "s", vmId: "vm",
    endpoint: `http://127.0.0.1:${address.port}` });
  await scope.fiber;
  try {
    // 发起人工接管：Worker 延迟响应，请求在途。
    const pending = assembly.controlBus.dispatch("s", "c1",
      { command: "take", event: {} }).catch(() => {});
    let receivedTimeout: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([firstControl,new Promise<never>((_resolve,reject)=>{
      receivedTimeout=setTimeout(()=>reject(new Error('Worker control request not received')),2000);
    })]); } finally { if(receivedTimeout)clearTimeout(receivedTimeout); }
    assert.equal(controlHits.length, 1, "Worker 应已收到在途控制请求");
    assert.equal(controlHits[0].responded, false, "请求应仍在途");
    // 卸载 Session：close 等在途请求 settle 后才关闭本地资源。
    await scope.dispose();
    await pending;
    assert.deepEqual(controlHits.map((hit) => hit.mode), ["human", "paused"],
      "不能只改 Host 状态；Worker 必须收到最终撤权请求");
    const db = new DatabaseSync(join(dir, "desktop-control.sqlite"));
    try {
      const row = db.prepare("SELECT value FROM control_state WHERE id=?").get("s") as { value: string } | undefined;
      assert.ok(row, "控制状态应落盘");
      const state = JSON.parse(row.value) as { mode: string; error?: string };
      assert.equal(state.mode, "PAUSED", "Guest 确认撤权后落盘暂停状态");
      assert.equal(state.error, undefined);
    } finally { db.close(); }
  } finally {
    await assembly.dispose();
    await new Promise<void>((resolve) => worker.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("close() 取消排队任务并等待运行中任务完成，取消任务落盘失败原因", async () => {
  const dir = mkdtempSync(join(tmpdir(), "composition-cancel-"));
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "agent-desktop-apps.json"), "[]", "utf8");
  let planStarted = false;
  let releasePlan: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { releasePlan = resolve; });
  const modelProvider: ModelProvider = {
    createModel() {
      return {
        name: "挂起规划模型", kind: "rule",
        async decide() { throw new Error("不应到达决策"); },
        async planTask() {
          planStarted = true;
          await gate;
          throw new Error("PLAN_HALT");
        },
        async transcribeScreenshot() { return { text: "" }; },
        async locateVisualTarget() { return { x: 0, y: 0, confidence: 0 }; },
        takeVisualUsage() { return undefined; },
      } as PlanningModel;
    },
  };
  const assembly = await createRootAssembly({
    rootDir: dir, model: modelProvider,
    workerClientFactory: async () => fakeWorker(),
  });
  try {
    const controller = assembly.controller;
    const first = controller.submit("VM: 在记事本输入测试文字");
    await waitFor(async () => planStarted, 5000);
    const second = controller.submit("VM: 在记事本输入测试文字");
    // 关闭：置标志、取消排队任务、等待运行中任务完成。
    const closing = controller.close();
    assert.throws(() => controller.submit("VM: 再来一个"), /任务控制器已关闭/);
    releasePlan!();
    await closing;
    const tracePath = join(dir, "web-tasks.sqlite");
    const readStatus = (taskId: string) => {
      const trace = new SqliteTrace(tracePath);
      try { return trace.load(taskId)?.status; } finally { trace.close(); }
    };
    assert.equal(readStatus(first), "failed", "运行中任务应正常完成到失败（假模型规划中断）");
    const firstState = (() => { const trace = new SqliteTrace(tracePath);
      try { return trace.load(first); } finally { trace.close(); } })();
    assert.match(firstState?.error ?? "", /PLAN_HALT/);
    assert.equal(readStatus(second), "failed", "排队任务应被取消");
    const secondState = (() => { const trace = new SqliteTrace(tracePath);
      try { return trace.load(second); } finally { trace.close(); } })();
    assert.match(secondState?.error ?? "", /任务控制器已关闭，任务已取消/);
    await controller.close();
  } finally {
    await assembly.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("双 Session 任务控制绑定按 owner 隔离：卸载 A 不清空 B", async () => {
  const dir = mkdtempSync(join(tmpdir(), "composition-owner-"));
  const assembly = await createRootAssembly({
    rootDir: dir, model: haltedModel(), desktop: new DesktopSessionManager(dir, "", 1000),
  });
  const base = { root: assembly.root, rootDir: dir, token: "", controlBus: assembly.controlBus,
    requireReconnect: false };
  try {
    const scopeA = mountSessionScope({ ...base, sessionId: "session-a", vmId: "vm-a",
      endpoint: "http://127.0.0.1:9" });
    const scopeB = mountSessionScope({ ...base, sessionId: "session-b", vmId: "vm-b",
      endpoint: "http://127.0.0.1:9" });
    await scopeA.fiber;
    await scopeB.fiber;
    assert.equal(assembly.controller.getDesktopControl(), scopeB.control,
      "后挂载的 B 持有任务控制绑定");
    await scopeA.dispose();
    assert.equal(assembly.controller.getDesktopControl(), scopeB.control,
      "卸载 A 不应清空 B 的任务控制绑定");
    await scopeB.dispose();
    assert.equal(assembly.controller.getDesktopControl(), undefined,
      "卸载最后一个绑定者后任务控制清空");
  } finally {
    await assembly.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("活跃 Session 随 Root 一起释放：轮询停止、控制关闭、无残留请求", async () => {
  const dir = mkdtempSync(join(tmpdir(), "composition-active-"));
  let polls = 0;
  const worker = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/state") { polls++; res.end(JSON.stringify({ vm_id: "vm" })); return; }
    if (req.url === "/frame") { res.end(JSON.stringify({ ok: true })); return; }
    res.end(JSON.stringify({ result: {} }));
  });
  await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
  const address = worker.address();
  if (!address || typeof address === "string") throw new Error("port");
  const desktop = new DesktopSessionManager(dir, "secret", 60);
  const assembly = await createRootAssembly({ rootDir: dir, model: haltedModel(), desktop });
  const dummy = createServer(); // 轮询定时器随 attach 启动；测试不监听端口。
  desktop.attach(dummy);
  const scope = mountSessionScope({ root: assembly.root, rootDir: dir, sessionId: "s",
    vmId: "vm", endpoint: `http://127.0.0.1:${address.port}`, token: "secret",
    controlBus: assembly.controlBus, requireReconnect: false });
  await scope.fiber;
  await waitFor(async () => { await desktop.poll(); return polls > 0; }, 5000);
  assert.ok(polls > 0, "挂载后全局轮询应访问该 Session 的 Worker");
  // 不单独卸载 scope：直接卸载 Root，活跃 Session 应随之释放。
  await assembly.dispose();
  const after = polls;
  await new Promise((done) => setTimeout(done, 400));
  assert.equal(polls, after, "Root 卸载后不应再有轮询请求（活跃已停用且轮询已停）");
  await assert.rejects(assembly.controlBus.dispatch("s", "c1", { command: "input" }),
    /该会话未启用输入控制或已卸载|控制已关闭/);
  await new Promise<void>((resolve) => worker.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});
