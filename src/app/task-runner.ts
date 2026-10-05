import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { ModelAdapter } from "../agent/model-adapter.js";
import { configuredModelProvider } from "../agent/local-config.js";
import { StageWorkflowModel } from "../agent/stage-workflow-model.js";
import { runTaskAgent } from "../agent/task-agent.js";
import { createAgentLoop } from "../graph/graph.js";
import {writeHostShadow} from '../verification/host-shadow.js';
import {configuredLiveShadow} from '../verification/live-shadow.js';
import { continuePausedTask, resumeSavedTask } from "../graph/resume.js";
import { initialState } from "../graph/state.js";
import { DesktopRuntime } from "../runtime/desktop/desktop-runtime.js";
import { GuestDesktopRuntime } from "../runtime/desktop/guest-runtime.js";
import { restartedDesktopState } from "../desktop-session/recovery.js";
import { DesktopVisionRuntime } from "../runtime/desktop/vision-runtime.js";
import { WindowManager } from "../runtime/desktop/window-manager.js";
import { registeredApps, registeredGuestApps } from "../runtime/desktop/app-catalog.js";
import { PlaywrightRuntime } from "../runtime/browser/playwright-runtime.js";
import { SqliteTrace } from "../trace/sqlite-trace.js";
import { WorkflowStore } from "../workflows/store.js";
import { distillWorkflow } from "../workflows/distill.js";
import { instantiateWorkflow, selectWorkflow } from "../workflows/matcher.js";
import { WorkflowReplayModel } from "../workflows/replay-model.js";
import { resolveCapability, requireCapability, type CapabilityFacts } from "../capabilities/registry.js";
import { ExtensionRegistry } from "../contracts/extension.js";
import type { InputControl } from "../contracts/desktop-provider.js";
import type { ModelProvider } from "../contracts/model-provider.js";
import type { TraceStore, WorkflowStore as WorkflowStoreContract } from "../contracts/stores.js";
import type { WorkerClient, WorkerClientFactory } from "../contracts/worker-client.js";
import { routeTask } from "./task-routing.js";
import { taskContract, taskProfile } from "./task-profiles.js";
import { WorkerConnectionError, GuestAppSetupError } from "../contracts/worker-error.js";
import { reconcileWorkflow } from "../workflows/recovery.js";
import { prepareWorkflowExecution, explicitReplaySucceeded, stageReplaySucceeded, explicitWorkflowWindow,
  explicitWorkflowUsesStructuredTargets, routeWorkflowDestination, type WorkflowExecutionRequest } from '../workflows/execution.js';
import { reviewManualOutcome } from '../verification/manual-review.js';
import { auditTaskContractCoverage } from '../verification/task-contract-coverage.js';
import { desktopFileExpectationsFromGoal } from '../verification/goal-file-coverage.js';
import { createTaskBudget, isBudgetExceeded, parseBudgetOverride, readTaskBudget, runWithTaskBudget,
  type BudgetOverride } from '../runtime/model-budget.js';

export interface TaskController {
  submitWorkflow?(request: WorkflowExecutionRequest, budget?: BudgetOverride): string;
  submit(goal: string, options?: { admin?: boolean; budget?: BudgetOverride }): string;
  resume(taskId: string, response: { approved?: boolean; answer?: string }): void;
  pause(taskId: string): void;
  continue(taskId: string): void;
  reviewOutcome?(taskId: string, response: { approved: boolean; note: string }): Promise<void>;
}

/** 任务执行器的显式依赖；核心不直接读取全局配置或创建业务扩展。 */
export interface DesktopTaskControllerOptions {
  acceptanceVerifier?: import('../verifier/hybrid-verifier.js').AcceptanceVerifier;
  /** 业务扩展注册表；不传则使用空注册表（全部业务禁用，通用任务仍可运行）。 */
  registry?: ExtensionRegistry;
  modelProvider?: ModelProvider;
  traceStore?: (path: string) => TraceStore;
  workflowStore?: (path: string) => WorkflowStoreContract;
  workerClientFactory?: WorkerClientFactory;
  /** 扩展 facet provider，观察后采集域证据；不传则不产出任何业务 facet。 */
  facetProviders?: import("../contracts/facets.js").ObservationFacetProvider[];
  /** 域条件求值器；不传时 domainChecks 一律 UNKNOWN（fail-closed）。 */
  domainEvaluator?: import("../verification/domain-evaluator.js").DomainEvaluator;
}

