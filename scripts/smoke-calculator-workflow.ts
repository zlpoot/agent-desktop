import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { configuredModel } from "../src/agent/local-config.js";
import { runTaskAgent } from "../src/agent/task-agent.js";
import { DesktopRuntime } from "../src/runtime/desktop/desktop-runtime.js";
import { WindowManager } from "../src/runtime/desktop/window-manager.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";
import { WorkflowStore } from "../src/workflows/store.js";

const dir = resolve(".artifacts", "calculator-workflow-smoke", randomUUID());
await mkdir(dir, { recursive: true });
const manager = new WindowManager(resolve(dir, "screenshots"));
if (!(await manager.list({ windowTitle: "计算器" })).length) {
  const app = spawn("C:\\Windows\\System32\\calc.exe", [], { windowsHide: false, stdio: "ignore" });
  app.unref();
}
const window = await manager.waitFor({ windowTitle: "计算器" }, 10000);
const tracePath = resolve(dir, "trace.sqlite");
const trace = new SqliteTrace(tracePath);
const workflows = new WorkflowStore(resolve(dir, "workflows.sqlite"));
try {
  for (const index of [1, 2, 3]) {
    const runtime: DesktopRuntime = await DesktopRuntime.attach({ windowHandle: window.handle,
      artifactDir: resolve(dir, `run-${index}`) });
    try {
      await manager.focus(runtime);
      const cleared = await runtime.execute({ kind: "click", target: { kind: "role", role: "Button", name: "清除" } });
      if (!cleared.ok || !((await runtime.observe()).accessibility ?? "").includes("显示为 0")) {
        throw new Error("计算器未回到 0，不能开始可比较的回放测试");
      }
      const { model } = configuredModel({ environment: "desktop" });
      const taskId = randomUUID();
      const goal = index === 3 ? "帮我用计算器算出 12 + 34 = 46" : "在计算器计算 12 加 34，看到结果 46";
      const result = await runTaskAgent({ taskId, goal,
        environment: "windows", completionCriteria: { accessibilityIncludes: "显示为 46" } },
      { runtime, exploreModel: model, trace, tracePath, workflowStore: workflows, maxSteps: 16 });
      const metrics = trace.metrics(taskId);
      console.log(JSON.stringify({ index, taskId, status: result.state.status, mode: result.mode,
        error: result.state.error, steps: result.state.step, workflowUsed: result.workflowUsed,
        workflowCreated: result.workflowCreated,
        modelCalls: metrics.filter((metric) => metric.actor === "model").length,
        decisionCalls: metrics.filter((metric) => metric.node === "decide" && metric.actor === "model").length,
        tokens: metrics.reduce((sum, metric) => sum + (metric.totalTokens ?? 0), 0) }));
      if (result.state.status !== "done") process.exitCode = 1;
    } finally { await runtime.close(); }
  }
  console.log(`轨迹目录：${dir}`);
} finally { workflows.close(); trace.close(); }
