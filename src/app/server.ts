import { desktopTarget } from '../contracts/task-desktop.js';
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { ComputerAction, Observation } from "../actions/schema.js";
import type { ComputerState } from "../graph/state.js";
import type { NodeMetric } from "../trace/sqlite-trace.js";
import type { TaskController } from "./task-runner.js";
import { canManuallyReviewOutcome } from '../verification/manual-review.js';
import { taskOutcome } from '../verification/task-outcome.js';
import { listPrompts, savePrompt, type PromptId } from "../agent/prompt-store.js";
import type { DesktopProvider } from "../contracts/desktop-provider.js";
import type { VmControl } from "../desktop-session/vm-control.js";
import { readWorkflowVersion, previewWorkflow, readWorkflowMetadata, saveWorkflowMetadata } from './workflow-view.js';
import { WorkflowStore } from '../workflows/store.js';
import type { AssemblySnapshot } from '../composition/inspection.js';
import { compactObservationFacets } from '../contracts/facets.js';
import { globalTaskBudget, parseBudgetOverride, readTaskBudget, saveGlobalTaskBudget } from '../runtime/model-budget.js';

/** 输入控制的页面操作面；具体实现为 DesktopControl。 */
export interface DesktopControlView {
  view(): unknown;
  input(client: string, event: unknown): Promise<unknown>;
  command(client: string, command: string): Promise<unknown>;
  disconnect(client: string): Promise<void>;
  reconnect(): Promise<void>;
  close(): void;
}

/** API 对外暴露的通用业务证据摘要（域无关）：只含 facetId/complete/data。 */
interface RunStepFacet {
  facetId: string;
  complete: boolean;
  data: unknown;
}

interface RunStep {
  step: number;
  action?: ComputerAction;
  strategy?: string;
  targetBinding?: ComputerState["targetBinding"];
  result?: { ok: boolean; message: string };
  verification?: { ok: boolean; message: string };
  url?: string;
  pageText?: string;
  textSources?: string[];
  facets?: RunStepFacet[];
  screenshot?: string;
  screenshotTime?: string;
  screenshotScope?: 'desktop' | 'window' | 'page';
  desktopCaptureError?: string;
  time?: string;
  durationMs?: number;
  metrics?: NodeMetric[];
}

const publicDir = fileURLToPath(new URL("./public/", import.meta.url));

function send(response: ServerResponse, status: number, content: string | Buffer, type: string): void {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' blob:; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'",
  });
  response.end(content);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function sources(rootDir: string): string[] {
  const rootSources = readdirSync(rootDir).filter((name) => name.endsWith(".sqlite") &&
    existsSync(join(rootDir, name)));
  const demoRoot = join(rootDir, ".artifacts", "approval-demo");
  if (!existsSync(demoRoot)) return rootSources;
  return [...rootSources, ...readdirSync(demoRoot, { withFileTypes: true })
    .filter((item) => item.isDirectory() && existsSync(join(demoRoot, item.name, "trace.sqlite")))
    .map((item) => `approval-demo:${item.name}`)];
}

function openSource(rootDir: string, source: string): DatabaseSync | undefined {
  if (source !== basename(source) || !sources(rootDir).includes(source)) return undefined;
  const path = source.startsWith("approval-demo:")
    ? join(rootDir, ".artifacts", "approval-demo", source.slice("approval-demo:".length), "trace.sqlite")
    : join(rootDir, source);
  return new DatabaseSync(path, { readOnly: true, timeout: 1000 });
}

function genericTask(rootDir: string, taskId: string): boolean {
  const path = join(rootDir, "web-task-routes.sqlite");
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
  try { return !!db.prepare("SELECT 1 FROM generic_routes WHERE task_id=?").get(taskId); }
  catch { return false; }
  finally { db.close(); }
}

