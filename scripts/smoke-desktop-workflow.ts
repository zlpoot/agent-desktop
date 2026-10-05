import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { configuredModel } from "../src/agent/local-config.js";
import { runTaskAgent } from "../src/agent/task-agent.js";
import { DesktopRuntime } from "../src/runtime/desktop/desktop-runtime.js";
import { WindowManager } from "../src/runtime/desktop/window-manager.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";
import { WorkflowStore } from "../src/workflows/store.js";

const dir = resolve(".artifacts", "desktop-workflow-smoke", randomUUID());
await mkdir(dir, { recursive: true });
const exe = resolve(".artifacts", "desktop-fixture.exe");
const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const compiled = spawnSync(compiler, ["/nologo", "/target:winexe", `/out:${exe}`,
  "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll",
  resolve("scripts/desktop-fixture.cs")], { encoding: "utf8" });
if (compiled.status !== 0) throw new Error(`测试窗口编译失败：${compiled.stdout}${compiled.stderr}`);
const suffix = randomUUID();
const fixture = spawn(exe, [suffix], { windowsHide: false, stdio: "ignore" });
const tracePath = resolve(dir, "trace.sqlite");
const trace = new SqliteTrace(tracePath);
const workflows = new WorkflowStore(resolve(dir, "workflows.sqlite"));
try {
  for (const value of ["苹果", "香蕉"]) {
    const manager = new WindowManager(resolve(dir, value));
    const runtime: DesktopRuntime = await manager.attach({
      windowTitle: `Computer Use M5 验证窗口 ${suffix}` }, 10000);
    try {
      await manager.focus(runtime);
      const { model } = configuredModel({ environment: "desktop" });
      const taskId = randomUUID();
      const result = await runTaskAgent({ taskId, goal: `在当前测试窗口输入 ${value}，点击处理，确认显示 已处理：${value}`,
        environment: "windows", completionCriteria: { pageTextIncludes: `已处理：${value}` } },
      { runtime, exploreModel: model, trace, tracePath, workflowStore: workflows, maxSteps: 12 });
      console.log(JSON.stringify({ value, taskId, status: result.state.status,
        mode: result.mode, workflowUsed: result.workflowUsed, workflowCreated: result.workflowCreated,
        steps: result.state.step, error: result.state.error,
        modelCalls: trace.metrics(taskId).filter((metric) => metric.actor === "model").length }));
      if (result.state.status !== "done") process.exitCode = 1;
    } finally { await runtime.close(); }
  }
  console.log(`轨迹目录：${dir}`);
} finally {
  workflows.close(); trace.close(); fixture.kill();
}
