import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type ModelKind = 'deepseek' | 'jev';
export type BudgetLimit = { maxCalls: number; maxTokens: number };
export type TaskBudget = Record<ModelKind, BudgetLimit>;
export type BudgetOverride = Partial<Record<ModelKind, Partial<BudgetLimit>>>;
export type BudgetUsage = Record<ModelKind, { calls: number; tokens: number; unreportedCalls: number }>;
export type BudgetSnapshot = { limits: TaskBudget; usage: BudgetUsage; stoppedReason?: string };

export const DEFAULT_TASK_BUDGET: TaskBudget = {
  deepseek: { maxCalls: 24, maxTokens: 60000 },
  jev: { maxCalls: 120, maxTokens: 300000 },
};
const context = new AsyncLocalStorage<{ rootDir: string; taskId: string }>();

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1000000)
    throw new Error(`${label}必须是 1 到 1000000 的整数`);
  return value as number;
}

export function parseBudgetOverride(value: unknown): BudgetOverride | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('任务预算必须是对象');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== 'deepseek' && key !== 'jev')) throw new Error('未知的模型预算类型');
  const result: BudgetOverride = {};
  for (const kind of ['deepseek', 'jev'] as const) {
    if (input[kind] === undefined) continue;
    const item = input[kind];
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${kind} 预算必须是对象`);
    const fields = item as Record<string, unknown>;
    if (Object.keys(fields).some(key => key !== 'maxCalls' && key !== 'maxTokens')) throw new Error(`${kind} 预算含未知字段`);
    result[kind] = {};
    if (fields.maxCalls !== undefined) result[kind].maxCalls = integer(fields.maxCalls, `${kind} 调用次数`);
    if (fields.maxTokens !== undefined) result[kind].maxTokens = integer(fields.maxTokens, `${kind} Token 数`);
  }
  return result;
}

export function globalTaskBudget(rootDir: string): TaskBudget {
  try {
    const value: unknown = JSON.parse(readFileSync(resolve(rootDir, 'config', 'task-budget.json'), 'utf8'));
    const override = parseBudgetOverride(value);
    return mergeBudget(DEFAULT_TASK_BUDGET, override);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_TASK_BUDGET);
    throw error;
  }
}

export function mergeBudget(base: TaskBudget, override?: BudgetOverride): TaskBudget {
  return { deepseek: { ...base.deepseek, ...override?.deepseek }, jev: { ...base.jev, ...override?.jev } };
}

export function saveGlobalTaskBudget(rootDir: string, value: unknown): TaskBudget {
  const override = parseBudgetOverride(value);
  if (!override?.deepseek || !override.jev ||
      Object.keys(override.deepseek).length !== 2 || Object.keys(override.jev).length !== 2)
    throw new Error('全局预算必须完整填写两种模型的调用次数与 Token 数');
  const budget = mergeBudget(DEFAULT_TASK_BUDGET, override);
  const dir = resolve(rootDir, 'config');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, 'task-budget.json');
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(budget, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
  return budget;
}

function dbFor(rootDir: string): DatabaseSync {
  const db = new DatabaseSync(resolve(rootDir, 'web-task-budgets.sqlite'));
  db.exec(`CREATE TABLE IF NOT EXISTS task_budgets (
    task_id TEXT PRIMARY KEY, limits_json TEXT NOT NULL, usage_json TEXT NOT NULL,
    stopped_reason TEXT)`);
  return db;
}

const emptyUsage = (): BudgetUsage => ({
  deepseek: { calls: 0, tokens: 0, unreportedCalls: 0 },
  jev: { calls: 0, tokens: 0, unreportedCalls: 0 },
});

export function createTaskBudget(rootDir: string, taskId: string, override?: BudgetOverride): BudgetSnapshot {
  const snapshot: BudgetSnapshot = { limits: mergeBudget(globalTaskBudget(rootDir), parseBudgetOverride(override)), usage: emptyUsage() };
  const db = dbFor(rootDir);
  try { db.prepare('INSERT INTO task_budgets (task_id, limits_json, usage_json) VALUES (?, ?, ?)')
    .run(taskId, JSON.stringify(snapshot.limits), JSON.stringify(snapshot.usage)); }
  finally { db.close(); }
  return snapshot;
}

export function readTaskBudget(rootDir: string, taskId: string): BudgetSnapshot | undefined {
  const db = dbFor(rootDir);
  try {
    const row = db.prepare('SELECT limits_json, usage_json, stopped_reason FROM task_budgets WHERE task_id=?')
      .get(taskId) as { limits_json: string; usage_json: string; stopped_reason: string | null } | undefined;
    return row ? { limits: JSON.parse(row.limits_json) as TaskBudget,
      usage: JSON.parse(row.usage_json) as BudgetUsage,
      ...(row.stopped_reason ? { stoppedReason: row.stopped_reason } : {}) } : undefined;
  } finally { db.close(); }
}

/** The next model call would be refused, so pause at the graph's safe boundary. */
export function currentBudgetStopReason(): string | undefined {
  const task = context.getStore();
  if (!task) return undefined;
  const snapshot = readTaskBudget(task.rootDir, task.taskId);
  if (!snapshot) return undefined;
  for (const kind of ['deepseek', 'jev'] as const) {
    const used = snapshot.usage[kind], limit = snapshot.limits[kind];
    if (used.calls >= limit.maxCalls || used.tokens >= limit.maxTokens) {
      const reason = `${kind} 预算已用尽：调用 ${used.calls}/${limit.maxCalls}，Token ${used.tokens}/${limit.maxTokens}；任务已暂停，可调整预算后新建任务`;
      const db = dbFor(task.rootDir);
      try { db.prepare('UPDATE task_budgets SET stopped_reason=? WHERE task_id=?').run(reason, task.taskId); }
      finally { db.close(); }
      return reason;
    }
  }
  return undefined;
}

export class BudgetExceededError extends Error {
  constructor(message: string) { super(message); this.name = 'BudgetExceededError'; }
}
export const isBudgetExceeded = (error: unknown): error is BudgetExceededError => error instanceof BudgetExceededError;

export function runWithTaskBudget<T>(rootDir: string, taskId: string, work: () => Promise<T>): Promise<T> {
  return context.run({ rootDir, taskId }, work);
}

/** Counts the request before dispatch; actual tokens are recorded from the response. */
export async function meteredModelRequest<T extends { usage?: unknown }>(
  kind: ModelKind, request: () => Promise<T>): Promise<T> {
  const task = context.getStore();
  if (!task) return request();
  const db = dbFor(task.rootDir);
  try {
    const row = db.prepare('SELECT limits_json, usage_json FROM task_budgets WHERE task_id=?')
      .get(task.taskId) as { limits_json: string; usage_json: string } | undefined;
    if (!row) throw new Error('任务预算记录缺失');
    const limits = JSON.parse(row.limits_json) as TaskBudget;
    const usage = JSON.parse(row.usage_json) as BudgetUsage;
    const used = usage[kind], limit = limits[kind];
    if (used.calls >= limit.maxCalls || used.tokens >= limit.maxTokens) {
      const reason = `${kind} 预算已用尽：调用 ${used.calls}/${limit.maxCalls}，Token ${used.tokens}/${limit.maxTokens}；任务已暂停，可调整预算后新建任务`;
      db.prepare('UPDATE task_budgets SET stopped_reason=? WHERE task_id=?').run(reason, task.taskId);
      throw new BudgetExceededError(reason);
    }
    used.calls++;
    used.unreportedCalls++;
    db.prepare('UPDATE task_budgets SET usage_json=? WHERE task_id=?').run(JSON.stringify(usage), task.taskId);
  } finally { db.close(); }
  const response = await request();
  const raw = response.usage;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const fields = raw as Record<string, unknown>;
    const total = kind === 'deepseek' ? fields.total_tokens : undefined;
    const input = fields[kind === 'deepseek' ? 'prompt_tokens' : 'input_tokens'];
    const output = fields[kind === 'deepseek' ? 'completion_tokens' : 'output_tokens'];
    const tokens = typeof total === 'number' ? total : typeof input === 'number' && typeof output === 'number' ? input + output : undefined;
    if (tokens !== undefined && Number.isSafeInteger(tokens) && tokens >= 0) {
      const db = dbFor(task.rootDir);
      try {
        const row = db.prepare('SELECT usage_json FROM task_budgets WHERE task_id=?')
          .get(task.taskId) as { usage_json: string };
        const usage = JSON.parse(row.usage_json) as BudgetUsage;
        usage[kind].tokens += tokens;
        usage[kind].unreportedCalls--;
        db.prepare('UPDATE task_budgets SET usage_json=? WHERE task_id=?').run(JSON.stringify(usage), task.taskId);
      } finally { db.close(); }
    }
  }
  return response;
}