function listRuns(rootDir: string) {
  const runs: Array<Record<string, unknown>> = [];
  for (const source of sources(rootDir)) {
    let db: DatabaseSync | undefined;
    try {
      db = openSource(rootDir, source);
      if (!db) continue;
      const rows = db.prepare(`SELECT task_id, goal, status, step, state_json, updated_at
        FROM tasks ORDER BY updated_at DESC LIMIT 200`).all() as Array<{
        task_id: string; goal: string; status: string; step: number; state_json: string; updated_at: string;
      }>;
      for (const row of rows) {
        const state = JSON.parse(row.state_json) as ComputerState;
        let pauseRequested = false;
        try { pauseRequested = !!(db.prepare("SELECT pause_requested FROM task_controls WHERE task_id=?")
          .get(row.task_id) as { pause_requested: number } | undefined)?.pause_requested; }
        catch { /* 旧轨迹没有控制表。 */ }
        runs.push({ source, taskId: row.task_id, goal: row.goal,
          status: row.status === "running" && pauseRequested ? "pause_requested" : row.status,
          step: row.step, planCount: state.plan?.length ?? 0, summary: state.summary,
          updatedAt: row.updated_at });
      }
    } catch {
      // 工作区可能含有其他 SQLite 文件，页面只展示符合轨迹结构的数据库。
    } finally { db?.close(); }
  }
  return runs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function readRun(rootDir: string, source: string, taskId: string) {
  const db = openSource(rootDir, source);
  if (!db) return undefined;
  try {
    const row = db.prepare("SELECT state_json, updated_at FROM tasks WHERE task_id = ?")
      .get(taskId) as { state_json: string; updated_at: string } | undefined;
    if (!row) return undefined;
    const state = JSON.parse(row.state_json) as ComputerState;
    let pauseRequested = false;
    try { pauseRequested = !!(db.prepare("SELECT pause_requested FROM task_controls WHERE task_id=?")
      .get(taskId) as { pause_requested: number } | undefined)?.pause_requested; }
    catch { /* 旧轨迹没有控制表。 */ }
    const events = db.prepare(`SELECT step, node, payload_json, created_at FROM events
      WHERE task_id = ? ORDER BY id`).all(taskId) as Array<{
        step: number; node: string; payload_json: string; created_at: string;
      }>;
    const workflowEvents = events.filter((event) => event.node.startsWith("workflow_"))
      .map((event) => ({ step: event.step, kind: event.node,
        detail: (JSON.parse(event.payload_json) as ComputerState).summary,
        time: event.created_at }));
    const stepMap = new Map<number, RunStep>();
    for (const event of events) {
      if (event.step <= 0) continue;
      const snapshot = JSON.parse(event.payload_json) as ComputerState;
      const item = stepMap.get(event.step) ?? { step: event.step };
      if (event.node === "decide") item.action = snapshot.lastAction;
      if (event.node === "ground") {
        item.strategy = snapshot.groundingStrategy;
        item.targetBinding = snapshot.targetBinding;
        if (snapshot.lastResult?.ok === false) item.result = snapshot.lastResult;
      }
      if (event.node === "execute") item.result = snapshot.lastResult;
      if (event.node === "verify") item.verification = snapshot.lastVerification;
      if (event.node === "observe") {
        const observation = snapshot.observation as Observation | undefined;
        item.url = observation?.url;
        item.pageText = observation?.pageText?.slice(0, 1200);
        item.textSources = [...new Set(observation?.textEvidence?.map((entry) => entry.source) ?? [])];
        item.facets = compactObservationFacets(observation?.facets);
        item.screenshot = observation?.desktopScreenshot ?? observation?.screenshot;
        item.screenshotScope = observation?.desktopScreenshot ? 'desktop' : observation?.windowHandle ? 'window' : 'page';
        item.desktopCaptureError = observation?.desktopCaptureError;
        item.screenshotTime = observation?.desktopScreenshot ? observation.desktopCapturedAt ?? event.created_at
          : observation?.screenshot ? event.created_at : undefined;
      }
      item.time = event.created_at;
      stepMap.set(event.step, item);
    }
    const steps = [...stepMap.values()].sort((a, b) => a.step - b.step);
    let metrics: NodeMetric[] = [];
    try {
      metrics = db.prepare(`SELECT step, node, started_at AS startedAt,
        duration_ms AS durationMs, actor, operator, model_name AS modelName,
        input_tokens AS inputTokens, output_tokens AS outputTokens,
        total_tokens AS totalTokens FROM node_metrics WHERE task_id = ? ORDER BY id`)
        .all(taskId) as unknown as NodeMetric[];
    } catch { /* 旧版轨迹没有耗时与模型用量表。 */ }
    for (const metric of metrics) {
      const step = stepMap.get(metric.step);
      if (!step) continue;
      step.metrics ??= [];
      step.metrics.push(metric);
      step.durationMs = (step.durationMs ?? 0) + metric.durationMs;
    }
    const modelCalls = metrics.filter((metric) => metric.actor === "model");
    const reportedCalls = modelCalls.filter((metric) => metric.totalTokens !== null &&
      metric.totalTokens !== undefined);
    const firstAt = [events[0]?.created_at, metrics[0]?.startedAt]
      .filter((value): value is string => !!value).map(Date.parse);
    const lastMetric = metrics.at(-1);
    const lastMetricEnd = lastMetric
      ? Date.parse(lastMetric.startedAt) + lastMetric.durationMs : 0;
    const endAt = state.status === "running" ? Date.now()
      : Math.max(Date.parse(row.updated_at), lastMetricEnd);
    const elapsedMs = firstAt.length ? Math.max(0, endAt - Math.min(...firstAt)) : undefined;
    let groundingStats: unknown[] = [];
    try {
      groundingStats = db.prepare(`SELECT strategy, COUNT(*) AS attempts,
        SUM(matched) AS matches, SUM(selected) AS selections,
        SUM(CASE WHEN executed_ok = 1 THEN 1 ELSE 0 END) AS successes
        FROM grounding_attempts WHERE task_id = ? GROUP BY strategy ORDER BY strategy`).all(taskId);
    } catch { /* 旧版轨迹没有定位统计表。 */ }
    let capabilityResolutions: unknown[] = [];
    try {
      capabilityResolutions = db.prepare(`SELECT step, phase, operation, environment,
        selected, facts_json AS factsJson, candidates_json AS candidatesJson, created_at AS createdAt
        FROM capability_resolutions WHERE task_id = ? ORDER BY id`).all(taskId).map((item) => {
        const row = item as { factsJson: string; candidatesJson: string };
        return { ...row, facts: JSON.parse(row.factsJson), candidates: JSON.parse(row.candidatesJson),
          factsJson: undefined, candidatesJson: undefined };
      });
    } catch { /* 旧版轨迹没有能力选择记录。 */ }
    let actionResolutions: unknown[] = [];
    try {
      actionResolutions = db.prepare(`SELECT step, selected, reason,
        candidates_json AS candidatesJson, actual, executed_ok AS executedOk,
        execution_note AS executionNote FROM action_resolutions WHERE task_id = ? ORDER BY step`)
        .all(taskId).map((item) => {
          const entry = item as { candidatesJson: string };
          return { ...entry, candidates: JSON.parse(entry.candidatesJson), candidatesJson: undefined };
        });
    } catch { /* 旧版轨迹没有逐动作解析记录。 */ }
    let providerAttempts: unknown[] = [];
    try {
      providerAttempts = db.prepare(`SELECT step, provider, ok, effect, message, created_at AS createdAt
        FROM action_provider_attempts WHERE task_id = ? ORDER BY id`).all(taskId);
    } catch { /* 旧版轨迹没有逐执行器尝试记录。 */ }
    return {
      source, taskId, goal: state.goal, summary: state.summary,
      recoveryRequired: state.recoveryRequired === true,
      canPause: source === "web-tasks.sqlite" && genericTask(rootDir, taskId),
      status: state.status === "running" && pauseRequested ? "pause_requested" : state.status,
      error: state.error, goalVerification: state.goalVerification,
      acceptanceReport: state.acceptanceReport,
      humanReview: state.humanReview,
      outcome: taskOutcome(state),
      canManualReview: source === 'web-tasks.sqlite' && genericTask(rootDir, taskId) &&
        canManuallyReviewOutcome(state),
      interactionKind: state.status === "waiting_user"
        ? state.appOnboarding && state.appOnboarding.state !== 'ready' ? 'app_onboarding' : state.finalReviewPending ? "final_review"
          : state.lastAction?.kind === "ask_user" ? "question" : "approval"
        : undefined,
      completionCriteria: state.completionCriteria,
      verificationContract: state.verificationContract,
      stage: state.stage, completedStages: state.completedStages ?? [],
      diagnosis: state.diagnosis,
      stagePlanVersion: state.stagePlanVersion,
      workflowRef: state.workflowRef,
      desktopTarget: state.desktopTarget,
      appOnboarding: state.appOnboarding,
      desktopScenario: state.desktopScenario,
      desktopExecutionBinding: state.desktopExecutionBinding,
      desktopTargetRequired: !state.desktopTarget && !!(state.desktopVmId || state.desktopBinding || state.taskContract?.environment === 'windows'),
      workflowReplayState: state.workflowReplayState,
      facets: compactObservationFacets(state.observation?.facets),
      metricsAvailable: metrics.length > 0,
      elapsedMs, activeDurationMs: metrics.length
        ? metrics.reduce((sum, metric) => sum + metric.durationMs, 0) : undefined,
      modelCalls: modelCalls.length,
      modelNames: [...new Set(modelCalls.map((metric) => metric.modelName).filter(Boolean))],
      totalTokens: reportedCalls.length
        ? reportedCalls.reduce((sum, metric) => sum + (metric.totalTokens ?? 0), 0) : undefined,
      reportedTokenCalls: reportedCalls.length,
      taskBudget: source === 'web-tasks.sqlite' ? readTaskBudget(rootDir, taskId) : undefined,
      updatedAt: row.updated_at, currentStep: state.step,
      plan: state.plan?.length ? state.plan : steps.filter((step) => step.action).map((step) =>
        `第 ${step.step} 步：${step.action?.kind}`),
      planSource: state.plan?.length ? "预设计划" : "已决定的动作",
      completedActions: steps.filter((step) => (step.verification ?? step.result)?.ok).length,
      steps: steps.map(({ screenshot, ...step }) => ({ ...step, hasScreenshot: !!screenshot })),
      workflowEvents,
      groundingStats, capabilityResolutions, actionResolutions, providerAttempts,
    };
  } finally { db.close(); }
}

function listWorkflows(rootDir: string): unknown[] {
  const path = resolve(rootDir, "workflows.sqlite");
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
  try {
    return db.prepare(`SELECT data_json FROM workflows ORDER BY created_at DESC, version DESC`)
      .all().map((row) => JSON.parse((row as { data_json: string }).data_json));
  } finally { db.close(); }
}

function readScreenshot(rootDir: string, source: string, taskId: string, step: number): Buffer | undefined {
  const db = openSource(rootDir, source);
  if (!db) return undefined;
  try {
    const rows = db.prepare(`SELECT payload_json FROM events WHERE task_id = ? AND step = ?
      AND node = 'observe' ORDER BY id DESC LIMIT 1`).all(taskId, step) as Array<{ payload_json: string }>;
    const state = rows[0] ? JSON.parse(rows[0].payload_json) as ComputerState : undefined;
    const path = state?.observation?.desktopScreenshot ?? state?.observation?.screenshot;
    if (!path || !isAbsolute(path) || extname(path).toLowerCase() !== ".png") return undefined;
    const artifactRoot = resolve(rootDir, ".artifacts");
    const rel = relative(artifactRoot, resolve(path));
    if (rel.startsWith("..") || isAbsolute(rel) || !rel) return undefined;
    return readFileSync(path);
  } catch { return undefined; }
  finally { db.close(); }
}

async function bodyJson(request: IncomingMessage, limit = 4096): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const part = Buffer.from(chunk as Buffer);
    size += part.length;
    if (size > limit) throw new Error("请求内容过长");
    chunks.push(part);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求格式无效");
  return value as Record<string, unknown>;
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const source = new URL(origin);
    return source.protocol === "http:" && source.host === request.headers.host &&
      (source.hostname === "127.0.0.1" || source.hostname === "localhost");
  } catch { return false; }
}

