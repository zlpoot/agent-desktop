import { TaskDesktopSessions, type TaskAppRuntimeBinding } from './task-desktop-sessions.js';
import { runDesktopScenarioTask } from './desktop-scenario-task.js';
import { desktopTarget, taskDesktopFields, type TaskDesktopTarget } from '../contracts/task-desktop.js';
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve, win32 } from "node:path";
import { AppManagement } from './app-management.js';
import { TaskAppOnboarding, type TaskAppRequest, type TaskAppInteraction } from './task-app-onboarding.js';
import { assertAppAdmission } from '../environment-apps/admission-gate.js';
import type { EnvironmentAppServices, EnvironmentAppBinding } from '../contracts/environment-apps.js';
import { DatabaseSync } from "node:sqlite";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { ModelAdapter } from "../agent/model-adapter.js";
import { configuredModelProvider, snapshotModelProvider } from "../agent/local-config.js";
import { StageWorkflowModel } from "../agent/stage-workflow-model.js";
import { runTaskAgent } from "../agent/task-agent.js";
import { createAgentLoop } from "../graph/graph.js";
import {writeHostShadow} from '../verification/host-shadow.js';
import {configuredLiveShadow} from '../verification/live-shadow.js';
import { continuePausedTask, resumeSavedTask } from "../graph/resume.js";
import { initialState } from "../graph/state.js";
import { restartedDesktopState } from "../desktop-session/recovery.js";
import { DesktopVisionRuntime } from "../runtime/desktop/vision-runtime.js";
import type { RegisteredApp } from "../runtime/desktop/app-catalog.js";
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
import type { WorkerClient } from "../contracts/worker-client.js";
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
  manageApps?(request: Record<string, unknown>): Promise<unknown>;
  onboardApp?(taskId: string, request: TaskAppRequest): Promise<TaskAppInteraction>;
  submitScenario?(request: { desktopTarget: TaskDesktopTarget; scenarioId: string }, budget?: BudgetOverride): string;
  desktopOptions?(): Promise<readonly import('./task-desktop-sessions.js').TaskDesktopOption[]>;
  submitWorkflow?(request: WorkflowExecutionRequest, budget?: BudgetOverride, target?: TaskDesktopTarget): string;
  submit(goal: string, options?: { admin?: boolean; budget?: BudgetOverride; desktopTarget?: TaskDesktopTarget; destination?: 'browser' }): string;
  resume(taskId: string, response: { approved?: boolean; answer?: string }): void;
  pause(taskId: string): void;
  continue(taskId: string): void;
  reviewOutcome?(taskId: string, response: { approved: boolean; note: string }): Promise<void>;
}

/** 任务执行器的显式依赖；核心不直接读取全局配置或创建业务扩展。 */
export interface DesktopTaskControllerOptions {
  /** Trusted composition only; default off. Does not enable discovery/launch adapters. */
  environmentAppManagement?: boolean;
  environmentApps?: EnvironmentAppServices;
  desktopSessions?: TaskDesktopSessions;
  /** Infrastructure validates structured legacy provenance, never the goal text. */
  legacyDesktopTarget?: (state: import("../graph/state.js").ComputerState, environment: string, target: TaskDesktopTarget) => boolean;
  acceptanceVerifier?: import('../verifier/hybrid-verifier.js').AcceptanceVerifier;
  /** 业务扩展注册表；不传则使用空注册表（全部业务禁用，通用任务仍可运行）。 */
  registry?: ExtensionRegistry;
  modelProvider?: ModelProvider;
  traceStore?: (path: string) => TraceStore;
  workflowStore?: (path: string) => WorkflowStoreContract;
  /** 扩展 facet provider，观察后采集域证据；不传则不产出任何业务 facet。 */
  facetProviders?: import("../contracts/facets.js").ObservationFacetProvider[];
  /** 域条件求值器；不传时 domainChecks 一律 UNKNOWN（fail-closed）。 */
  domainEvaluator?: import("../verification/domain-evaluator.js").DomainEvaluator;
}

