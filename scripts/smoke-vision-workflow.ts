import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { configuredModel } from "../src/agent/local-config.js";
import { runTaskAgent } from "../src/agent/task-agent.js";
import { DesktopRuntime } from "../src/runtime/desktop/desktop-runtime.js";
import { DesktopVisionRuntime } from "../src/runtime/desktop/vision-runtime.js";
import { WindowManager } from "../src/runtime/desktop/window-manager.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";
import { WorkflowStore } from "../src/workflows/store.js";

const dir = resolve(".artifacts", "vision-workflow-smoke", randomUUID());
await mkdir(dir, { recursive: true });
const exe = resolve(".artifacts", "vision-fixture.exe");
const compiled = spawnSync("C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
  ["/nologo", "/target:winexe", `/out:${exe}`, "/reference:System.Windows.Forms.dll",
    "/reference:System.Drawing.dll", resolve("scripts/vision-fixture.cs")], { encoding: "utf8" });
if (compiled.status !== 0) throw new Error(`测试应用编译失败：${compiled.stdout}${compiled.stderr}`);
const suffix = randomUUID();
const tracePath = resolve(dir, "trace.sqlite");
const trace = new SqliteTrace(tracePath);
const workflows = new WorkflowStore(resolve(dir, "workflows.sqlite"));
try {
  for (const index of [1, 2]) {
    const fixture = spawn(exe, [suffix], { windowsHide: false, stdio: "ignore" });
    let runtime: DesktopVisionRuntime | undefined;
    try {
      const manager = new WindowManager(resolve(dir, `run-${index}`));
      const desktop: DesktopRuntime = await manager.attach({
        windowTitle: `Computer Use 视觉验证窗口 ${suffix}` }, 10000);
      await manager.focus(desktop);
      const { model } = configuredModel({ environment: "desktop", visualMode: true });
      runtime = new DesktopVisionRuntime(desktop, model);
      const taskId = randomUUID();
      const result = await runTaskAgent({ taskId, goal: "在当前自绘测试窗口打开设置页面，看到设置页面文字",
        environment: "windows", completionCriteria: { pageTextIncludes: "设置页面" } },
      { runtime, exploreModel: model, trace, tracePath, workflowStore: workflows, maxSteps: 8 });
      const metrics = trace.metrics(taskId);
      console.log(JSON.stringify({ index, taskId, status: result.state.status, mode: result.mode,
        workflowUsed: result.workflowUsed, workflowCreated: result.workflowCreated,
        error: result.state.error, steps: result.state.step,
        decisionCalls: metrics.filter((metric) => metric.node === "decide" && metric.actor === "model").length,
        visualCalls: metrics.filter((metric) => ["observe", "ground"].includes(metric.node) &&
          metric.actor === "model").length,
        tokens: metrics.reduce((sum, metric) => sum + (metric.totalTokens ?? 0), 0) }));
      if (result.state.status !== "done") process.exitCode = 1;
    } finally {
      await runtime?.close(); fixture.kill();
      await new Promise((done) => setTimeout(done, 300));
    }
  }
  console.log(`轨迹目录：${dir}`);
} finally { workflows.close(); trace.close(); }
