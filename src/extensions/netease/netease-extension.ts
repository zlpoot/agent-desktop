import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { resolveCapability, requireCapability, type CapabilityFacts } from "../../capabilities/registry.js";
import type { AgentExtension, SpecializedTaskCapability } from "../../contracts/extension.js";
import type { TaskRequest } from "../../contracts/task.js";
import { createAgentLoop } from "../../graph/graph.js";
import { resumeSavedTask } from "../../graph/resume.js";
import { initialState } from "../../graph/state.js";
import { DesktopRuntime } from "../../runtime/desktop/desktop-runtime.js";
import { WindowManager } from "../../runtime/desktop/window-manager.js";
import { SqliteTrace } from "../../trace/sqlite-trace.js";
import { FacetRegistry } from "../../contracts/facets.js";
import { ContributorRegistry } from "../../contracts/verifier-contributor.js";
import { createDomainEvaluator } from "../../verification/domain-evaluator.js";
import { MusicModel, type MusicSelection } from "./music-model.js";
import { deriveMusicPlayback, musicContributor, musicFacetProvider } from "./music-facet.js";

/** 网易云播放目标解析；neteease.play 专用能力持有，核心不识别歌曲业务。 */
export function parseMusicRequest(goal: string): MusicSelection {
  if (typeof goal !== "string" || goal.length > 300 || !/网易云/.test(goal)) {
    throw new Error("目前支持网易云音乐播放任务，例如：打开网易云播放稻香");
  }
  const match = goal.match(/播放\s*(?:歌曲\s*)?(.+)$/);
  if (!match) throw new Error("请写明要播放的歌曲，例如：打开网易云播放稻香");
  const requested = match[1].trim().replace(/^[《“"']+|[》”"'。！!\s]+$/g, "");
  if (!requested || requested.length > 80) throw new Error("歌曲名为空或过长");
  const parts = requested.split(/的/);
  const title = parts.length > 1 ? parts.at(-1)!.trim() : requested;
  if (!title) throw new Error("无法识别歌曲名");
  return { search: parts.length > 1 ? parts.join(" ") : requested, title,
    ...(parts.length > 1 ? { artist: parts.slice(0, -1).join("的").trim() } : {}) };
}

/** 网易云播放扩展：专用能力 + 独立执行器，通过注册表被核心发现。 */
export function createNeteaseExtension(options: { rootDir: string; appPath?: string }): AgentExtension {
  const tracePath = resolve(options.rootDir, "web-tasks.sqlite");
  const configuredPath = options.appPath ?? process.env.NETEASE_APP_PATH;
  function appPath(): string {
    if (!configuredPath) throw new Error('Set NETEASE_APP_PATH before desktop execution');
    return resolve(configuredPath);
  }

  async function attachMusic(taskId: string): Promise<DesktopRuntime> {
    const manager = new WindowManager(resolve(options.rootDir, ".artifacts", "web-tasks",
      taskId, "screenshots"));
    return manager.ensure({ windowClass: "OrpheusBrowserHost", processPath: appPath() },
      appPath(), [], 10000);
  }

  async function runMusic(taskId: string,
    answer?: { approved?: boolean; answer?: string }): Promise<void> {
    const trace = new SqliteTrace(tracePath);
    let runtime: DesktopRuntime | undefined;
    let checkpoint: ReturnType<typeof SqliteSaver.fromConnString> | undefined;
    try {
      appPath();
      const state = trace.load(taskId);
      if (!state) throw new Error("任务记录不存在");
      const model = new MusicModel(parseMusicRequest(state.goal));
      runtime = answer && state.observation?.windowHandle
        ? await DesktopRuntime.attach({ windowHandle: state.observation.windowHandle,
          artifactDir: resolve(options.rootDir, ".artifacts", "web-tasks", taskId, "screenshots") })
        : await attachMusic(taskId);
      const observation = await runtime.observe();
      const probe = await runtime.probe();
      const facts: CapabilityFacts = { deterministicIntent: true, windowDiscovered: true,
        windowAttached: true, uiaControls: probe.uiaControls,
        screenshotAvailable: !!observation.screenshot, templateAvailable: false,
        unrealWindow: probe.windowClass === "UnrealWindow",
        mediaObservable: deriveMusicPlayback(observation.windowTitle, observation.accessibility)
          || observation.dom?.includes("btn_pc_minibar_") ? true : undefined,
        completionCriteria: true };
      for (const operation of ["attach", "observe", "locate", "act", "choose", "verify"] as const) {
        const resolution = resolveCapability(operation, "windows", facts);
        trace.recordCapabilityResolution(taskId, state.step, "窗口检查", resolution, facts);
        if (operation !== "verify") requireCapability(resolution);
      }
      const dir = resolve(options.rootDir, ".artifacts", "web-tasks", taskId);
      await mkdir(dir, { recursive: true });
      checkpoint = SqliteSaver.fromConnString(resolve(dir, "checkpoints.sqlite"));
      // 专用执行器自带 graph 时，也要注入同一套 music.netease facet 与域验收，否则终态只能 UNKNOWN。
      const facetRegistry = new FacetRegistry();
      facetRegistry.register(musicFacetProvider);
      const contributorRegistry = new ContributorRegistry();
      contributorRegistry.register(musicContributor);
      const domainEvaluator = createDomainEvaluator(contributorRegistry, facetRegistry);
      const graph = createAgentLoop({ model, runtime, trace, checkpointer: checkpoint,
        maxSteps: 24, maxRetries: 2,
        facetProviders: [musicFacetProvider], domainEvaluator });
      if (answer) await resumeSavedTask(graph, runtime, taskId,
        answer.answer ? { answer: answer.answer } : { approved: answer.approved === true });
      else await graph.invoke(state, { configurable: { thread_id: taskId } });
      const finalState = trace.load(taskId);
      if (finalState) {
        const finalObservation = finalState.observation;
        const finalPlayback = finalObservation
          ? deriveMusicPlayback(finalObservation.windowTitle, finalObservation.accessibility)
          : undefined;
        const finalFacts = { ...facts,
          mediaObservable: finalPlayback || finalObservation?.facets?.["music.netease"] ? true : undefined };
        trace.recordCapabilityResolution(taskId, finalState.step, "结果检查",
          resolveCapability("verify", "windows", finalFacts), finalFacts);
      }
    } catch (error) {
      const state = trace.load(taskId);
      if (state) trace.save("task_error", { ...state, status: "failed", error: String(error) });
    } finally {
      await runtime?.close();
      checkpoint?.db.close();
      trace.close();
    }
  }

  const capability: SpecializedTaskCapability = {
    id: "netease.play",
    matches: (goal) => /网易云/.test(goal) && /播放/.test(goal),
    prepare(goal, options) {
      if (options.admin) throw new Error("管理员权限开关仅适用于《异环》音量任务");
      const music = parseMusicRequest(goal);
      return { kind: "specialized", environment: "windows", goal,
        plan: ["打开网易云音乐", `搜索 ${music.search}`, `播放 ${music.title}`, "核验歌曲与播放状态"],
        completionCriteria: { domainChecks: [
          { domain: "music.netease", predicate: "titleIncludes", args: { includes: music.title } },
          ...(music.artist ? [{ domain: "music.netease" as const, predicate: "artistIncludes" as const,
            args: { includes: music.artist } }] : []),
          { domain: "music.netease", predicate: "playing", args: { equals: true } },
        ] },
        facts: { deterministicIntent: true, unrealWindow: false, templateAvailable: false,
          completionCriteria: true },
        operations: ["attach", "observe", "locate", "act", "choose", "verify"] } satisfies TaskRequest;
    },
    submit(request, enqueue) {
      const taskId = randomUUID();
      const trace = new SqliteTrace(tracePath);
      try {
        trace.save("queued", { ...initialState(taskId, request.goal, request.plan,
          request.completionCriteria), executorId: capability.id,
          summary: `已选择 ${capability.id} 专用能力` });
        for (const operation of request.operations) {
          const resolution = resolveCapability(operation, "windows", request.facts);
          trace.recordCapabilityResolution(taskId, 0, "提交前检查", resolution, request.facts);
          if (operation === "choose") requireCapability(resolution);
        }
      } finally { trace.close(); }
      enqueue(() => runMusic(taskId));
      return taskId;
    },
    resume(taskId, response, enqueue) {
      enqueue(() => runMusic(taskId, response));
    },
  };

  return { id: "netease.play", name: "网易云播放", capabilities: [capability],
    facets: [musicFacetProvider], contributors: [musicContributor] };
}
