/** P9-A1 query-sensitive URL 条件回归：编码 pathname 参数化 + 变体回放。 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ComputerAction, GroundingResult, Observation } from "../src/actions/schema.js";
import type { ModelAdapter } from "../src/agent/model-adapter.js";
import { createAgentLoop } from "../src/graph/graph.js";
import { initialState } from "../src/graph/state.js";
import type { RuntimeAdapter } from "../src/runtime/runtime-adapter.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";
import { distillWorkflow, distillWorkflowV2 } from "../src/workflows/distill.js";
import { instantiateWorkflow, selectWorkflow } from "../src/workflows/matcher.js";
import { WorkflowReplayModel } from "../src/workflows/replay-model.js";
import { WorkflowStore } from "../src/workflows/store.js";

class WikiSearchRuntime implements RuntimeAdapter {
  readonly name = "受控百科";
  readonly executed: ComputerAction[] = [];
  private url = "https://zh.wikipedia.org/";
  private query = "";
  async observe(): Promise<Observation> {
    return { url: this.url, pageText: this.url.includes("/wiki/") ? `条目 ${this.query}` : "首页",
      accessibility: `搜索框 ${this.query}`, dom: `<main>${this.url} ${this.query}</main>` };
  }
  async execute(action: ComputerAction) {
    this.executed.push(action);
    if (action.kind === "navigate") this.url = action.url;
    if (action.kind === "type") this.query = action.text;
    if (action.kind === "keypress" && action.keys === "Enter") {
      this.url = `https://zh.wikipedia.org/wiki/${encodeURIComponent(this.query)}`;
    }
    return { ok: true, message: "已执行", effect: "dispatched" as const };
  }
  async ground(action: ComputerAction): Promise<GroundingResult> {
    if (action.kind === "type") {
      return { target: action.target.kind === "candidates" ? undefined : action.target,
        attempts: [{ strategy: "role", matched: true, selected: true, detail: "搜索框" }] };
    }
    return { attempts: [] };
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

function exploreActionsWithEncodedUrl(query: string): ComputerAction[] {
  return [{ kind: "navigate", url: "https://zh.wikipedia.org/" },
    { kind: "type", target: { kind: "role", role: "searchbox", name: "搜索框" }, text: query },
    { kind: "keypress", keys: "Enter" },
    { kind: "done", summary: `已打开条目 ${query}` }];
}

test("query-sensitive URL 条件：编码 pathname 参数化并支持变体回放（P9-A1 真实站点缺口回归）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-url-encoding-"));
  const trace = new SqliteTrace(join(dir, "trace.sqlite"));
  const store = new WorkflowStore(join(dir, "workflows.sqlite"));
  try {
    const original = await createAgentLoop({ model: new ScriptModel(exploreActionsWithEncodedUrl("苹果")),
      runtime: new WikiSearchRuntime(), trace }).invoke(initialState("source", "在维基百科搜索 苹果 并打开条目",
      undefined, { urlIncludes: "/wiki/", pageTextIncludes: "苹果" }));
    assert.equal(original.status, "done");
    const proposed = distillWorkflow(trace, "source", "trace.sqlite", "browser");
    assert.ok(proposed);
    // A1 探索实际走 v2 蒸馏（boundTo 局限曾使非输入步骤 URL 条件不参数化）——两条蒸馏路径都必须参数化。
    const proposedV2 = distillWorkflowV2(trace, "source", "trace.sqlite", "browser");
    assert.ok(proposedV2);
    const urlStep = proposed.steps.find((step) => step.successCondition.kind === "url_includes"
      && step.successCondition.value.startsWith("/wiki/"));
    assert.ok(urlStep);
    assert.ok(urlStep.successCondition.kind === "url_includes");
    assert.equal(urlStep.successCondition.value, "/wiki/{{input1}}");
    const urlStepV2 = proposedV2.steps.find((step) => step.successCondition.kind === "url_includes"
      && step.successCondition.value.startsWith("/wiki/"));
    assert.ok(urlStepV2);
    assert.ok(urlStepV2.successCondition.kind === "url_includes");
    assert.equal(urlStepV2.successCondition.value, "/wiki/{{input1}}");
    const typeStep = proposed.steps.find((step) => step.action.kind === "type");
    assert.ok(typeStep);
    assert.ok(typeStep.successCondition.kind === "accessibility_includes");
    assert.equal(typeStep.successCondition.value, "{{input1}}");
    const candidate = store.addCandidate(proposed);
    const match = selectWorkflow(store.list("browser"), "在维基百科搜索 香蕉 并打开条目", true);
    assert.ok(match);
    const instantiated = instantiateWorkflow(match);
    assert.equal((instantiated.steps.find((step) => step.action.kind === "type")!
      .action as { text: string }).text, "香蕉");
    assert.equal(instantiated.successConditions.pageTextIncludes, "香蕉");
    const runtime = new WikiSearchRuntime();
    const replay = new WorkflowReplayModel(instantiated, new ScriptModel([]));
    const result = await createAgentLoop({ model: replay, runtime, trace })
      .invoke(initialState("replay", "在维基百科搜索 香蕉 并打开条目", undefined,
        instantiated.successConditions));
    assert.equal(result.status, "done");
    assert.equal(replay.mode, "replay");
    assert.ok(runtime.executed.some((action) => action.kind === "type" &&
      (action as { text: string }).text === "香蕉"));
    assert.ok(trace.metrics("replay").filter((metric) => metric.node === "decide")
      .every((metric) => metric.actor === "rule"));
    assert.equal(trace.metrics("replay").filter((metric) => metric.node === "decide"
      && metric.actor === "model").length, 0);
  } finally { trace.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