export class DesktopTaskController implements TaskController {
  private readonly appOnboarding: TaskAppOnboarding;
  private readonly appManagement?: AppManagement;
  private queue = Promise.resolve();
  private readonly continuing = new Set<string>();
  private readonly tracePath: string;
  private readonly registry: ExtensionRegistry;
  private readonly modelProvider: ModelProvider;
  private readonly traceStore: (path: string) => TraceStore;
  private readonly workflowStore: (path: string) => WorkflowStoreContract;
  private desktopControl?: InputControl;
  private desktopControlOwner?: string;
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
  }
  /** Keep a running task's control alive until it reaches its existing pause boundary. */
  async releaseDesktopControl(control: InputControl, owner: string): Promise<void> {
    this.retiredControls.add(control);
    const active = this.activeTask;
    try {
      if (active && (active.control === control || this.options.desktopSessions?.usesControl(active.id, control))) {
        try { this.requestShutdownPause(active.id); }
        finally { await active.done; }
      }
    } finally { this.setDesktopControl(undefined, owner); }
  }
  private requestShutdownPause(taskId: string) {
    const trace = this.traceStore(this.tracePath);
    try { trace.requestPause(taskId); } finally { trace.close(); }
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
      finally {
        try { await this.appManagement?.close(); await this.appOnboarding.close(); await this.queue; }
        finally { await this.options.desktopSessions?.close(); }
      }
    })();
    return this.closePromise;
  }
  private assertOpen() {
    if (this.closed) throw new Error("任务控制器已关闭，不再接受新任务");
  }

  constructor(private readonly rootDir: string, private readonly options: DesktopTaskControllerOptions = {}) {
    this.tracePath = resolve(rootDir, "web-tasks.sqlite");
    this.registry = options.registry ?? new ExtensionRegistry();
    this.modelProvider = options.modelProvider ?? configuredModelProvider(rootDir);
    this.traceStore = options.traceStore ?? ((path) => new SqliteTrace(path));
    this.workflowStore = options.workflowStore ?? ((path) => new WorkflowStore(path));
    if (options.environmentAppManagement === true && options.environmentApps) {
      this.appManagement = new AppManagement(options.environmentApps, () => this.desktopOptions());
    }
    this.appOnboarding = new TaskAppOnboarding(options.environmentApps, {
      load: id => {
        const trace = this.traceStore(this.tracePath);
        try { const state = trace.load(id); if (!state) throw new Error('task-not-found'); return state; }
        finally { trace.close(); }
      },
      save: (node, state) => { const trace = this.traceStore(this.tracePath);
        try { trace.save(node, state); } finally { trace.close(); } },
      guard: async state => {
        this.assertOpen();
        if (!state.desktopTarget || state.desktopScenario) throw new Error('app-onboarding-task-ineligible');
        this.requireDesktopSessions().assertTarget(state.desktopTarget);
        const trace = this.traceStore(this.tracePath);
        try { await this.requireDesktopSessions().acquire(state.taskId, state, binding => {
          const current = trace.load(state.taskId)!;
          trace.save('desktop_bound', { ...current, desktopExecutionBinding: binding });
        }); } finally { trace.close(); }
      },
      resume: id => this.enqueue(() => this.runGeneric(id), id),
    });
  }

  onboardApp(taskId: string, request: TaskAppRequest): Promise<TaskAppInteraction> {
    this.assertOpen(); return this.appOnboarding.act(taskId, request);
  }

  private requireDesktopSessions(): TaskDesktopSessions {
    if (!this.options.desktopSessions) throw new Error('desktop-task-executor-unavailable');
    return this.options.desktopSessions;
  }
  async manageApps(request: Record<string, unknown>) {
    this.assertOpen();
    if (!this.appManagement) throw new Error('app-management-disabled');
    return this.appManagement.act(request);
  }
  async desktopOptions() { return this.requireDesktopSessions().discover(); }
  private assertTaskCompatibility(state: import('../graph/state.js').ComputerState, environment: string | null): void {
    if (state.desktopTarget) return;
    if (state.taskBindingVersion === 1 && !state.desktopVmId && !state.desktopBinding &&
        environment !== 'windows' && environment !== 'agent_desktop') return;
    if (environment === 'browser' && !state.desktopVmId && !state.desktopBinding) return;
    throw new Error('legacy-desktop-target-required: explicitly select compatibility target or submit a new task');
  }
  private assertSavedTaskCompatibility(state: import('../graph/state.js').ComputerState): void {
    const db = this.routeDb();
    try {
      const row = db.prepare('SELECT environment FROM generic_routes WHERE task_id = ?').get(state.taskId) as
        { environment: string | null } | undefined;
      if (row) this.assertTaskCompatibility(state, row.environment);
    } finally { db.close(); }
  }
  /** Explicit compatibility selection. No model, goal parsing, input or fallback is involved. */
  adoptLegacyDesktopTask(taskId: string, selected: TaskDesktopTarget): void {
    this.assertOpen();
    const target = this.requireDesktopSessions().assertTarget(selected);
    const trace = this.traceStore(this.tracePath);
    const db = this.routeDb();
    try {
      const state = trace.load(taskId);
      const row = db.prepare('SELECT environment FROM generic_routes WHERE task_id = ?').get(taskId) as
        { environment: string | null } | undefined;
      if (!state || !['paused', 'waiting_user'].includes(state.status) || state.taskBindingVersion ||
          state.desktopTarget || state.desktopExecutionBinding ||
          !row || !['windows', 'agent_desktop'].includes(row.environment ?? '')) {
        throw new Error('legacy-desktop-compatibility-ineligible');
      }
      if (!this.options.legacyDesktopTarget?.(state, row.environment!, target)) {
        throw new Error('legacy-desktop-target-mismatch-or-unproven');
      }
      trace.save('desktop_compatibility_selected', { ...state, taskBindingVersion: 1, desktopTarget: target,
        status: 'paused', recoveryRequired: true,
        summary: '显式兼容选择已记录；继续时重新观察与状态对齐，旧批准不重放',
        desktopCompatibility: { source: 'legacy-route', environment: row.environment as 'windows' | 'agent_desktop',
          ...(state.desktopVmId ? { desktopVmId: state.desktopVmId } : {}) } });
    } finally { db.close(); trace.close(); }
  }

  submit(goal: string, options: { admin?: boolean; budget?: BudgetOverride; desktopTarget?: TaskDesktopTarget; destination?: 'browser' } = {}): string {
    this.assertOpen();
    if (options.destination !== undefined && options.destination !== 'browser') throw new Error('invalid-task-destination');
    if (options.destination === 'browser' && options.desktopTarget !== undefined) throw new Error('desktop-target-destination-conflict');
    const budget = parseBudgetOverride(options.budget);
    const target = options.desktopTarget !== undefined ? this.requireDesktopSessions().assertTarget(options.desktopTarget) : undefined;
    const route = routeTask(goal, { ...options, desktopTarget: target }, this.registry);
    if (route.kind === "generic") return this.submitGeneric(route.goal, undefined, budget, target, options.destination);
    // Legacy specialized desktop executors cannot bypass explicit Session binding.
    // Binding them to new Provider routes is outside P5-A.
    if (route.request.environment === 'windows') throw new Error('desktop-target-required');
    if (budget) throw new Error('专用能力任务暂不支持预算覆盖');
    // submit is synchronous; the queued microtask sees the returned persistent ID.
    let taskId: string;
    taskId = route.capability.submit(route.request, (task) => this.enqueue(task, () => taskId));
    return taskId;
  }

  submitWorkflow(request: WorkflowExecutionRequest, budget?: BudgetOverride, target?: TaskDesktopTarget): string {
    this.assertOpen();
    const store = this.workflowStore(resolve(this.rootDir, 'workflows.sqlite'));
    try {
      const prepared = prepareWorkflowExecution(store.get(request.id, request.version), request);
      // A saved Hidden Chrome candidate cannot inherit this Task's one-Key
      // permission or fall back to a generic browser during an explicit trial.
      if(prepared.workflow.steps.some(step=>step.preferredMethods.includes('owned-chrome-cdp')))
        throw new Error('Hidden Chrome 创建候选仅供查看；再次创建须使用新增授权的固定任务入口');
      if (prepared.workflow.environment === 'windows') {
        if (!target) throw new Error('desktop-target-required');
        target = this.requireDesktopSessions().assertTarget(target);
      } else if (target !== undefined) throw new Error('desktop-target-destination-conflict');
      return this.submitGeneric(prepared.goal, prepared.ref, parseBudgetOverride(budget), target, request.destination);
    } finally { store.close(); }
  }

  /** Explicit finite scenario entry shared by programmatic and HTTP callers. */
  submitScenario(request: { desktopTarget: TaskDesktopTarget; scenarioId: string }, override?: BudgetOverride): string {
    this.assertOpen();
    const definition = this.requireDesktopSessions().assertScenario(request?.desktopTarget, request?.scenarioId);
    const target = desktopTarget(request.desktopTarget.providerId, request.desktopTarget.environmentId);
    const budget = parseBudgetOverride(override), taskId = randomUUID();
    createTaskBudget(this.rootDir, taskId, budget);
    const db = this.routeDb();
    try { db.prepare('INSERT INTO generic_routes (task_id, environment, created_at) VALUES (?, ?, ?)')
      .run(taskId, 'windows', new Date().toISOString()); }
    finally { db.close(); }
    const trace = this.traceStore(this.tracePath);
    try { trace.save('queued', { ...initialState(taskId, definition.goal), taskBindingVersion: 1,
      desktopTarget: target, desktopScenario: definition.id, summary: '等待绑定并检查固定有限场景' }); }
    finally { trace.close(); }
    this.enqueue(() => runWithTaskBudget(this.rootDir, taskId, () => runDesktopScenarioTask(this.rootDir, taskId,
      this.traceStore(this.tracePath), this.requireDesktopSessions(), control => {
        if (this.activeTask?.id === taskId) this.activeTask.control = control;
      }, () => this.closed)), taskId);
    return taskId;
  }

  private routeDb(): DatabaseSync {
    const db = new DatabaseSync(resolve(this.rootDir, "web-task-routes.sqlite"));
    db.exec(`CREATE TABLE IF NOT EXISTS generic_routes (
      task_id TEXT PRIMARY KEY, environment TEXT, window_handle INTEGER,
      created_at TEXT NOT NULL)`);
    return db;
  }

  private submitGeneric(goal: string, workflowRef?: import('../graph/state.js').ComputerState['workflowRef'],
    budget?: BudgetOverride, target?: TaskDesktopTarget, destination?: WorkflowExecutionRequest['destination']): string {
    const contract = workflowRef ? undefined : taskContract(goal, taskProfile(goal, this.registry));
    const taskId = randomUUID();
    createTaskBudget(this.rootDir, taskId, budget);
    const db = this.routeDb();
    try { db.prepare(`INSERT INTO generic_routes (task_id, environment, created_at) VALUES (?, ?, ?)`)
      .run(taskId, destination ?? null, new Date().toISOString()); }
    finally { db.close(); }
    const trace = this.traceStore(this.tracePath);
    try { trace.save("queued", { ...initialState(taskId, goal), taskBindingVersion: 1,
      ...(target ? { desktopTarget: desktopTarget(target.providerId, target.environmentId) } : {}), ...(contract ? { taskContract: contract } : {}),
      ...(workflowRef ? { workflowRef } : {}), summary: workflowRef ? '已绑定指定流程，等待准备执行环境' : "等待模型规划任务" }); }
    finally { trace.close(); }
    this.enqueue(() => this.runGeneric(taskId), taskId);
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
    let runtime: WorkerClient | DesktopVisionRuntime | PlaywrightRuntime | undefined;
    let guest: WorkerClient | undefined;
    let desktopClaimed = false;
    const checkSetupPause = () => { if (desktopClaimed && trace.pauseRequested(taskId)) throw new Error("DESKTOP_SETUP_PAUSED"); };
    let checkpoint: ReturnType<typeof SqliteSaver.fromConnString> | undefined;
    try {
      let queued = trace.load(taskId);
      if (!queued) throw new Error("任务记录不存在");
      if (queued.desktopScenario) throw new Error('desktop-scenario-generic-fallback-forbidden');
      // 已排队但未开始的任务在控制器关闭后被取消，并落盘 failed（catch 分支写入）。
      if (this.closed) throw new Error("任务控制器已关闭，任务已取消");
      const db = this.routeDb();
      let route: { environment: string | null; window_handle: number | null } | undefined;
      try { route = db.prepare(`SELECT environment, window_handle FROM generic_routes WHERE task_id = ?`)
        .get(taskId) as typeof route; }
      finally { db.close(); }
      if (!route) throw new Error("缺少通用任务路由");
      const savedForResume = response ? trace.load(taskId) : undefined;
      const savedWindowIdentity = savedForResume?.taskContract?.windowIdentity ??
        (savedForResume?.desktopBinding && savedForResume.observation?.windowTitle
          ? { title: savedForResume.observation.windowTitle,
              windowClass: savedForResume.desktopBinding.windowClass,
              processPath: savedForResume.desktopBinding.processPath }
          : undefined);
      const pinned = (savedForResume ?? queued).workflowRef;
      const pinnedWorkflow = pinned?.id ? workflows.get(pinned.id, pinned.version) : undefined;
      if (pinned?.explicit && !pinnedWorkflow) throw new Error('原流程版本缺失');
      const explicit = pinned?.explicit && pinnedWorkflow ? prepareWorkflowExecution(pinnedWorkflow, {
        ...pinned, definitionHash: pinned.definitionHash ?? '',
        destination: routeWorkflowDestination(pinnedWorkflow),
      }) : undefined;
      let environment: "browser" | "windows";
      let managedApp: EnvironmentAppBinding | undefined;
      let appRuntimeBinding: TaskAppRuntimeBinding | undefined;
      let managedWindow: import('../runtime/desktop/desktop-runtime.js').WindowInfo | undefined;
      const checkManagedApp = () => {
        if (!managedApp) return;
        const registry = this.options.environmentApps?.forEnvironment(queued!.desktopTarget!).registry;
        if (!registry) throw new Error('app-admission-registry-unavailable');
        assertAppAdmission(registry, managedApp.appBindingId);
        const current = registry.get(managedApp.appBindingId);
        if (!current || current.validity !== 'current' || current.trust !== 'verified' || current.availability !== 'available' ||
            current.profileDigest !== managedApp.profileDigest || current.profileRevision !== managedApp.profileRevision) {
          throw new Error('app-onboarding-profile-no-longer-current');
        }
      };
      if (!response && queued.desktopTarget) {
        // No Agent lease/runtime/model exists during application setup. The guard freezes the Session first.
        const app = await this.appOnboarding.beforeRun(taskId);
        if (app === false) return;
        appRuntimeBinding = app;
        managedApp = app?.profile;
        queued = trace.load(taskId)!;
        if (queued.status === 'stopped') return;
      }
      if (response && queued.appOnboarding) {
        appRuntimeBinding = this.appOnboarding.runtimeBinding(taskId);
        managedApp = appRuntimeBinding.profile;
      }
      if (explicit) {
        if (explicit.workflow.environment === 'windows' && !queued.desktopTarget) throw new Error('desktop-target-required');
        if (explicit.workflow.environment === 'browser' && queued.desktopTarget) throw new Error('desktop-target-destination-conflict');
        const savedEnvironment = route.environment === 'agent_desktop' ? 'windows' : route.environment;
        if (savedEnvironment && savedEnvironment !== explicit.workflow.environment) throw new Error('workflow-route-environment-mismatch');
      }
      this.assertTaskCompatibility(queued, route.environment);
      let desktopApps: RegisteredApp[] = [];
      if (queued.desktopTarget) {
        const entry = await this.requireDesktopSessions().acquire(taskId, queued, binding => {
          queued = { ...queued!, desktopExecutionBinding: binding };
          trace.save('desktop_bound', queued);
        });
        if (this.closed) throw new Error("任务控制器已关闭，任务已取消");
        control = entry.control;
        if (this.activeTask?.id === taskId) this.activeTask.control = control;
        if (response?.kind === "restart" && (!savedWindowIdentity ||
          (!savedWindowIdentity.title && (!savedWindowIdentity.windowClass || !savedWindowIdentity.processPath)))) {
          throw new Error("检查点缺少稳定窗口身份，不能安全恢复；请停止旧任务后重新提交");
        }
        checkManagedApp();
        const artifactDir = resolve(this.rootDir, ".artifacts", "web-tasks", taskId, "screenshots");
        if (appRuntimeBinding) {
          if (!entry.executor.connectAppRuntime || entry.executor.appTrustFence !== 'registry-at-effect') {
            throw new Error('app-task-target-bridge-unavailable: registry effect fence required; submit a new task with a trusted executor');
          }
          // Prove the original target before input ownership. This Worker remains
          // fenced to that exact lifetime on every operation, including Graph actions.
          guest = await entry.executor.connectAppRuntime(entry.session, artifactDir,
            { ...appRuntimeBinding, assertCurrentTrust: checkManagedApp });
        }
        checkManagedApp(); // bridge connection may have awaited a pending denial
        await control.beginTask(taskId); desktopClaimed = true;
        checkManagedApp();
        checkSetupPause();
        if (!appRuntimeBinding) guest = await entry.executor.connectRuntime(entry.session, artifactDir);
        desktopApps = await entry.executor.appCatalog?.() ?? [];
      }
      const modelProvider = snapshotModelProvider(this.modelProvider);
      const model = modelProvider.createModel(explicit ? {
        environment: explicit.workflow.environment === 'browser' ? 'browser' : 'desktop',
        visualMode: explicit.workflow.environment === 'windows',
      } : route.environment === 'browser' ? { environment: 'browser', visualMode: false } : undefined);
      let windowHandle: number | undefined;
      let desktopBinding = savedForResume?.desktopBinding;
      let plan = queued.plan;
      let completionCriteria = queued.completionCriteria;
      let verificationContract = queued.verificationContract;
      let contractCoverage = queued.contractCoverage;
      const dir = resolve(this.rootDir, ".artifacts", "web-tasks", taskId);
      await mkdir(dir, { recursive: true });
      if (!response) {
        const allWindows = guest ? await guest.listWindows() : [];
        const spec = managedApp?.launchSpec;
        const discovered = spec && spec.kind !== 'package' ? allWindows.filter(window => window.visible && window.processPath &&
          win32.normalize(window.processPath).toLowerCase() === win32.normalize(spec.executable).toLowerCase()) : allWindows;
        if (managedApp && discovered.length !== 1) throw new Error('app-onboarding-actual-window-unproven');
        if (managedApp) managedWindow = discovered[0];
        const profile = taskProfile(queued.goal, this.registry);
        const windows = profile?.selectWindows?.(discovered) ?? discovered;
        const fixedWindow = guest && explicit ? explicitWorkflowWindow(explicit.workflow, windows) : undefined;
        if (explicit?.workflow.environment === 'browser') {
          environment = 'browser';
          plan = explicit.workflow.steps.map(step => step.goal);
          completionCriteria = explicit.workflow.successConditions;
          trace.recordNodeMetric(taskId, { step: 0, node: 'plan', startedAt: new Date().toISOString(),
            durationMs: 0, actor: 'rule', operator: '指定浏览器流程结构化路由' });
        } else if (fixedWindow && explicit) {
          environment = 'windows';
          windowHandle = fixedWindow.handle;
          plan = explicit.workflow.steps.map(step => step.goal);
          completionCriteria = explicit.workflow.successConditions;
          trace.recordNodeMetric(taskId, { step: 0, node: 'plan', startedAt: new Date().toISOString(),
            durationMs: 0, actor: 'rule', operator: '指定流程唯一窗口匹配' });
        } else {
          const apps = profile?.selectWindows ? [] : desktopApps;
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
          if (route.environment === 'browser' && environment !== 'browser') throw new Error('browser-plan-environment-mismatch');
          if (managedApp) {
            if (environment !== 'windows' || planned.task.appId || windowHandle !== undefined && windowHandle !== discovered[0].handle) {
              throw new Error('app-onboarding-planned-target-mismatch');
            }
            windowHandle = discovered[0].handle;
          }
          if (explicit) {
            if (environment !== explicit.workflow.environment) throw new Error('workflow-plan-environment-mismatch');
            plan = explicit.workflow.steps.map(step => step.goal);
            completionCriteria = explicit.workflow.successConditions;
            // The pinned Workflow definition owns its own verification contract.
            // Never expose the window-selection planner's unrelated conditions as the task contract.
            verificationContract = undefined;
          }
          if (environment === 'windows' && !guest) throw new Error('desktop-target-required');
          if (environment === "windows" && planned.task.appId) {
            checkSetupPause();
            const app = apps.find(candidate => candidate.id === planned.task.appId);
            if (!app) throw new Error('planned-app-not-in-catalog');
            const launchStartedAt = new Date().toISOString();
            const launchStarted = performance.now();
            windowHandle = (await guest!.ensureApp(app.id)).handle;
            if (windowHandle === undefined) throw new Error("启动应用后未取得窗口句柄");
            trace.recordNodeMetric(taskId, { step: 0, node: "app.ensure", startedAt: launchStartedAt,
              durationMs: performance.now() - launchStarted, actor: "runtime", operator: "windows.app.ensure" });
          }
        }
        if (guest && environment !== "windows") throw new Error("显式桌面任务必须规划为 Windows 窗口任务");
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
          WHERE task_id = ?`).run(environment, windowHandle ?? null, taskId); }
        finally { registry.close(); }
        trace.save("plan", { ...queued, plan, completionCriteria, verificationContract,contractCoverage,
          summary: `规划完成：${environment === "browser" ? "浏览器" : "Windows 应用"}` });
      } else {
        if (route.environment !== "browser" && route.environment !== "windows" &&
            route.environment !== "agent_desktop") {
          throw new Error("保存的任务环境无效");
        }
        environment = route.environment === "agent_desktop" ? "windows" : route.environment;
        if (environment === "windows" && !guest) throw new Error("desktop-target-required");
        if (environment === "browser" && guest) throw new Error("desktop-route-binding-mismatch");
        windowHandle = route.window_handle ?? undefined;
        if (managedApp) {
          const windows = await guest!.listWindows();
          if (windows.length !== 1 || windows[0].handle !== windowHandle) throw new Error('app-onboarding-actual-window-unproven');
          managedWindow = windows[0];
        }
      }
      runtime = runtime ?? (guest
        ? await (async () => {
            checkSetupPause();
            checkManagedApp();
            // Only unmanaged Tasks retain semantic restart attachment. Managed
            // Workers are already fenced to the receipt and cannot be rebound.
            if (!managedApp) await guest.attach(response?.kind === "restart" ? {
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
        : (() => { throw new Error('desktop-target-required'); })());
      if (environment === "windows") {
        checkSetupPause();
        const probe = await guest!.probe(true);
        if (managedApp && (probe.processId !== managedWindow?.processId || probe.windowClass !== managedWindow.windowClass ||
            managedApp.launchSpec.kind === 'package' || !probe.processPath ||
            win32.normalize(probe.processPath).toLowerCase() !== win32.normalize(managedApp.launchSpec.executable).toLowerCase())) {
          throw new Error('app-onboarding-attached-process-mismatch');
        }
        if (!probe.permissionsCompatible) throw new Error("窗口权限高于当前工程，无法控制");
        if (queued.taskContract && !response) queued.taskContract.windowIdentity = {
          title: probe.title, windowClass: probe.windowClass,
          ...(probe.processPath ? { processPath: probe.processPath } : {}),
        };
        const snapshot = await runtime.observe();
        checkManagedApp();
        if (guest) {
          if (snapshot.windowHandle === undefined || snapshot.windowTitle !== probe.title ||
              managedApp && snapshot.windowHandle !== windowHandle) {
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
      const exploreModel = modelProvider.createModel({
        environment: environment === "browser" ? "browser" : "desktop",
        visualMode: environment === "windows" });
      if (environment === "windows" && !(guest && explicit &&
          explicitWorkflowUsesStructuredTargets(explicit.workflow))) runtime = new DesktopVisionRuntime(
        runtime as WorkerClient, exploreModel);
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
      if (guest || explicit) {
        const saved = savedForResume ?? queued;
        let guestModel: ModelAdapter = saved.taskContract ? new StageWorkflowModel(exploreModel, workflows,
          (reason, state) => trace.save("workflow_fallback", { ...state, summary: reason }), environment) : exploreModel;
        if (!saved.taskContract && saved.workflowRef) {
          const original = workflows.get(saved.workflowRef.id, saved.workflowRef.version);
          if (!original || original.status === "retired") throw new Error("原流程版本缺失或已撤回");
          const replay = new WorkflowReplayModel(explicit?.workflow ?? instantiateWorkflow({ workflow: original,
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
          if (!guest && savedForResume?.observation) await runtime.restore(savedForResume.observation);
          const recovered = { ...restartedDesktopState(savedForResume!), ...taskDesktopFields(queued), desktopBinding };
          trace.save("restart_reobserve", recovered);
          await graph.invoke(recovered, { configurable: { thread_id: recovered.checkpointThreadId! } });
        }
        else if (response?.kind === "continue") await continuePausedTask(graph, taskId, savedForResume?.checkpointThreadId, guest ? undefined : runtime, queued);
        else if (response) await resumeSavedTask(graph, runtime, taskId,
          response.answer ? { answer: response.answer } : { approved: response.approved === true }, savedForResume?.checkpointThreadId, queued);
        else await graph.invoke({ ...initialState(taskId, queued.goal, plan, completionCriteria), ...taskDesktopFields(queued), desktopBinding,
          appOnboarding: queued.appOnboarding,
          retryCount: queued.retryCount,
          verificationContract,contractCoverage,
          ...(queued.workflowRef ? { workflowRef: queued.workflowRef } : {}),
          ...(queued.taskContract ? { taskContract: queued.taskContract, completedStages: [], stagePlanVersion: 0 } : {}),
          },
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
          await continuePausedTask(graph, taskId, taskId, environment === "browser" ? runtime : undefined, queued);
        } else {
          await resumeSavedTask(graph, runtime, taskId,
            response.answer ? { answer: response.answer } : { approved: response.approved === true }, taskId, queued);
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
        const state = { ...initialState(taskId, queued.goal, plan, completionCriteria), ...taskDesktopFields(queued), verificationContract,
          contractCoverage,
          taskContract: queued.taskContract, completedStages: [], stagePlanVersion: 0 };
        trace.save("task_contract", state);
        await graph.invoke(state, { configurable: { thread_id: taskId } });
      } else {
        await runTaskAgent({ taskId, goal: queued.goal, environment,
          plan, completionCriteria: completionCriteria!, verificationContract, contractCoverage,
          ...taskDesktopFields(queued) }, {
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
    let control: InputControl | undefined;
    const trace = this.traceStore(this.tracePath);
    try {
      const state = trace.load(taskId);
      if (!state || state.status !== "waiting_user") throw new Error("任务未处于等待人工状态");
      if (state.appOnboarding && state.appOnboarding.state !== 'ready') throw new Error('app-onboarding-dedicated-interaction-required');
      if (state.desktopScenario) throw new Error('desktop-scenario-replay-forbidden');
      this.assertSavedTaskCompatibility(state);
      if (state.desktopExecutionBinding) {
        control = this.requireDesktopSessions().control(taskId, state.desktopExecutionBinding);
        control.assertTaskAllowed(taskId);
      }
      if (response.approved === undefined && !response.answer?.trim()) {
        throw new Error("请提供批准、拒绝或回答");
      }
    } finally { trace.close(); }
    const db = this.routeDb();
    let generic: boolean;
    try { generic = !!db.prepare(`SELECT 1 FROM generic_routes WHERE task_id = ?`).get(taskId); }
    finally { db.close(); }
    if (generic) {
      this.enqueue(() => this.runGeneric(taskId, { kind: "human", ...response }, control), taskId, control);
      return;
    }
    const resumeTrace = this.traceStore(this.tracePath);
    let capability;
    try {
      const state = resumeTrace.load(taskId);
      if (!state) throw new Error("任务记录不存在");
      if (state.taskContract?.environment !== 'browser') {
        throw new Error('legacy-specialized-desktop-compatibility-unavailable: submit a new task');
      }
      capability = state.executorId ? this.registry.capabilityById(state.executorId) : undefined;
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
    let control: InputControl | undefined;
    try {
      const state = trace.load(taskId);
      if (!state || state.status !== "paused") throw new Error("任务未处于暂停状态");
      if (state.appOnboarding && state.appOnboarding.state !== 'ready') throw new Error('app-onboarding-new-task-required');
      if (state.desktopScenario) throw new Error('desktop-scenario-replay-forbidden: explicitly submit a new task');
      this.assertSavedTaskCompatibility(state);
      if (state.desktopExecutionBinding) {
        control = this.requireDesktopSessions().control(taskId, state.desktopExecutionBinding);
        control.assertTaskAllowed(taskId);
      }
      setupPaused = state.setupPaused === true;
      recoveryRequired = state.recoveryRequired === true;
      // A task interrupted before binding cannot have issued a desktop action.
      if (recoveryRequired && !state.desktopBinding && !state.inFlightAction && !state.observation && !state.step) setupPaused = true;
      trace.clearPause(taskId);
    } finally { trace.close(); }
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
      try {
        const state = trace.load(taskId);
        if (!state) throw new Error('任务记录不存在');
        const reviewed = reviewManualOutcome(state, response.approved, response.note);
        if (response.approved && state.desktopExecutionBinding) {
          await this.requireDesktopSessions().completeTask(taskId, state.desktopExecutionBinding);
        }
        trace.save(response.approved ? 'manual_outcome_approved' : 'manual_outcome_unconfirmed', reviewed);
        trace.recordNodeMetric(taskId, { step: state.step, node: 'manual_outcome_review',
          startedAt: reviewed.humanReview!.reviewedAt, durationMs: 0, actor: 'human',
          operator: response.approved ? '人工确认任务结果' : '人工未确认任务结果' });
      } finally { trace.close(); }
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
