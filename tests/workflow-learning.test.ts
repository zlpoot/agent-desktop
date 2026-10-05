import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ComputerAction, GroundingResult, Observation } from "../src/actions/schema.js";
import type { ModelAdapter } from "../src/agent/model-adapter.js";
import { runTaskAgent } from "../src/agent/task-agent.js";
import { createAgentLoop } from "../src/graph/graph.js";
import { initialState, type ComputerState } from "../src/graph/state.js";
import type { RuntimeAdapter } from "../src/runtime/runtime-adapter.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";
import { distillWorkflow } from "../src/workflows/distill.js";
import { instantiateWorkflow, selectWorkflow } from "../src/workflows/matcher.js";
import { WorkflowReplayModel } from "../src/workflows/replay-model.js";
import type { Workflow } from "../src/workflows/schema.js";
import { WorkflowStore } from "../src/workflows/store.js";

class SearchRuntime implements RuntimeAdapter {
  readonly name = "受控搜索页";
  readonly executed: ComputerAction[] = [];
  private url = "about:blank";
  private query = "";
  private staleNotice = "";
  constructor(private readonly oldButtonFails = false,
    private readonly oldButtonChangesUnrelatedState = false) {}
  async observe(): Promise<Observation> {
    return { url: this.url, pageText: this.url.includes("/result") ? `结果 ${this.query}` :
      this.url.includes("/search") ? `搜索页面 ${this.query} ${this.staleNotice}` : "空白页",
      accessibility: `搜索框 ${this.query}`, dom: `<main>${this.url} ${this.query}</main>` };
  }
  async execute(action: ComputerAction) {
    this.executed.push(action);
    if (action.kind === "navigate") this.url = action.url;
    if (action.kind === "type") this.query = action.text;
    if (action.kind === "click") {
      const name = action.target.kind === "role" ? action.target.name : undefined;
      if (name === "搜索" && this.oldButtonFails) return { ok: false, message: "旧按钮不存在" };
      if (name === "搜索" && this.oldButtonChangesUnrelatedState) {
        this.staleNotice = "旧按钮只打开了提示";
        return { ok: true, message: "提示已打开" };
      }
      if (name !== "搜索" && name !== "查找") return { ok: false, message: "未知按钮" };
      this.url = `https://example.com/result?q=${encodeURIComponent(this.query)}`;
    }
    return { ok: true, message: "已执行" };
  }
}

