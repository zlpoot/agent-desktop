import { Command } from "@langchain/langgraph";
import type { RuntimeAdapter } from "../runtime/runtime-adapter.js";
import type { createAgentLoop } from "./graph.js";
import type { ComputerState } from "./state.js";

export type HumanResponse = { approved: boolean } | { answer: string };

export async function resumeSavedTask(
  graph: ReturnType<typeof createAgentLoop>, runtime: RuntimeAdapter,
  taskId: string, response: HumanResponse, checkpointThreadId = taskId,
): Promise<ComputerState> {
  const config = { configurable: { thread_id: checkpointThreadId } };
  const snapshot = await graph.getState(config);
  const state = snapshot.values as ComputerState;
  const pendingQuestion = state.status === "running" && state.lastAction?.kind === "ask_user";
  if (!snapshot.tasks.length || state.taskId !== taskId ||
      (state.status !== "waiting_user" && !pendingQuestion)) {
    throw new Error(`任务 ${taskId} 没有等待处理的人工中断`);
  }
  if (!state.observation) throw new Error(`任务 ${taskId} 缺少恢复所需的页面观察`);
  if (!runtime.restore) throw new Error("运行时不支持页面恢复");
  await runtime.restore(state.observation);
  return graph.invoke(new Command({ resume: response }), config);
}

/** 主动暂停后不恢复旧动作；Graph 的 pause_interrupt 会先重新观察。 */
export async function continuePausedTask(
  graph: ReturnType<typeof createAgentLoop>, taskId: string, checkpointThreadId = taskId,
  runtime?: RuntimeAdapter,
): Promise<ComputerState> {
  const config = { configurable: { thread_id: checkpointThreadId } };
  const snapshot = await graph.getState(config);
  const state = snapshot.values as ComputerState;
  if (state.taskId !== taskId || state.status !== "paused" || !snapshot.tasks.length) {
    throw new Error(`任务 ${taskId} 未处于可继续的暂停状态`);
  }
  // A restarted browser may open at about:blank. Restore the saved location
  // before the mandatory fresh observation; this never replays the old action.
  if (runtime?.restore && state.observation) await runtime.restore(state.observation);
  return graph.invoke(new Command({ resume: { kind: "continue" } }), config);
}