export function createDashboardServer(rootDir = process.cwd(), controller?: TaskController,
  desktop?: DesktopProvider, vmControl?: VmControl, control?: DesktopControlView,
  inspectRuntime?: () => AssemblySnapshot): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (request.method === 'GET' && url.pathname === '/api/desktop/environments') {
      if (!controller?.desktopOptions) return json(response, 503, { error: 'desktop-selection-unavailable' });
      void Promise.resolve().then(() => controller.desktopOptions!()).then(environments => json(response, 200, { environments }))
        .catch(error => json(response, 503, { error: String(error) }));
      return;
    }
    if (request.method === 'PUT' && url.pathname === '/api/settings/task-budget') {
      if (!sameOrigin(request) || request.headers['sec-fetch-site'] === 'cross-site') return json(response, 403, { error: '只接受本机页面修改预算' });
      if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: '请使用 JSON' });
      void bodyJson(request, 2048).then(body => {
        try { return json(response, 200, { budget: saveGlobalTaskBudget(rootDir, body) }); }
        catch (error) { return json(response, 400, { error: String(error) }); }
      }).catch(error => json(response, 400, { error: String(error) }));
      return;
    }
    if (request.method === 'PUT' && parts[0] === 'api' && parts[1] === 'workflows' && parts[3] === 'metadata' && parts.length === 4) {
      if (!sameOrigin(request) || request.headers['sec-fetch-site'] === 'cross-site') return json(response, 403, { error: '只接受本机页面修改流程说明' });
      if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: '请使用 JSON' });
      void bodyJson(request, 8000).then(body => {
        const metadata = saveWorkflowMetadata(rootDir, parts[2], body);
        return metadata ? json(response, 200, { metadata }) : json(response, 409, { error: '名称或说明已被其他页面修改，请重新打开流程后再保存' });
      }).catch(error => json(response, 400, { error: String(error) }));
      return;
    }
    if (request.method === "PUT" && parts[0] === "api" && parts[1] === "prompts" && parts.length === 3) {
      if (!sameOrigin(request) || request.headers["sec-fetch-site"] === "cross-site") {
        return json(response, 403, { error: "只接受本机页面修改提示词" });
      }
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        return json(response, 415, { error: "请使用 JSON 提交提示词" });
      }
      void bodyJson(request, 24000).then((body) => {
        try {
          if (typeof body.content !== "string") throw new Error("提示词内容必须为文字");
          savePrompt(parts[2] as PromptId, body.content, rootDir);
          return json(response, 200, { ok: true });
        } catch (error) { return json(response, 400, { error: String(error) }); }
      }).catch((error) => json(response, 400, { error: String(error) }));
      return;
    }
    if (request.method === "POST") {
      if (parts[0] === 'api' && parts[1] === 'workflows' && parts.length === 5 && parts[4] === 'publish') {
        if (!sameOrigin(request) || request.headers['sec-fetch-site'] === 'cross-site') return json(response, 403, { error: '只接受本机页面发布' });
        if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: '请使用 JSON 提交发布依据' });
        void bodyJson(request, 24000).then(body => {
          const version = /^[1-9]\d*$/.test(parts[3]) ? Number(parts[3]) : NaN;
          if (!Number.isSafeInteger(version)) return json(response, 400, { error: '无效版本号' });
          if (typeof body.definitionHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.definitionHash) ||
            typeof body.successCount !== 'number' || typeof body.failureCount !== 'number' ||
            !Number.isSafeInteger(body.successCount) || !Number.isSafeInteger(body.failureCount) ||
            body.successCount < 0 || body.failureCount < 0) return json(response, 400, { error: '请提交当前定义摘要和回放计数' });
          const path = join(rootDir, 'workflows.sqlite');
          if (!existsSync(path)) return json(response, 404, { error: '流程版本不存在' });
          const store = new WorkflowStore(path);
          try {
            const workflow = store.publish(parts[2], version, body.definitionHash, body.successCount, body.failureCount);
            return json(response, 200, { workflow });
          } catch (error) { return json(response, 409, { error: String(error) }); }
          finally { store.close(); }
        }).catch(error => json(response, 400, { error: String(error) }));
        return;
      }
      if (parts[0] === 'api' && parts[1] === 'workflows' && parts.length === 5 && ['preview', 'execute', 'trial'].includes(parts[4])) {
        if (!sameOrigin(request) || request.headers['sec-fetch-site'] === 'cross-site') return json(response, 403, { error: '只接受本机页面预览' });
        if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: '请使用 JSON 提交参数' });
        void bodyJson(request, 24000).then(body => {
          try {
            const version = /^[1-9]\d*$/.test(parts[3]) ? Number(parts[3]) : NaN;
            if (!Number.isSafeInteger(version)) return json(response, 400, { error: '无效版本号' });
            const detail = readWorkflowVersion(rootDir, parts[2], version);
            if (!detail) return json(response, 404, { error: '流程版本不存在' });
            if (parts[4] === 'execute' || parts[4] === 'trial') {
              if (body.scenarioId !== undefined || body.desktopScenario !== undefined) throw new Error('desktop-scenario-workflow-forbidden');
              if (!controller?.submitWorkflow) return json(response, 503, { error: '指定流程执行服务不可用' });
              if (body.destination !== 'windows' && body.destination !== 'browser' ||
                  body.destination !== detail.workflow.environment || typeof body.definitionHash !== 'string') {
                throw new Error('目标环境与流程环境不匹配或缺少预览的定义摘要');
              }
              const preview = previewWorkflow(detail.workflow, body.values);
              if (preview.definitionHash !== body.definitionHash) return json(response, 409, { error: '流程定义已变化，请重新预览' });
              const taskId = controller.submitWorkflow({ id: parts[2], version,
                definitionHash: body.definitionHash, values: preview.values,
                destination: detail.workflow.environment, ...(parts[4] === 'trial' ? { trial: true } : {}) },
                parseBudgetOverride(body.budget), requestedDesktopTarget(body.desktopTarget));
              return json(response, 202, { taskId, source: 'web-tasks.sqlite' });
            }
            return json(response, 200, previewWorkflow(detail.workflow, body.values));
          } catch (error) { return json(response, 400, { error: String(error) }); }
        }).catch(error => json(response, 400, { error: String(error) }));
        return;
      }
      if (parts[0] === "api" && parts[1] === "desktop" && parts[2] === "vm" &&
        parts.length === 4) {
        if (!vmControl) return json(response, 405, { error: "未配置 Hyper-V 管理" });
        if (!request.headers.origin || !sameOrigin(request) ||
          request.headers["sec-fetch-site"] === "cross-site" ||
          !["127.0.0.1", "localhost"].includes((request.headers.host ?? "").split(":")[0])) {
          return json(response, 403, { error: "只接受本机页面操作 VM" });
        }
        if (!request.headers["content-type"]?.startsWith("application/json")) {
          return json(response, 415, { error: "请使用 JSON 提交操作" });
        }
        if (parts[3] !== "start" && parts[3] !== "console") {
          return json(response, 404, { error: "VM 操作不存在" });
        }
        void bodyJson(request).then(async () => {
          try {
            if (parts[3] === "start") return json(response, 200, { vm: await vmControl.start() });
            await vmControl.openConsole();
            return json(response, 200, { ok: true });
          } catch (error) { return json(response, 503, { error: String(error) }); }
        }).catch((error) => json(response, 400, { error: String(error) }));
        return;
      }
      if (!controller) return json(response, 405, { error: "任务执行功能未启用" });
      if (!sameOrigin(request) || request.headers["sec-fetch-site"] === "cross-site") {
        return json(response, 403, { error: "只接受本机页面提交的任务" });
      }
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        return json(response, 415, { error: "请使用 JSON 提交任务" });
      }
      if (url.pathname !== "/api/tasks" && url.pathname !== '/api/desktop/scenarios/tasks' &&
          !(parts[0] === "api" && parts[1] === "tasks" &&
            ["resume", "pause", "continue", "review", "app-onboarding"].includes(parts[3]) && parts.length === 4)) {
        return json(response, 404, { error: "接口不存在" });
      }
      void bodyJson(request, 24000).then((body) => {
        try {
          if (parts[3] === 'app-onboarding') {
            if (!controller.onboardApp) throw new Error('app-onboarding-service-unavailable');
            if (!request.headers.origin || !['localhost', '127.0.0.1'].includes((request.headers.host ?? '').split(':')[0])) {
              return json(response, 403, { error: 'app-onboarding-local-operator-required' });
            }
            void controller.onboardApp(parts[2], body as unknown as import('./task-app-onboarding.js').TaskAppRequest)
              .then(interaction => json(response, 200, { taskId: parts[2], interaction }))
              .catch(error => json(response, 409, { error: String(error) }));
            return;
          }
          if (url.pathname === '/api/desktop/scenarios/tasks') {
            if (!controller.submitScenario) return json(response, 503, { error: 'desktop-scenario-service-unavailable' });
            if (Object.keys(body).some(key => !['desktopTarget', 'scenarioId', 'budget'].includes(key))) {
              throw new Error('desktop-scenario-fixed-scope: only desktopTarget, scenarioId and budget are accepted');
            }
            const target = requestedDesktopTarget(body.desktopTarget);
            if (!target) throw new Error('desktop-target-required');
            if (Object.keys(body.desktopTarget as object).some(key => !['providerId', 'environmentId'].includes(key))) {
              throw new Error('desktop-scenario-target-selection-only');
            }
            if (typeof body.scenarioId !== 'string' || !body.scenarioId.trim() || body.scenarioId.length > 200) {
              throw new Error('desktop-scenario-required');
            }
            const taskId = controller.submitScenario({ desktopTarget: target, scenarioId: body.scenarioId }, parseBudgetOverride(body.budget));
            return json(response, 202, { taskId, source: 'web-tasks.sqlite' });
          }
          if (url.pathname === "/api/tasks") {
            if (Object.keys(body).some(key => !['goal', 'admin', 'destination', 'criteria', 'constraints', 'budget', 'desktopTarget'].includes(key))) {
              throw new Error('task-fields-not-allowed');
            }
            if (body.scenarioId !== undefined || body.desktopScenario !== undefined) throw new Error('desktop-scenario-explicit-route-required');
            if (typeof body.goal !== "string" || !body.goal.trim()) throw new Error("请输入任务需求");
            if (body.admin !== undefined && typeof body.admin !== "boolean") {
              throw new Error("管理员权限开关必须为布尔值");
            }
            if (body.destination !== undefined && (typeof body.destination !== 'string' || !["browser", "desktop", "host", "guest"].includes(body.destination))) {
              throw new Error("执行位置必须为 browser 或 desktop");
            }
            let goal = body.goal.trim();
            const target = requestedDesktopTarget(body.desktopTarget);
            if (['guest', 'desktop'].includes(body.destination as string) && !target) throw new Error('desktop-target-required');
            if (['host', 'browser'].includes(body.destination as string) && target) throw new Error('desktop-target-destination-conflict');
            for (const [field, label] of [["criteria", "完成条件"], ["constraints", "操作限制"]]) {
              const value = body[field];
              if (value !== undefined && (typeof value !== "string" || value.length > 500)) throw new Error(`${label}必须是最多 500 字的文本`);
              if (typeof value === "string" && value.trim()) goal += `\n${label}：${value.trim()}`;
            }
            if (goal.length > 4000) throw new Error("任务要求最多 4000 字");
            const taskId = controller.submit(goal, { admin: body.admin === true,
              budget: parseBudgetOverride(body.budget), ...(target ? { desktopTarget: target } : {}) });
            return json(response, 202, { taskId, source: "web-tasks.sqlite" });
          }
          if (parts[3] === "pause") {
            controller.pause(parts[2]);
            return json(response, 202, { taskId: parts[2] });
          }
          if (parts[3] === "continue") {
            controller.continue(parts[2]);
            return json(response, 202, { taskId: parts[2] });
          }
          if (parts[3] === 'review') {
            if (!controller.reviewOutcome) throw new Error('人工结果验收未启用');
            if (typeof body.approved !== 'boolean' || typeof body.note !== 'string') {
              throw new Error('请提交人工核对结论与依据');
            }
            void controller.reviewOutcome(parts[2], { approved: body.approved, note: body.note })
              .then(() => json(response, 200, { taskId: parts[2], approved: body.approved }))
              .catch(error => json(response, 400, { error: String(error) }));
            return;
          }
          if (body.approved !== undefined && typeof body.approved !== "boolean") {
            throw new Error("批准状态必须为布尔值");
          }
          if (body.answer !== undefined && typeof body.answer !== "string") {
            throw new Error("回答必须为文字");
          }
          controller.resume(parts[2], { approved: body.approved, answer: body.answer });
          return json(response, 202, { taskId: parts[2] });
        } catch (error) { return json(response, 400, { error: String(error) }); }
      }).catch((error) => json(response, 400, { error: String(error) }));
      return;
    }
    if (request.method !== "GET") return json(response, 405, { error: "不支持的请求方式" });
    if (url.pathname === '/api/settings/task-budget') return json(response, 200, { budget: globalTaskBudget(rootDir) });
    if (url.pathname === "/api/desktop/control") return json(response, 200, control?.view() ?? { mode: "unavailable" });
    try {
      if (url.pathname === '/api/runtime/plugins') return json(response, 200,
        inspectRuntime?.() ?? { available: false, plugins: [], extensions: [] });
      if (url.pathname === "/api/desktop/sessions") {
        return json(response, 200, { sessions: desktop?.list() ?? [] });
      }
      if (url.pathname === "/api/desktop/vm") {
        if (!vmControl) return json(response, 200, { configured: false });
        void vmControl.status().then((vm) => json(response, 200, { configured: true, vm }))
          .catch((error) => json(response, 503, { configured: true, error: String(error) }));
        return;
      }
      if (url.pathname === "/api/runs") return json(response, 200, { runs: listRuns(rootDir) });
      if (url.pathname === "/api/prompts") return json(response, 200, { prompts: listPrompts(rootDir) });
      if (url.pathname === "/api/workflows") return json(response, 200, { workflows: listWorkflows(rootDir), metadata: readWorkflowMetadata(rootDir) });
      if (parts[0] === 'api' && parts[1] === 'workflows' && parts.length === 4) {
        const version = /^[1-9]\d*$/.test(parts[3]) ? Number(parts[3]) : NaN;
        if (!Number.isSafeInteger(version)) return json(response, 400, { error: '无效版本号' });
        const detail = readWorkflowVersion(rootDir, parts[2], version);
        return json(response, detail ? 200 : 404, detail ?? { error: '流程版本不存在' });
      }
      if (parts[0] === "api" && parts[1] === "runs" && parts.length === 4) {
        const run = readRun(rootDir, parts[2], parts[3]);
        return json(response, run ? 200 : 404, run ?? { error: "未找到执行记录" });
      }
      if (parts[0] === "api" && parts[1] === "screenshots" && parts.length === 5) {
        const image = readScreenshot(rootDir, parts[2], parts[3], Number(parts[4]));
        return image ? send(response, 200, image, "image/png") : json(response, 404, { error: "未找到截图" });
      }
      const files: Record<string, [string, string]> = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/app.js": ["app.js", "text/javascript; charset=utf-8"],
        "/style.css": ["style.css", "text/css; charset=utf-8"],
        "/workbench.js": ["workbench.js", "text/javascript; charset=utf-8"],
        "/task-experience.js": ["task-experience.js", "text/javascript; charset=utf-8"],
        "/workbench.css": ["workbench.css", "text/css; charset=utf-8"],
        "/workflow-library.js": ["workflow-library.js", "text/javascript; charset=utf-8"],
        "/runtime-plugins.js": ["runtime-plugins.js", "text/javascript; charset=utf-8"],
      };
      const file = files[url.pathname];
      if (file) return send(response, 200, readFileSync(join(publicDir, file[0])), file[1]);
      return json(response, 404, { error: "页面不存在" });
    } catch (error) {
      return json(response, 500, { error: String(error) });
    }
  });
}

function requestedDesktopTarget(value: unknown) {
  if (value === undefined) return undefined;
  const selected = value as { providerId?: unknown; environmentId?: unknown } | null;
  if (!selected || typeof selected !== 'object' || Array.isArray(selected) ||
      Object.keys(selected).some(key => !['providerId', 'environmentId'].includes(key))) throw new Error('invalid-desktop-target-fields');
  return desktopTarget(selected?.providerId as string, selected?.environmentId as string);
}