class RenamedButtonRuntime extends SearchRuntime {
  async ground(action: ComputerAction): Promise<GroundingResult> {
    if (action.kind !== "click" && action.kind !== "type") return { attempts: [] };
    if (action.target.kind === "role" && action.target.role === "button" &&
        action.target.name === "搜索") return { attempts: [
      { strategy: "role", matched: false, selected: false, detail: "按钮已更名为查找" },
    ] };
    return { target: action.target.kind === "candidates" ? undefined : action.target,
      attempts: [{ strategy: "role", matched: true, selected: true, detail: "按当前名称重新定位" }] };
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

class WindowRuntime implements RuntimeAdapter {
  readonly name = "受控桌面窗口";
  readonly executed: ComputerAction[] = [];
  private opened = false;
  constructor(readonly mode: "uia" | "shifted" | "no_uia" | "coordinate_ground") {}
  async observe(): Promise<Observation> {
    return { windowTitle: "演示窗口", pageText: this.opened ? "设置页" : "首页",
      accessibility: this.mode === "no_uia" ? "" : "按钮 设置",
      windowRect: { left: this.mode === "shifted" ? 400 : 0, top: 0, width: 800, height: 600 },
      screenshotHash: `${this.mode}:${this.opened}` };
  }
  async ground(action: ComputerAction): Promise<GroundingResult> {
    if (action.kind !== "click") return { attempts: [] };
    const role = action.target.kind === "role" && action.target.name === "设置";
    const vision = action.target.kind === "vision" && action.target.description === "设置齿轮";
    if (role && this.mode !== "no_uia") return { target: this.mode === "coordinate_ground"
      ? { kind: "coordinate", x: 80, y: 80 } : action.target as GroundingResult["target"],
      attempts: [{ strategy: "role", matched: true, selected: true,
        detail: this.mode === "shifted" ? "位置已变化，按 UIA 名称重新定位" : "UIA 唯一匹配" }] };
    if (vision) return { target: { kind: "coordinate", x: 480, y: 80 },
      attempts: [{ strategy: "vision", matched: true, selected: true, detail: "截图重新定位" }] };
    return { attempts: [{ strategy: "role", matched: false, selected: false, detail: "UIA 控件不可用" }] };
  }
  async execute(action: ComputerAction) {
    this.executed.push(action);
    if (action.kind !== "click") return { ok: false, message: "不支持的动作", effect: "none" as const };
    this.opened = true;
    return { ok: true, message: "设置页已打开", effect: "dispatched" as const };
  }
}

function exploreActions(query: string): ComputerAction[] {
  return [{ kind: "navigate", url: "https://example.com/search" },
    { kind: "type", target: { kind: "role", role: "textbox", name: "搜索框" }, text: query },
    { kind: "click", target: { kind: "role", role: "button", name: "搜索" } },
    { kind: "done", summary: `已找到 ${query}` }];
}

test("探索成功轨迹提炼候选、参数化回放并经验证升级", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-workflow-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  const store = new WorkflowStore(join(dir, "workflows.sqlite"));
  try {
    const original = await createAgentLoop({ model: new ScriptModel(exploreActions("苹果")),
      runtime: new SearchRuntime(), trace }).invoke(initialState("explore-1", "在示例站搜索 苹果",
      undefined, { urlIncludes: "/result", pageTextIncludes: "苹果" }));
    assert.equal(original.status, "done");
    const proposed = distillWorkflow(trace, "explore-1", "trace.sqlite", "browser");
    assert.ok(proposed);
    assert.equal(proposed.status, "candidate");
    assert.equal(proposed.taskPattern, "在示例站搜索 {{input1}}");
    assert.equal(proposed.steps.length, 3);
    // 回归：distill 参数化 successConditions 文本时模板必须保留完整双括号（{{input1}}，曾缺右括号）。
    assert.equal(proposed.successConditions.pageTextIncludes, "{{input1}}");
    assert.deepEqual(proposed.steps[2].semanticTarget, { label: "搜索", role: "button" });
    const candidate = store.addCandidate(proposed);
    assert.equal(selectWorkflow(store.list("browser"), "在示例站搜索 香蕉"), undefined);
    const match = selectWorkflow(store.list("browser"), "在示例站搜索 香蕉", true);
    assert.ok(match);
    const instantiated = instantiateWorkflow(match);
    assert.equal(instantiated.steps[1].action.kind, "type");
    assert.equal((instantiated.steps[1].action as { text: string }).text, "香蕉");
    assert.deepEqual(instantiated.steps[2].semanticTarget, { label: "搜索", role: "button" });
    assert.equal(instantiated.successConditions.pageTextIncludes, "香蕉");
    const runtime = new SearchRuntime();
    const replay = new WorkflowReplayModel(instantiated, new ScriptModel([]));
    const result = await createAgentLoop({ model: replay, runtime, trace })
      .invoke(initialState("replay-1", "在示例站搜索 香蕉", undefined,
        instantiated.successConditions));
    assert.equal(result.status, "done");
    assert.equal(replay.mode, "replay");
    assert.equal(runtime.executed.length, 3);
    assert.equal(trace.metrics("replay-1").filter((metric) => metric.node === "decide")
      .every((metric) => metric.actor === "rule"), true);
    const verified = store.recordReplay(candidate.id, candidate.version, "replay-1", true);
    assert.equal(verified.status, "verified");
    assert.equal(verified.successCount, 1);
    assert.ok(verified.lastVerifiedAt);
    assert.ok(selectWorkflow(store.list("browser"), "在示例站搜索 梨"));
  } finally { trace.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("旧目标失效时停止回放并交给探索，记录失败原因", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-replay-fallback-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  const store = new WorkflowStore(join(dir, "workflows.sqlite"));
  try {
    await createAgentLoop({ model: new ScriptModel(exploreActions("苹果")),
      runtime: new SearchRuntime(), trace }).invoke(initialState("source", "在示例站搜索 苹果",
      undefined, { urlIncludes: "/result", pageTextIncludes: "苹果" }));
    const candidate = store.addCandidate(distillWorkflow(trace, "source", "trace.sqlite", "browser")!);
    const match = selectWorkflow(store.list("browser"), "在示例站搜索 苹果", true)!;
    const fallback: string[] = [];
    const explore = new ScriptModel([{ kind: "click", target: { kind: "role", role: "button", name: "查找" } },
      { kind: "done", summary: "已通过新按钮完成搜索" }]);
    const replay = new WorkflowReplayModel(instantiateWorkflow(match), explore,
      (reason, state) => { fallback.push(reason); trace.save("workflow_fallback", state as ComputerState); });
    const runtime = new SearchRuntime(true);
    const result = await createAgentLoop({ model: replay, runtime, trace })
      .invoke(initialState("fallback", "在示例站搜索 苹果", undefined,
        { urlIncludes: "/result", pageTextIncludes: "苹果" }));
    assert.equal(result.status, "done");
    assert.equal(replay.mode, "explore");
    assert.match(fallback[0], /旧按钮不存在/);
    assert.ok(trace.events("fallback").some((event) => event.node === "workflow_fallback"));
    assert.ok(trace.metrics("fallback").some((metric) => metric.node === "decide" && metric.actor === "model"));
    const failed = store.recordReplay(candidate.id, candidate.version, "fallback", false, replay.reason);
    assert.equal(failed.status, "candidate");
    assert.equal(failed.failureCount, 1);
    assert.ok(failed.knownFailures.some((reason) => reason.includes("旧按钮")));
  } finally { trace.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("统一 Task Agent 自动执行探索、候选试回放和流程验证", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-task-agent-"));
  const tracePath = join(dir, "trace.sqlite");
  const trace = new SqliteTrace(tracePath);
  const store = new WorkflowStore(join(dir, "workflows.sqlite"));
  try {
    const first = await runTaskAgent({ taskId: "first", goal: "在示例站搜索 苹果",
      environment: "browser", completionCriteria: { urlIncludes: "/result", pageTextIncludes: "苹果" } },
    { runtime: new SearchRuntime(), exploreModel: new ScriptModel(exploreActions("苹果")),
      trace, tracePath, workflowStore: store });
    assert.equal(first.state.status, "done");
    assert.equal(first.mode, "explore");
    assert.ok(first.workflowCreated);
    assert.equal(store.list("browser")[0].status, "candidate");
    const second = await runTaskAgent({ taskId: "second", goal: "在示例站搜索 香蕉",
      environment: "browser", completionCriteria: { urlIncludes: "/result", pageTextIncludes: "香蕉" } },
    { runtime: new SearchRuntime(), exploreModel: new ScriptModel([]),
      trace, tracePath, workflowStore: store });
    assert.equal(second.state.status, "done");
    assert.equal(second.mode, "replay");
    assert.equal(store.list("browser")[0].status, "verified");
  } finally { trace.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("已验证流程失效后探索成功，生成保留旧版本的修订候选", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-workflow-revision-"));
  const tracePath = join(dir, "trace.sqlite");
  const trace = new SqliteTrace(tracePath);
  const store = new WorkflowStore(join(dir, "workflows.sqlite"));
  const request = (taskId: string, query: string) => ({ taskId,
    goal: `在示例站搜索 ${query}`, environment: "browser" as const,
    completionCriteria: { urlIncludes: "/result", pageTextIncludes: query } });
  try {
    await runTaskAgent(request("first", "苹果"), { runtime: new SearchRuntime(),
      exploreModel: new ScriptModel(exploreActions("苹果")), trace, tracePath, workflowStore: store });
    await runTaskAgent(request("second", "香蕉"), { runtime: new SearchRuntime(),
      exploreModel: new ScriptModel([]), trace, tracePath, workflowStore: store });
    const revised = await runTaskAgent(request("third", "梨子"), { runtime: new RenamedButtonRuntime(),
      exploreModel: new ScriptModel([{ kind: "click", target: { kind: "role", role: "button", name: "查找" } },
        { kind: "done", summary: "已找到梨子" }]), trace, tracePath, workflowStore: store });
    assert.equal(revised.state.status, "done");
    assert.equal(revised.mode, "replay_fallback");
    assert.equal(revised.workflowCreated?.version, 2);
    const versions = store.list("browser");
    assert.equal(versions.length, 2);
    assert.equal(versions.find((item) => item.version === 1)?.status, "verified");
    assert.equal(versions.find((item) => item.version === 2)?.status, "candidate");
    const trial = await runTaskAgent(request("fourth", "桃子"), { runtime: new RenamedButtonRuntime(),
      exploreModel: new ScriptModel([]), trace, tracePath, workflowStore: store });
    assert.equal(trial.state.status, "done");
    assert.equal(trial.workflowUsed?.version, 2);
    assert.equal(store.get(versions[0].id, 2)?.status, "verified");
  } finally { trace.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("回放动作已发出但语义目标失效时，修订版不继承旧动作", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-workflow-stale-"));
  const tracePath = join(dir, "trace.sqlite");
  const trace = new SqliteTrace(tracePath);
  const store = new WorkflowStore(join(dir, "workflows.sqlite"));
  const request = (taskId: string, query: string) => ({ taskId,
    goal: `在示例站搜索 ${query}`, environment: "browser" as const,
    completionCriteria: { urlIncludes: "/result", pageTextIncludes: query } });
  try {
    await runTaskAgent(request("source", "苹果"), { runtime: new SearchRuntime(),
      exploreModel: new ScriptModel(exploreActions("苹果")), trace, tracePath, workflowStore: store });
    await runTaskAgent(request("verified", "香蕉"), { runtime: new SearchRuntime(),
      exploreModel: new ScriptModel([]), trace, tracePath, workflowStore: store });
    const result = await runTaskAgent(request("revision", "梨子"), {
      runtime: new SearchRuntime(false, true), exploreModel: new ScriptModel([
        { kind: "click", target: { kind: "role", role: "button", name: "查找" } },
        { kind: "done", summary: "已找到梨子" },
      ]), trace, tracePath, workflowStore: store });
    assert.equal(result.state.status, "done");
    assert.equal(result.mode, "replay_fallback");
    assert.equal(result.workflowCreated?.version, 2);
    const revised = store.get(result.workflowCreated!.id, 2)!;
    assert.deepEqual(revised.steps.filter((step) => step.action.kind === "click")
      .map((step) => step.action), [
        { kind: "click", target: { kind: "role", role: "button", name: "查找" } },
      ]);
    assert.ok(trace.events("revision").some((event) => event.node === "workflow_fallback" &&
      event.state.summary?.includes("语义成功条件未满足")));
    assert.ok(trace.events("revision").some((event) => event.node === "workflow_step_rejected"));
    assert.equal(store.get(revised.id, 1)?.status, "verified");
  } finally { trace.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("桌面控件位置变化仍按语义回放；UIA 缺失后视觉重定位并修订流程", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-window-drift-"));
  const tracePath = join(dir, "trace.sqlite");
  const trace = new SqliteTrace(tracePath);
  const store = new WorkflowStore(join(dir, "workflows.sqlite"));
  const request = (taskId: string) => ({ taskId, goal: "打开演示窗口的设置页",
    environment: "windows" as const, completionCriteria: { pageTextIncludes: "设置页" } });
  try {
    const source = await runTaskAgent(request("window-source"), { runtime: new WindowRuntime("coordinate_ground"),
      exploreModel: new ScriptModel([{ kind: "click", target: { kind: "role", role: "button", name: "设置" } },
        { kind: "done", summary: "设置页已打开" }]), trace, tracePath, workflowStore: store });
    assert.equal(source.state.status, "done");
    assert.equal(store.get(source.workflowCreated!.id, 1)?.steps[0].action.kind, "click");
    assert.deepEqual(store.get(source.workflowCreated!.id, 1)?.steps[0].semanticTarget,
      { label: "设置", role: "button" });
    const shifted = new WindowRuntime("shifted");
    const replay = await runTaskAgent(request("window-shifted"), { runtime: shifted,
      exploreModel: new ScriptModel([]), trace, tracePath, workflowStore: store });
    assert.equal(replay.state.status, "done");
    assert.equal(replay.mode, "replay");
    assert.equal(shifted.executed[0]?.kind, "click");
    assert.equal((shifted.executed[0] as Extract<ComputerAction, { kind: "click" }>).target.kind, "role");
    const missing = await runTaskAgent(request("window-no-uia"), { runtime: new WindowRuntime("no_uia"),
      exploreModel: new ScriptModel([{ kind: "click", target: { kind: "vision", description: "设置齿轮" } },
        { kind: "done", summary: "设置页已打开" }]), trace, tracePath, workflowStore: store });
    assert.equal(missing.state.status, "done");
    assert.equal(missing.mode, "replay_fallback");
    assert.equal(missing.workflowCreated?.version, 2);
    const revised = store.get(missing.workflowCreated!.id, 2)!;
    assert.equal((revised.steps[0].action as Extract<ComputerAction, { kind: "click" }>).target.kind, "vision");
    assert.deepEqual(revised.steps[0].semanticTarget, { label: "设置齿轮" });
    assert.equal(store.get(revised.id, 1)?.status, "verified");
    assert.ok(trace.events("window-no-uia").some((event) => event.node === "workflow_fallback"));
  } finally { trace.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("旧 Workflow 只补可确定的语义字段，保持原动作与版本并可重复迁移", () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-workflow-migration-"));
  const path = join(dir, "workflows.sqlite");
  const store = new WorkflowStore(path);
  try {
    const legacy: Workflow = { id: "legacy-search", version: 1, status: "candidate",
      environment: "browser", taskPattern: "搜索 {{input1}}", inputs: [{ name: "input1", example: "苹果" }],
      preconditions: [], steps: [{ goal: "点击搜索", action: { kind: "click",
        target: { kind: "role", role: "button", name: "{{input1}}" } },
        preferredMethods: ["accessibility"], successCondition: { kind: "state_changed" } },
      { goal: "历史坐标", action: { kind: "click", target: { kind: "coordinate", x: 1, y: 2 } },
        preferredMethods: ["mouse"], successCondition: { kind: "state_changed" } }],
      successConditions: { pageTextIncludes: "{{input1}}" }, knownFailures: [],
      sourceTaskId: "source", sourceTrace: "trace.sqlite", createdAt: "2026-01-01T00:00:00Z",
      successCount: 0, failureCount: 0 };
    store.addCandidate(legacy);
    assert.deepEqual(store.migrateSemanticTargets(), { scanned: 1, updated: 1, steps: 1 });
    assert.deepEqual(store.migrateSemanticTargets(), { scanned: 1, updated: 0, steps: 0 });
    const saved = store.get("legacy-search", 1)!;
    assert.equal(saved.status, "candidate");
    assert.deepEqual(saved.steps[0].semanticTarget, { label: "{{input1}}", role: "button" });
    assert.equal(saved.steps[1].semanticTarget, undefined);
    assert.deepEqual(saved.steps.map((step) => step.action), legacy.steps.map((step) => step.action));
    const matched = selectWorkflow(store.list("browser"), "搜索 香蕉", true)!;
    assert.deepEqual(instantiateWorkflow(matched).steps[0].semanticTarget,
      { label: "香蕉", role: "button" });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
