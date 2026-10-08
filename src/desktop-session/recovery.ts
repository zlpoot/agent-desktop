import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { SqliteTrace } from "../trace/sqlite-trace.js";
import type { ComputerState } from "../graph/state.js";

/** Startup only: persist interrupted tasks as paused, without scheduling any work. */
export function recoverDesktopTasks(rootDir: string): void {
  const trace = new SqliteTrace(resolve(rootDir, "web-tasks.sqlite"));
  try {
    for (const saved of trace.unfinishedDesktopTasks()) {
      trace.save("host_restart", { ...saved, status: "paused", recoveryRequired: true,
        ...(saved.appOnboarding ? { appOnboarding: {
          ...saved.appOnboarding, state: 'new_task_required' as const, candidates: [],
          reason: 'Host 已重启；应用配置成果保留，请新建 Task' } } : {}),
        recoveryUncertain: saved.desktopScenario && saved.desktopScenarioDispatched ? true : saved.recoveryUncertain,
        summary: saved.desktopScenario ? "Host 已重启；有限场景禁止自动重放，请显式提交新任务" :
          saved.appOnboarding ? 'Host 已重启；应用配置成果保留，旧 Session 不复用，请新建 Task' :
          "Host 已重启；任务现场与检查点保留，点击继续后重新观察", error: undefined });
      trace.clearPause(saved.taskId);
    }
  } finally { trace.close(); }
}

/** A new checkpoint thread avoids replaying a possibly dispatched old graph node. */
export function restartedDesktopState(saved: ComputerState): ComputerState {
  const uncertain = !!saved.inFlightAction || saved.recoveryUncertain === true ||
    (saved.verificationPending === true && saved.lastResult?.effect !== "none");
  const replay = saved.workflowReplayState;
  const from = saved.checkpointThreadId ?? saved.taskId;
  const to = `${saved.taskId}:recovery:${randomUUID()}`;
  return { ...saved, checkpointThreadId: to,
    checkpointLineage: [...(saved.checkpointLineage ?? []), { from, to, at: new Date().toISOString() }],
    status: "running", recoveryRequired: false, recoveryUncertain: uncertain,
    workflowReplayState: replay?.activeIndex !== undefined && !uncertain && !saved.lastResult
      ? { ...replay, nextIndex: replay.activeIndex, activeIndex: undefined } : replay,
    resumeReconcile: true, observation: undefined, beforeObservation: undefined,
    observationFailed: false, verificationPending: false, resumePendingAction: false,
    lastAction: undefined, groundedAction: undefined, targetBinding: undefined,
    actionResolution: undefined, lastResult: undefined, lastVerification: undefined,
    goalVerification: undefined, approvedActionFingerprint: undefined,
    approvalContextUrl: undefined, approvalContextSignature: undefined,
    inFlightAction: uncertain ? saved.inFlightAction ?? saved.lastAction : undefined,
    // A process restart does not grant a fresh retry budget for the same action.
    retryCount: saved.retryCount, focusRecoveryCount: 0,
    summary: "重启恢复：重新观察与状态对齐，旧动作不重放", error: undefined };
}
