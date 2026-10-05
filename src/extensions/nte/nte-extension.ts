import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { resolveCapability, requireCapability } from "../../capabilities/registry.js";
import type { AgentExtension, SpecializedTaskCapability } from "../../contracts/extension.js";
import type { TaskRequest } from "../../contracts/task.js";
import { initialState } from "../../graph/state.js";
import { SqliteTrace } from "../../trace/sqlite-trace.js";

/** 《异环》音量目标校验；nte.volume.50 专用能力持有。 */
export function isNteVolumeRequest(goal: string): boolean {
  return /异环/.test(goal) && /音量/.test(goal) && /50\s*[%％]?/.test(goal) &&
    (goal.match(/\d+/g) ?? []).every((number) => number === "50");
}

/** 《异环》音量扩展：只接受固定的 50 音量目标，且要求显式管理员开关。 */
export function createNteExtension(options: { rootDir: string }): AgentExtension {
  const tracePath = resolve(options.rootDir, "web-tasks.sqlite");

  async function launchNteElevated(taskId: string): Promise<void> {
    const script = resolve(options.rootDir, "scripts", "start-nte-elevated.ps1");
    const exitCode = await new Promise<number>((done, fail) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", script, "-TaskId", taskId], { cwd: options.rootDir, windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
      child.on("error", fail);
      child.on("close", (code) => {
        if (code === 0) done(0);
        else fail(new Error(stderr.trim() ||
          `管理员权限测试未完成（退出码 ${code ?? "未知"}）；请查看 Windows UAC 确认`));
      });
    }).catch((error) => {
      const trace = new SqliteTrace(tracePath);
      try {
        const state = trace.load(taskId);
        if (state?.status === "running") trace.save("task_error", { ...state, status: "failed", error: String(error) });
      } finally { trace.close(); }
      return 1;
    });
    if (exitCode === 0) {
      const trace = new SqliteTrace(tracePath);
      try {
        const state = trace.load(taskId);
        if (state?.status === "running") trace.save("task_error", { ...state, status: "failed",
          error: "管理员进程已退出，但未写入完成结果" });
      } finally { trace.close(); }
    }
  }

  const capability: SpecializedTaskCapability = {
    id: "nte.volume.50",
    priority: 10,
    matches: isNteVolumeRequest,
    prepare(goal, options) {
      if (!options.admin) throw new Error("《异环》需要管理员权限：请勾选开关，并在 Windows UAC 弹窗中确认");
      return { kind: "specialized", environment: "windows", goal,
        plan: ["识别已打开的《异环》窗口", "打开游戏菜单和设置页", "进入声音设置", "将主音量设为 50", "截图核验显示 50"],
        facts: { deterministicIntent: true, unrealWindow: true, uiaControls: false,
          templateAvailable: true, mediaObservable: false },
        operations: ["attach", "observe", "locate", "act", "choose", "verify"] } satisfies TaskRequest;
    },
    submit(request, enqueue) {
      const taskId = randomUUID();
      const trace = new SqliteTrace(tracePath);
      try {
        trace.save("queued", { ...initialState(taskId, request.goal, request.plan,
          request.completionCriteria), executorId: capability.id,
          summary: `已选择 ${capability.id}；等待 Windows 管理员权限确认` });
        for (const operation of request.operations) {
          const resolution = resolveCapability(operation, "windows", request.facts);
          trace.recordCapabilityResolution(taskId, 0, "提交前检查", resolution, request.facts);
          if (operation === "choose") requireCapability(resolution);
        }
      } finally { trace.close(); }
      enqueue(() => launchNteElevated(taskId));
      return taskId;
    },
  };

  return { id: "nte.volume.50", name: "《异环》音量", capabilities: [capability] };
}