export class DesktopTaskController implements TaskController {
  private queue = Promise.resolve();
  private readonly continuing = new Set<string>();
  private readonly tracePath: string;
  private readonly registry: ExtensionRegistry;
  private readonly modelProvider: ModelProvider;
  private readonly traceStore: (path: string) => TraceStore;
  private readonly workflowStore: (path: string) => WorkflowStoreContract;
  private readonly workerClientFactory: WorkerClientFactory;
  private desktopControl?: InputControl;
  private desktopControlOwner?: string;
  private desktopRequired = false;
  private readonly retiredControls = new WeakSet<InputControl>();
  private activeTask?: { id: string; control?: InputControl; done: Promise<void> };
  /**
   * 绑定任务控制到本控制器；owner 用于多 Session 场景下区分归属。
   * 传入 undefined 仅当 owner 匹配当前绑定（或未指定 owner）时才清空，
   * 避免卸载一个 Session 误清另一个 Session 的任务控制绑定。
   */
  setDesktopControl(control: InputControl | undefined, owner?: string): void {
    if (control === undefined) {
      if (owner === undefined || this.desktopControlOwner === undefined ||
          this.desktopControlOwner === owner) {
        this.desktopControl = undefined;
        this.desktopControlOwner = undefined;
      }
      return;
    }
    this.desktopControl = control;
    this.desktopControlOwner = owner;
    this.desktopRequired = true;
  }
  /** Keep a running task's control alive until it reaches its existing pause boundary. */
  async releaseDesktopControl(control: InputControl, owner: string): Promise<void> {
    this.retiredControls.add(control);
    const active = this.activeTask;
    try {
      if (active?.control === control) {
        try { this.requestShutdownPause(active.id); }
        finally { await active.done; }
      }
    } finally { this.setDesktopControl(undefined, owner); }
  }
  private requestShutdownPause(taskId: string) {
    const trace = this.traceStore(this.tracePath);
    try { trace.requestPause(taskId); } finally { trace.close(); }
  }
  private taskControl(): InputControl | undefined {
    const control = this.desktopControl;
    if (this.desktopRequired && (!control || this.retiredControls.has(control))) {
      throw new Error("Desktop Session 正在关闭或已卸载");
    }
    return control;
  }
  /** 只读：当前任务控制绑定（测试与装配层观察用）。 */
  getDesktopControl(): InputControl | undefined { return this.desktopControl; }
  private closed = false;
  private closePromise?: Promise<void>;
  /**
   * 关闭控制器（异步）：
   * 1. 置 closed：拒绝新的提交/恢复/暂停/继续；
   * 2. 所有排队任务在统一入口取消；运行中的桌面任务请求安全边界暂停；
   * 3. 等待队列链结束，随后调用方才能安全释放
   *    任务依赖的资源（模型提供方、Worker 工厂等）。
   * 幂等且可重复调用。
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      try { if (this.activeTask?.control) this.requestShutdownPause(this.activeTask.id); }
      finally { await this.queue; }
    })();
    return this.closePromise;
  }
  private assertOpen() {
    if (this.closed) throw new Error("任务控制器已关闭，不再接受新任务");
  }

  constructor(private readonly rootDir: string, private readonly options: DesktopTaskControllerOptions = {}) {
    this.tracePath = resolve(rootDir, "web-tasks.sqlite");
    this.registry = options.registry ?? new ExtensionRegistry();
    this.modelProvider = options.modelProvider ?? configuredModelProvider();
    this.traceStore = options.traceStore ?? ((path) => new SqliteTrace(path));
    this.workflowStore = options.workflowStore ?? ((path) => new WorkflowStore(path));
    this.workerClientFactory = options.workerClientFactory ?? GuestDesktopRuntime.connect;
  }

  submit(goal: string, options: { admin?: boolean; budget?: BudgetOverride } = {}): string {
    this.assertOpen();
    const budget = parseBudgetOverride(options.budget);
    const route = routeTask(goal, options, this.registry);
    if (route.kind === "generic") return this.submitGeneric(route.goal, undefined, budget);
    if (budget) throw new Error('专用能力任务暂不支持预算覆盖');
    // submit is synchronous; the queued microtask sees the returned persistent ID.
    let taskId: string;
    taskId = route.capability.submit(route.request, (task) => this.enqueue(task, () => taskId));
    return taskId;
  }

  submitWorkflow(request: WorkflowExecutionRequest, budget?: BudgetOverride): string {
    this.assertOpen();
    if (!this.taskControl()) throw new Error('未配置 Desktop Session，不能执行指定流程');
    const store = this.workflowStore(resolve(this.rootDir, 'workflows.sqlite'));
    try {
      const prepared = prepareWorkflowExecution(store.get(request.id, request.version), request);
      return this.submitGeneric(prepared.goal, prepared.ref, parseBudgetOverride(budget));
    } finally { store.close(); }
  }

  private routeDb(): DatabaseSync {
    const db = new DatabaseSync(resolve(this.rootDir, "web-task-routes.sqlite"));
    db.exec(`CREATE TABLE IF NOT EXISTS generic_routes (
      task_id TEXT PRIMARY KEY, environment TEXT, window_handle INTEGER,
      created_at TEXT NOT NULL)`);
    return db;
  }

  private submitGeneric(goal: string, workflowRef?: import('../graph/state.js').ComputerState['workflowRef'],
    budget?: BudgetOverride): string {
    const control = /^VM:\s*\S/i.test(goal) ? this.taskControl() : undefined;
    control?.assertTaskAllowed();
    const contract = workflowRef ? undefined : taskContract(goal, taskProfile(goal, this.registry));
    const taskId = randomUUID();
    createTaskBudget(this.rootDir, taskId, budget);
    const db = this.routeDb();
    try { db.prepare(`INSERT INTO generic_routes (task_id, created_at) VALUES (?, ?)`)
      .run(taskId, new Date().toISOString()); }
    finally { db.close(); }
    const trace = this.traceStore(this.tracePath);
    try { trace.save("queued", { ...initialState(taskId, goal), ...(contract ? { taskContract: contract } : {}),
      ...(workflowRef ? { workflowRef } : {}), summary: workflowRef ? '已绑定指定流程，等待准备执行环境' : "等待模型规划任务" }); }
    finally { trace.close(); }
    this.enqueue(() => this.runGeneric(taskId, undefined, control), taskId, control);
    return taskId;
  }

  private async runGeneric(taskId: string, response?: { kind: "human";
    approved?: boolean; answer?: string } | { kind: "continue" } | { kind: "restart" },
    control?: InputControl): Promise<void> {
    // Historical tasks created before budgets existed receive a snapshot on first continuation.
    if (!readTaskBudget(this.rootDir, taskId)) createTaskBudget(this.rootDir, taskId);
    return runWithTaskBudget(this.rootDir, taskId, () => this.runGenericBody(taskId, response, control));
  }

  private async runGenericBody(taskId: string, response?: { kind: "human";
    approved?: boolean; answer?: string } | { kind: "continue" } | { kind: "restart" },
    control?: InputControl): Promise<void> {
    const trace = this.traceStore(this.tracePath);
    const workflows = this.workflowStore(resolve(this.rootDir, "workflows.sqlite"));
    let runtime: DesktopRuntime | WorkerClient | DesktopVisionRuntime | PlaywrightRuntime | undefined;
    let guest: WorkerClient | undefined;
    let desktopClaimed = false;
    const checkSetupPause = () => { if (desktopClaimed && trace.pauseRequested(taskId)) throw new Error("DESKTOP_SETUP_PAUSED"); };
    let checkpoint: ReturnType<typeof SqliteSaver.fromConnString> | undefined;
    try {
      const queued = trace.load(taskId);
      if (!queued) throw new Error("任务记录不存在");
      // 已排队但未开始的任务在控制器关闭后被取消，并落盘 failed（catch 分支写入）。
      if (this.closed) throw new Error("任务控制器已关闭，任务已取消");
      const db = this.routeDb();
      let route: { environment: string | null; window_handle: number | null } | undefined;
      try { route = db.prepare(`SELECT environment, window_handle FROM generic_routes WHERE task_id = ?`)
        .get(taskId) as typeof route; }
      finally { db.close(); }
      if (!route) throw new Error("缺少通用任务路由");
      const model = this.modelProvider.createModel();
      const savedForResume = response ? trace.load(taskId) : undefined;
      const savedWindowIdentity = savedForResume?.taskContract?.windowIdentity ??
        (savedForResume?.desktopBinding && savedForResume.observation?.windowTitle
          ? { title: savedForResume.observation.windowTitle,
              windowClass: savedForResume.desktopBinding.windowClass,
              processPath: savedForResume.desktopBinding.processPath }
          : undefined);
      const pinned = (savedForResume ?? queued).workflowRef;
      const pinnedWorkflow = pinned?.id ? workflows.get(pinned.id, pinned.version) : undefined;
      const explicit = pinned?.explicit && pinnedWorkflow ? prepareWorkflowExecution(pinnedWorkflow, {
        ...pinned, definitionHash: pinned.definitionHash ?? '',
        destination: routeWorkflowDestination(pinnedWorkflow),
      }) : undefined;
      let environment: "browser" | "windows";
      const guestTask = /^VM:\s*\S/i.test(queued.goal) || route.environment === "agent_desktop";
      if (guestTask) {
        if (savedForResume?.desktopVmId && savedForResume.desktopVmId !== process.env.AGENT_DESKTOP_VM_ID) {
          throw new Error("保存任务的 VM 身份不同；需重建环境并选择恢复策略，不能直接恢复旧窗口");
        }
        if (response?.kind === "restart" && (!savedWindowIdentity ||
          (!savedWindowIdentity.title && (!savedWindowIdentity.windowClass || !savedWindowIdentity.processPath)))) {
          throw new Error("检查点缺少稳定窗口身份，不能安全恢复；请停止旧任务后重新提交");
        }
        if (control) { await control.beginTask(taskId); desktopClaimed = true; }
        guest = await this.workerClientFactory(
          control?.workerEndpoint() ?? process.env.AGENT_DESKTOP_WORKER_URL ?? "http://127.0.0.1:8765",
          process.env.AGENT_DESKTOP_TOKEN ?? "", process.env.AGENT_DESKTOP_VM_ID ?? "",
          resolve(this.rootDir, ".artifacts", "web-tasks", taskId, "screenshots"), control?.agentEpoch?.());
      }
      let windowHandle: number | undefined;
      let desktopBinding = savedForResume?.desktopBinding;
      let plan = queued.plan;
      let completionCriteria = queued.completionCriteria;
      let verificationContract = queued.verificationContract;
      let contractCoverage = queued.contractCoverage;
      const dir = resolve(this.rootDir, ".artifacts", "web-tasks", taskId);
      await mkdir(dir, { recursive: true });
      if (!response) {
        const discovered = guest ? await guest.listWindows() : await DesktopRuntime.listWindows();
        const profile = taskProfile(queued.goal, this.registry);
        const windows = profile?.selectWindows?.(discovered) ?? discovered;
        const fixedWindow = guest && explicit ? explicitWorkflowWindow(explicit.workflow, windows) : undefined;
        if (fixedWindow && explicit) {
          environment = 'windows';
          windowHandle = fixedWindow.handle;
          plan = explicit.workflow.steps.map(step => step.goal);
          completionCriteria = explicit.workflow.successConditions;
          trace.recordNodeMetric(taskId, { step: 0, node: 'plan', startedAt: new Date().toISOString(),
            durationMs: 0, actor: 'rule', operator: '指定流程唯一窗口匹配' });
        } else {
          const apps = profile?.selectWindows ? [] : guest
            ? await registeredGuestApps(this.rootDir)
            : await registeredApps(this.rootDir);
          const startedAt = new Date().toISOString();
          const started = performance.now();
          let planned: Awaited<ReturnType<typeof model.planTask>>;
          try { planned = await model.planTask(queued.goal, windows, apps, profile?.completionCriteria); }
          catch (error) {
            trace.recordNodeMetric(taskId, { step: 0, node: "plan", startedAt,
              durationMs: performance.now() - started, actor: "model", operator: "任务规划失败",
              modelName: model.name,
              ...((error && typeof error === 'object' && 'usage' in error) ? error.usage as object : {}) });
            throw error;
          }
          trace.recordNodeMetric(taskId, { step: 0, node: "plan", startedAt,
            durationMs: performance.now() - started, actor: "model", operator: "任务规划",
            modelName: model.name, ...planned.usage });
          ({ environment, windowHandle, plan, completionCriteria, verificationContract } = planned.task);
          if (explicit) {
            plan = explicit.workflow.steps.map(step => step.goal);
            completionCriteria = explicit.workflow.successConditions;
            // The pinned Workflow definition owns its own verification contract.
            // Never expose the window-selection planner's unrelated conditions as the task contract.
            verificationContract = undefined;
          }
          if (environment === "windows" && planned.task.appId) {
            checkSetupPause();
            const app = apps.find((candidate) => candidate.id === planned.task.appId)!;
            const launchStartedAt = new Date().toISOString();
            const launchStarted = performance.now();
            if (guest) {
              windowHandle = (await guest.ensureApp(app.id)).handle;
            } else {
              const manager = new WindowManager(resolve(dir, "screenshots"));
              runtime = await manager.ensure({
                ...(app.windowTitle ? { windowTitle: app.windowTitle } : {}),
                ...(app.windowClass ? { windowClass: app.windowClass } : {}),
              }, app.executable, app.args);
              windowHandle = (await runtime.observe()).windowHandle;
            }
            if (windowHandle === undefined) throw new Error("启动应用后未取得窗口句柄");
            trace.recordNodeMetric(taskId, { step: 0, node: "app.ensure", startedAt: launchStartedAt,
              durationMs: performance.now() - launchStarted, actor: "runtime", operator: "windows.app.ensure" });
          }
        }
        if (guest && environment !== "windows") throw new Error("VM 任务必须规划为 Windows 窗口任务");
        if (profile?.environment && environment !== profile.environment) {
          throw new Error("任务规划环境与场景配置不符");
        }
        if (queued.taskContract) queued.taskContract.environment = environment;
        contractCoverage = auditTaskContractCoverage(queued.goal,completionCriteria,
          explicit?.ref.requiredFiles?.map(file=>file.path)
            ??desktopFileExpectationsFromGoal(queued.goal).map(file=>file.path));
        trace.save('contract_preflight',{...queued,plan,completionCriteria,verificationContract,
          contractCoverage,summary:contractCoverage.covered?'完成契约覆盖审计通过':
            `完成契约存在证据缺口，执行后需人工结果验收：${contractCoverage.reason}`});
        const registry = this.routeDb();
        try { registry.prepare(`UPDATE generic_routes SET environment = ?, window_handle = ?
          WHERE task_id = ?`).run(guest ? "agent_desktop" : environment, windowHandle ?? null, taskId); }
        finally { registry.close(); }
        trace.save("plan", { ...queued, plan, completionCriteria, verificationContract,contractCoverage,
          summary: `规划完成：${environment === "browser" ? "浏览器" : "Windows 应用"}` });
      } else {
        if (route.environment !== "browser" && route.environment !== "windows" &&
            route.environment !== "agent_desktop") {
          throw new Error("保存的任务环境无效");
        }
        environment = route.environment === "agent_desktop" ? "windows" : route.environment;
        windowHandle = route.window_handle ?? undefined;
      }
      runtime = runtime ?? (guest
        ? await (async () => {
            checkSetupPause();
            // A process restart invalidates the saved HWND/PID. Rebind by the
            // persisted semantic identity and let the Guest enforce uniqueness.
            await guest.attach(response?.kind === "restart" ? {
              ...(savedWindowIdentity!.title
                ? { windowTitle: savedWindowIdentity!.title }
                : { windowClass: savedWindowIdentity!.windowClass }),
              processPath: savedWindowIdentity!.processPath,
            } : desktopBinding ?? (savedWindowIdentity ? {
              windowTitle: savedWindowIdentity.title,
              windowClass: savedWindowIdentity.windowClass,
              processPath: savedWindowIdentity.processPath,
            } : { windowHandle }));
            return guest;
          })()
        : environment === "browser"
        ? await PlaywrightRuntime.launch({ headless: false, artifactDir: resolve(dir, "screenshots"),
            userDataDir: resolve(dir, "browser-profile") })
        : response && savedForResume?.taskContract?.windowIdentity
          ? await new WindowManager(resolve(dir, "screenshots")).attach({
            windowTitle: savedForResume.taskContract.windowIdentity.title,
            windowClass: savedForResume.taskContract.windowIdentity.windowClass,
            ...(savedForResume.taskContract.windowIdentity.processPath
              ? { processPath: savedForResume.taskContract.windowIdentity.processPath } : {}),
          })
          : await DesktopRuntime.attach({ windowHandle,
            artifactDir: resolve(dir, "screenshots") }));
      if (environment === "windows") {
        checkSetupPause();
        const probe = guest ? await guest.probe(true) :
          await new WindowManager(resolve(dir, "screenshots")).focus(runtime as DesktopRuntime);
        if (!probe.permissionsCompatible) throw new Error("窗口权限高于当前工程，无法控制");
        if (queued.taskContract && !response) queued.taskContract.windowIdentity = {
          title: probe.title, windowClass: probe.windowClass,
          ...(probe.processPath ? { processPath: probe.processPath } : {}),
        };
        const snapshot = await runtime.observe();
        if (guest) {
          if (snapshot.windowHandle === undefined || snapshot.windowTitle !== probe.title) {
            throw new Error("重新绑定后的 Guest 窗口身份不完整或已改变");
          }
          windowHandle = snapshot.windowHandle;
          desktopBinding = { windowHandle, windowClass: probe.windowClass,
            processId: probe.processId,
            ...(probe.processPath ? { processPath: probe.processPath } : {}) };
          const registry = this.routeDb();
          try { registry.prepare(`UPDATE generic_routes SET window_handle = ? WHERE task_id = ?`)
            .run(windowHandle, taskId); }
          finally { registry.close(); }
        }
        const facts: CapabilityFacts = { windowDiscovered: true, windowAttached: true,
          uiaControls: probe.uiaControls, windowForeground: probe.foreground,
          permissionsCompatible: probe.permissionsCompatible, completionCriteria: true,
          screenshotAvailable: !!snapshot.screenshot, modelAvailable: true,
          unrealWindow: probe.windowClass === "UnrealWindow",
          unityWindow: probe.windowClass === "UnityWndClass" };
        for (const operation of ["attach", "observe", "locate", "act", "choose", "verify"] as const) {
          const resolution = resolveCapability(operation, "windows", facts);
          trace.recordCapabilityResolution(taskId, queued.step, "通用任务窗口检查", resolution, facts);
          if (operation !== "act") requireCapability(resolution);
        }
      } else {
        const facts: CapabilityFacts = { browserInstalled: true, browserAttached: true,
          completionCriteria: true, modelAvailable: true };
        for (const operation of ["attach", "observe", "locate", "act", "choose", "verify"] as const) {
          const resolution = resolveCapability(operation, "browser", facts);
          trace.recordCapabilityResolution(taskId, queued.step, "通用任务浏览器检查", resolution, facts);
          requireCapability(resolution);
        }
      }
      const exploreModel = this.modelProvider.createModel({
        environment: environment === "browser" ? "browser" : "desktop",
        visualMode: environment === "windows" });
      if (environment === "windows" && !(guest && explicit &&
          explicitWorkflowUsesStructuredTargets(explicit.workflow))) runtime = new DesktopVisionRuntime(
        runtime as DesktopRuntime | WorkerClient, exploreModel);
      checkpoint = SqliteSaver.fromConnString(resolve(dir, "checkpoints.sqlite"));
      const stageCompletion = async (state: import("../graph/state.js").ComputerState,
        stage: NonNullable<import("../graph/state.js").ComputerState["completedStages"]>[number]) => {
        if (state.workflowRef?.stageId === stage.id) {
          const original = workflows.get(state.workflowRef.id, state.workflowRef.version);
          const success = !!original && stageReplaySucceeded(state, original);
          const replay = workflows.recordReplay(state.workflowRef.id, state.workflowRef.version,
            taskId, success, success ? undefined : "阶段回放未完整通过或已回退探索",
            state.workflowRef.definitionHash, "automatic", stage.id);
          trace.save("workflow_stage_replay", { ...state,
            summary: `阶段流程 ${replay.id} v${replay.version} ${success ? "回放验证成功" : "回退探索"}` });
          if (success) return { workflowId: replay.id, workflowVersion: replay.version };
        }
        const proposed = distillWorkflow(trace, taskId, this.tracePath, environment, {
          goal: stage.goal, successCondition: stage.successCondition,
          startStep: stage.startStep, endStep: stage.endStep });
        if (!proposed) return;
        const candidate = workflows.addCandidate(proposed);
        trace.save("workflow_stage_candidate", { ...state,
          summary: `保存阶段候选流程 ${candidate.id} v${candidate.version}` });
        return { workflowId: candidate.id, workflowVersion: candidate.version };
      };
      if (guest) {
        const saved = savedForResume ?? queued;
        let guestModel: ModelAdapter = saved.taskContract ? new StageWorkflowModel(exploreModel, workflows,
          (reason, state) => trace.save("workflow_fallback", { ...state, summary: reason }), environment) : exploreModel;
        if (!saved.taskContract && saved.workflowRef) {
          const original = workflows.get(saved.workflowRef.id, saved.workflowRef.version);
          if (!original || original.status === "retired") throw new Error("原流程版本缺失或已撤回");
          const replay = new WorkflowReplayModel(instantiateWorkflow({ workflow: original,
            values: saved.workflowRef.values, score: 1 }), exploreModel, undefined, undefined, undefined, saved.workflowRef.explicit === true);
          if (saved.workflowReplayState) replay.restoreState(saved.workflowReplayState);
          guestModel = replay;
        }
        const graph = createAgentLoop({ shadowSink:record=>writeHostShadow(this.rootDir,record),shadowVerify:configuredLiveShadow(this.rootDir),acceptanceVerifier: this.options.acceptanceVerifier, model: guestModel, runtime, trace,
          checkpointer: checkpoint, maxSteps: saved.taskContract?.taskActionLimit ?? 24, maxRetries: 2, recoveryJournal: true,
          facetProviders: this.options.facetProviders, domainEvaluator: this.options.domainEvaluator,
          workflowRecovery: state => reconcileWorkflow(state, state.workflowRef
            ? workflows.get(state.workflowRef.id, state.workflowRef.version) : undefined),
          ...(saved.taskContract ? { onStageCompleted: stageCompletion } : {}),
          pauseRequested: (id) => trace.pauseRequested(id) });
        if (response?.kind === "restart") {
          const recovered = { ...restartedDesktopState(savedForResume!), desktopBinding };
          trace.save("restart_reobserve", recovered);
          await graph.invoke(recovered, { configurable: { thread_id: recovered.checkpointThreadId! } });
        }
        else if (response?.kind === "continue") await continuePausedTask(graph, taskId, savedForResume?.checkpointThreadId);
        else if (response) await resumeSavedTask(graph, runtime, taskId,
          response.answer ? { answer: response.answer } : { approved: response.approved === true }, savedForResume?.checkpointThreadId);
        else await graph.invoke({ ...initialState(taskId, queued.goal, plan, completionCriteria), desktopBinding,
          verificationContract,contractCoverage,
          ...(queued.workflowRef ? { workflowRef: queued.workflowRef } : {}),
          ...(queued.taskContract ? { taskContract: queued.taskContract, completedStages: [], stagePlanVersion: 0 } : {}),
          desktopVmId: process.env.AGENT_DESKTOP_VM_ID },
          { configurable: { thread_id: taskId } });
        if (explicit) {
          const final = trace.load(taskId);
          if (final && ['done', 'failed'].includes(final.status)) workflows.recordReplay(explicit.ref.id,
            explicit.ref.version, taskId, explicitReplaySucceeded(final, explicit.workflow),
            final.error ?? (final.status === 'done' && !explicitReplaySucceeded(final, explicit.workflow) ? '任务结束，但完整回放与独立验收证据不足，未晋级' : undefined),
            explicit.ref.definitionHash, explicit.ref.trial ? 'record_only' : 'automatic');
        }
      } else if (response && response.kind !== "restart") {
        const saved = trace.load(taskId)!;
        let resumeModel: ModelAdapter = exploreModel;
        if (saved.taskContract) {
          resumeModel = new StageWorkflowModel(exploreModel, workflows,
            (reason, state) => trace.save("workflow_fallback", { ...state,
              summary: `阶段流程回退探索：${reason}` }), environment, taskProfile(saved.goal, this.registry));
        } else if (saved.workflowRef) {
          const original = workflows.get(saved.workflowRef.id, saved.workflowRef.version);
          if (!original) throw new Error("恢复时找不到原流程版本");
          const replay = new WorkflowReplayModel(instantiateWorkflow({ workflow: original,
            values: saved.workflowRef.values, score: 1 }), exploreModel,
            (reason, state) => trace.save("workflow_fallback", { ...state,
              summary: `暂停恢复后回退探索：${reason}` }), saved.completionCriteria);
          if (saved.workflowReplayState) replay.restoreState(saved.workflowReplayState);
          resumeModel = replay;
        }
        const graph = createAgentLoop({ shadowSink:record=>writeHostShadow(this.rootDir,record),shadowVerify:configuredLiveShadow(this.rootDir),acceptanceVerifier: this.options.acceptanceVerifier, model: resumeModel, runtime, trace, checkpointer: checkpoint,
          facetProviders: this.options.facetProviders, domainEvaluator: this.options.domainEvaluator,
          workflowRecovery: state => reconcileWorkflow(state, state.workflowRef
            ? workflows.get(state.workflowRef.id, state.workflowRef.version) : undefined),
          maxSteps: saved.taskContract?.taskActionLimit ?? 24, maxRetries: 2,
          pauseRequested: (id) => trace.pauseRequested(id),
          ...(saved.taskContract ? { onStageCompleted: stageCompletion } : {}) });
        if (response.kind === "continue") {
          await continuePausedTask(graph, taskId, taskId, environment === "browser" ? runtime : undefined);
        } else {
          await resumeSavedTask(graph, runtime, taskId,
            response.answer ? { answer: response.answer } : { approved: response.approved === true });
        }
        const final = trace.load(taskId);
        if (final?.status === "done" && !saved.taskContract) {
          const proposed = distillWorkflow(trace, taskId, this.tracePath, environment);
          if (proposed) workflows.addCandidate(proposed);
        }
      } else if (queued.taskContract && !selectWorkflow(workflows.list(environment)
        .filter((workflow) => workflow.scope !== "stage"), queued.goal, true)) {
        const stageModel = new StageWorkflowModel(exploreModel, workflows,
          (reason, state) => trace.save("workflow_fallback", { ...state,
            summary: `阶段流程回退探索：${reason}` }), environment, taskProfile(queued.goal, this.registry));
        const graph = createAgentLoop({ shadowSink:record=>writeHostShadow(this.rootDir,record),shadowVerify:configuredLiveShadow(this.rootDir),acceptanceVerifier: this.options.acceptanceVerifier, model: stageModel, runtime, trace, checkpointer: checkpoint,
          facetProviders: this.options.facetProviders, domainEvaluator: this.options.domainEvaluator,
          maxSteps: queued.taskContract.taskActionLimit, maxRetries: 2,
          pauseRequested: (id) => trace.pauseRequested(id), onStageCompleted: stageCompletion });
        const state = { ...initialState(taskId, queued.goal, plan, completionCriteria), verificationContract,
          contractCoverage,
          taskContract: queued.taskContract, completedStages: [], stagePlanVersion: 0 };
        trace.save("task_contract", state);
        await graph.invoke(state, { configurable: { thread_id: taskId } });
      } else {
        await runTaskAgent({ taskId, goal: queued.goal, environment,
          plan, completionCriteria: completionCriteria!, verificationContract, contractCoverage }, {
          runtime, exploreModel, trace, tracePath: this.tracePath, workflowStore: workflows,
          acceptanceVerifier: this.options.acceptanceVerifier,
          checkpointer: checkpoint, maxSteps: 24,
          pauseRequested: (id) => trace.pauseRequested(id) });
      }
    } catch (error) {
      const state = trace.load(taskId);
      if (state) trace.save("task_error", { ...state,
        status: isBudgetExceeded(error) || error instanceof GuestAppSetupError || error instanceof WorkerConnectionError || String(error).includes("DESKTOP_SETUP_PAUSED") || response?.kind === "restart" || response?.kind === "continue" && state.taskContract ? "paused" : "failed",
        recoveryRequired: error instanceof WorkerConnectionError || response?.kind === "restart" ? true : state.recoveryRequired,
        setupPaused: error instanceof GuestAppSetupError || String(error).includes("DESKTOP_SETUP_PAUSED"),
        error: String(error).includes("DESKTOP_SETUP_PAUSED") ? undefined : String(error),
        summary: isBudgetExceeded(error) ? error.message : error instanceof GuestAppSetupError ? `应用启动准备失败：${error.message}。处理后可继续，重新检查应用窗口` : String(error).includes("DESKTOP_SETUP_PAUSED") ? "应用准备阶段已暂停，继续时重新规划" : state.summary });
    } finally {
      const errors: unknown[] = [];
      for (const cleanup of [
        () => runtime ? runtime.close() : guest?.close(),
        async () => {
          if (!desktopClaimed) return;
          const state = trace.load(taskId);
          if (await control!.finishTask(taskId, state?.status) && state) {
            trace.save("stop", { ...state, status: "stopped", summary: "用户停止任务，现场保留" });
          }
        },
        () => checkpoint?.db.close(), () => workflows.close(), () => trace.close(),
      ]) {
        try { await cleanup(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "任务资源释放失败");
    }
  }

  resume(taskId: string, response: { approved?: boolean; answer?: string }): void {
    this.assertOpen();
    let guestTask = false;
    const trace = this.traceStore(this.tracePath);
    try {
      const state = trace.load(taskId);
      if (!state || state.status !== "waiting_user") throw new Error("任务未处于等待人工状态");
      guestTask = /^VM:\s*\S/i.test(state.goal) || !!state.desktopVmId;
      if (/^VM:\s*\S/i.test(state.goal)) this.desktopControl?.assertTaskAllowed(taskId);
      if (response.approved === undefined && !response.answer?.trim()) {
        throw new Error("请提供批准、拒绝或回答");
      }
    } finally { trace.close(); }
    const db = this.routeDb();
    let generic: boolean;
    try { generic = !!db.prepare(`SELECT 1 FROM generic_routes WHERE task_id = ?`).get(taskId); }
    finally { db.close(); }
    if (generic) {
      const control = guestTask ? this.taskControl() : undefined;
      this.enqueue(() => this.runGeneric(taskId, { kind: "human", ...response }, control), taskId, control);
      return;
    }
    const resumeTrace = this.traceStore(this.tracePath);
    let capability;
    try {
      const state = resumeTrace.load(taskId);
      if (!state) throw new Error("任务记录不存在");
      capability = state.executorId
        ? this.registry.capabilityById(state.executorId)
        : this.registry.matchCapability(state.goal);
      if (!capability?.resume) {
        throw new Error(state.executorId
          ? `专用能力 ${state.executorId} 已卸载，无法恢复该任务；请重新提交`
          : "该专用能力不支持恢复");
      }
    } finally { resumeTrace.close(); }
    capability.resume(taskId, response, (task) => this.enqueue(task, taskId));
  }

  pause(taskId: string): void {
    this.assertOpen();
    const routes = this.routeDb();
    try {
      if (!routes.prepare("SELECT 1 FROM generic_routes WHERE task_id = ?").get(taskId)) {
        throw new Error("当前只支持暂停通用任务");
      }
    } finally { routes.close(); }
    const trace = this.traceStore(this.tracePath);
    try {
      const state = trace.load(taskId);
      if (!state || state.status !== "running") throw new Error("只有运行中的通用任务可暂停");
      trace.requestPause(taskId);
    } finally { trace.close(); }
  }

  continue(taskId: string): void {
    this.assertOpen();
    if (this.continuing.has(taskId)) throw new Error("任务已经在继续执行");
    const trace = this.traceStore(this.tracePath);
    let setupPaused = false;
    let recoveryRequired = false;
    let guestTask = false;
    try {
      const state = trace.load(taskId);
      if (!state || state.status !== "paused") throw new Error("任务未处于暂停状态");
      guestTask = /^VM:\s*\S/i.test(state.goal) || !!state.desktopVmId;
      if (/^VM:\s*\S/i.test(state.goal)) this.desktopControl?.assertTaskAllowed(taskId);
      setupPaused = state.setupPaused === true;
      recoveryRequired = state.recoveryRequired === true;
      // A task interrupted before binding cannot have issued a desktop action.
      if (recoveryRequired && !state.desktopBinding && !state.inFlightAction && !state.observation && !state.step) setupPaused = true;
      trace.clearPause(taskId);
    } finally { trace.close(); }
    const control = guestTask ? this.taskControl() : undefined;
    this.continuing.add(taskId);
    this.enqueue(async () => {
      try { await this.runGeneric(taskId, setupPaused ? undefined : { kind: recoveryRequired ? "restart" : "continue" }, control); }
      finally { this.continuing.delete(taskId); }
    }, taskId, control);
  }

  reviewOutcome(taskId: string, response: { approved: boolean; note: string }): Promise<void> {
    this.assertOpen();
    const operation = this.queue.then(async () => {
      this.assertOpen();
      const routes = this.routeDb();
      try {
        if (!routes.prepare('SELECT 1 FROM generic_routes WHERE task_id = ?').get(taskId)) {
          throw new Error('只能人工验收通用任务');
        }
      } finally { routes.close(); }
      const trace = this.traceStore(this.tracePath);
      let guestTask = false;
      try {
        const state = trace.load(taskId);
        if (!state) throw new Error('任务记录不存在');
        guestTask = /^VM:\s*\S/i.test(state.goal) || !!state.desktopVmId;
        const reviewed = reviewManualOutcome(state, response.approved, response.note);
        trace.save(response.approved ? 'manual_outcome_approved' : 'manual_outcome_unconfirmed', reviewed);
        trace.recordNodeMetric(taskId, { step: state.step, node: 'manual_outcome_review',
          startedAt: reviewed.humanReview!.reviewedAt, durationMs: 0, actor: 'human',
          operator: response.approved ? '人工确认任务结果' : '人工未确认任务结果' });
      } finally { trace.close(); }
      if (response.approved && guestTask) await this.desktopControl?.finishTask(taskId, 'done');
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  private enqueue(task: () => Promise<void>, taskId: string | (() => string), control?: InputControl): void {
    const execute = async () => {
      const id = typeof taskId === "function" ? taskId() : taskId;
      if (this.closed || control && this.retiredControls.has(control)) {
        this.continuing.delete(id);
        const trace = this.traceStore(this.tracePath);
        try {
          const state = trace.load(id);
          if (state) trace.save("shutdown_cancelled", { ...state, status: "failed",
            error: "任务控制器已关闭，任务已取消" });
        } finally { trace.close(); }
        return;
      }
      let finish!: () => void;
      this.activeTask = { id, control, done: new Promise<void>((resolve) => { finish = resolve; }) };
      try { await task(); }
      finally { this.activeTask = undefined; finish(); }
    };
    this.queue = this.queue.then(execute, execute).catch((error) => {
      console.error("网页任务执行失败：", error);
    });
  }

}
