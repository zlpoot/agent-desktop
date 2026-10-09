import { assertTaskDesktopUnchanged, validateTaskDesktop } from '../contracts/task-desktop.js';
import { DatabaseSync } from "node:sqlite";
import type { GroundingAttempt } from "../actions/schema.js";
import type { ActionResolution } from "../actions/action-resolution.js";
import type { ComputerState } from "../graph/state.js";
import type { CapabilityFacts, CapabilityResolution } from "../capabilities/registry.js";
import { adaptLegacyCriteria, assertNoLegacyCriteriaKeys } from "../migration/legacy-criteria-adapter.js";

export interface NodeMetric {
  step: number;
  node: string;
  startedAt: string;
  durationMs: number;
  actor: "model" | "rule" | "runtime" | "system" | "human";
  operator: string;
  modelName?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export class SqliteTrace {
  private readonly db: DatabaseSync;

  constructor(path: string, options?: { journalMode: 'wal' }) {
    this.db = new DatabaseSync(path);
    // Opt-in for the timing-sensitive Hidden Chrome trace. Keep FULL durable
    // commits and the existing transactions/schema; avoid rollback-journal
    // creation/deletion and reader contention on every UI node.
    if (options?.journalMode === 'wal') {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY, goal TEXT NOT NULL, status TEXT NOT NULL,
        step INTEGER NOT NULL, state_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
        step INTEGER NOT NULL, node TEXT NOT NULL, payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_task_id ON events(task_id, id);
      CREATE TABLE IF NOT EXISTS grounding_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, step INTEGER NOT NULL,
        strategy TEXT NOT NULL, matched INTEGER NOT NULL, selected INTEGER NOT NULL,
        executed_ok INTEGER, detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS grounding_task_id ON grounding_attempts(task_id, step);
      CREATE TABLE IF NOT EXISTS node_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
        step INTEGER NOT NULL, node TEXT NOT NULL, started_at TEXT NOT NULL,
        duration_ms REAL NOT NULL, actor TEXT NOT NULL, operator TEXT NOT NULL,
        model_name TEXT, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER
      );
      CREATE INDEX IF NOT EXISTS metrics_task_id ON node_metrics(task_id, step, id);
      CREATE TABLE IF NOT EXISTS capability_resolutions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
        step INTEGER NOT NULL, phase TEXT NOT NULL, operation TEXT NOT NULL,
        environment TEXT NOT NULL, selected TEXT, facts_json TEXT NOT NULL,
        candidates_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS capability_task_id ON capability_resolutions(task_id, step, id);
      CREATE TABLE IF NOT EXISTS action_resolutions (
        task_id TEXT NOT NULL, step INTEGER NOT NULL, selected TEXT NOT NULL,
        reason TEXT NOT NULL, candidates_json TEXT NOT NULL, actual TEXT,
        executed_ok INTEGER, execution_note TEXT,
        PRIMARY KEY(task_id, step)
      );
      CREATE TABLE IF NOT EXISTS action_provider_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
        step INTEGER NOT NULL, provider TEXT NOT NULL, ok INTEGER NOT NULL,
        effect TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS action_attempts_task_id ON action_provider_attempts(task_id, step, id);
      CREATE TABLE IF NOT EXISTS task_controls (
        task_id TEXT PRIMARY KEY, pause_requested INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);
  }

  save(node: string, state: ComputerState): void {
    // 写边界 fail-closed：任何新写入都不得携带历史商品/媒体旧键。
    // load() 已在读取时把旧键迁移为 domainChecks，因此恢复旧任务后的再保存不会触发。
    assertNoLegacyCriteriaKeys(state.completionCriteria);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.load(state.taskId);
      if (previous && !previous.desktopTarget && state.desktopTarget && previous.taskBindingVersion !== 1 &&
          (node !== 'desktop_compatibility_selected' ||
            state.desktopCompatibility?.desktopVmId !== previous.desktopVmId)) {
        throw new Error('explicit-desktop-compatibility-required');
      }
      if (previous) assertTaskDesktopUnchanged(previous, state);
      else validateTaskDesktop(state);
      const now = new Date().toISOString();
      const payload = JSON.stringify(state);
      this.db.prepare(`INSERT INTO tasks (task_id, goal, status, step, state_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET status=excluded.status, step=excluded.step,
        state_json=excluded.state_json, updated_at=excluded.updated_at`).run(
        state.taskId, state.goal, state.status, state.step, payload, now,
      );
      this.db.prepare(`INSERT INTO events (task_id, step, node, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(state.taskId, state.step, node, payload, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  load(taskId: string): ComputerState | undefined {
    const row = this.db.prepare("SELECT state_json FROM tasks WHERE task_id = ?").get(taskId) as
      | { state_json: string } | undefined;
    if (!row) return undefined;
    const state = JSON.parse(row.state_json) as ComputerState;
    // 读取/迁移边界：历史 product/media 旧完成条件在此一次性翻译为 domainChecks；
    // 核心验收器从不识别旧键，也不保留 fallback。
    const adaptation = adaptLegacyCriteria(state.completionCriteria);
    if (adaptation.adapted) state.completionCriteria = adaptation.criteria;
    return state;
  }

  unfinishedDesktopTasks(): ComputerState[] {
    const rows = this.db.prepare("SELECT state_json FROM tasks WHERE status IN ('running','pause_requested','paused','waiting_user')")
      .all() as Array<{ state_json: string }>;
    return rows.map(row => JSON.parse(row.state_json) as ComputerState)
      .map((state) => {
        // 与 load() 同一迁移边界：恢复路由读到的旧任务也先翻译成 domainChecks。
        const adaptation = adaptLegacyCriteria(state.completionCriteria);
        if (adaptation.adapted) state.completionCriteria = adaptation.criteria;
        return state;
      })
      .filter(state => !!state.desktopTarget || !!state.desktopVmId || !!state.desktopBinding ||
        state.taskContract?.environment === "windows");
  }

  requestPause(taskId: string): void {
    this.db.prepare(`INSERT INTO task_controls (task_id, pause_requested, updated_at)
      VALUES (?, 1, ?) ON CONFLICT(task_id) DO UPDATE SET
      pause_requested=1, updated_at=excluded.updated_at`).run(taskId, new Date().toISOString());
  }

  pauseRequested(taskId: string): boolean {
    const row = this.db.prepare("SELECT pause_requested FROM task_controls WHERE task_id=?")
      .get(taskId) as { pause_requested: number } | undefined;
    return row?.pause_requested === 1;
  }

  clearPause(taskId: string): void {
    this.db.prepare(`INSERT INTO task_controls (task_id, pause_requested, updated_at)
      VALUES (?, 0, ?) ON CONFLICT(task_id) DO UPDATE SET
      pause_requested=0, updated_at=excluded.updated_at`).run(taskId, new Date().toISOString());
  }

  events(taskId: string): Array<{ step: number; node: string; state: ComputerState }> {
    const rows = this.db.prepare("SELECT step, node, payload_json FROM events WHERE task_id = ? ORDER BY id")
      .all(taskId) as Array<{ step: number; node: string; payload_json: string }>;
    return rows.map(({ step, node, payload_json }) => ({ step, node, state: JSON.parse(payload_json) as ComputerState }));
  }

  recordGrounding(taskId: string, step: number, attempts: readonly GroundingAttempt[]): void {
    const insert = this.db.prepare(`INSERT INTO grounding_attempts
      (task_id, step, strategy, matched, selected, detail) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const attempt of attempts) {
      insert.run(taskId, step, attempt.strategy, Number(attempt.matched),
        Number(attempt.selected), attempt.detail);
    }
  }

  recordGroundingExecution(taskId: string, step: number, ok: boolean): void {
    this.db.prepare(`UPDATE grounding_attempts SET executed_ok = ?
      WHERE task_id = ? AND step = ? AND selected = 1`).run(Number(ok), taskId, step);
  }

  recordNodeMetric(taskId: string, metric: NodeMetric): void {
    this.db.prepare(`INSERT INTO node_metrics
      (task_id, step, node, started_at, duration_ms, actor, operator, model_name,
       input_tokens, output_tokens, total_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(taskId, metric.step,
      metric.node, metric.startedAt, metric.durationMs, metric.actor, metric.operator,
      metric.modelName ?? null, metric.inputTokens ?? null, metric.outputTokens ?? null,
      metric.totalTokens ?? null);
  }

  metrics(taskId: string): NodeMetric[] {
    const rows = this.db.prepare(`SELECT step, node, started_at AS startedAt,
      duration_ms AS durationMs, actor, operator, model_name AS modelName,
      input_tokens AS inputTokens, output_tokens AS outputTokens, total_tokens AS totalTokens
      FROM node_metrics WHERE task_id = ? ORDER BY id`).all(taskId) as unknown as Array<NodeMetric & {
        modelName: string | null; inputTokens: number | null; outputTokens: number | null;
        totalTokens: number | null;
      }>;
    return rows.map((row) => ({ ...row, modelName: row.modelName ?? undefined,
      inputTokens: row.inputTokens ?? undefined, outputTokens: row.outputTokens ?? undefined,
      totalTokens: row.totalTokens ?? undefined }));
  }

  recordCapabilityResolution(taskId: string, step: number, phase: string,
    resolution: CapabilityResolution, facts: CapabilityFacts): void {
    this.db.prepare(`INSERT INTO capability_resolutions
      (task_id, step, phase, operation, environment, selected, facts_json, candidates_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(taskId, step, phase, resolution.operation,
      resolution.environment, resolution.selected ?? null, JSON.stringify(facts),
      JSON.stringify(resolution.candidates), new Date().toISOString());
  }

  recordActionResolution(taskId: string, step: number, resolution: ActionResolution): void {
    this.db.prepare(`INSERT INTO action_resolutions
      (task_id, step, selected, reason, candidates_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id, step) DO UPDATE SET selected=excluded.selected,
      reason=excluded.reason, candidates_json=excluded.candidates_json,
      actual=NULL, executed_ok=NULL, execution_note=NULL`).run(taskId, step,
      resolution.selected, resolution.reason, JSON.stringify(resolution.candidates));
  }

  recordActionExecution(taskId: string, step: number, actual: string | undefined,
    ok: boolean, note: string): void {
    this.db.prepare(`UPDATE action_resolutions SET actual=?, executed_ok=?, execution_note=?
      WHERE task_id=? AND step=?`).run(actual ?? null, Number(ok), note, taskId, step);
  }

  recordProviderAttempt(taskId: string, step: number, provider: string,
    ok: boolean, effect: "none" | "uncertain" | "dispatched", message: string): void {
    this.db.prepare(`INSERT INTO action_provider_attempts
      (task_id, step, provider, ok, effect, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(taskId, step, provider, Number(ok), effect, message, new Date().toISOString());
  }

  providerAttempts(taskId: string): Array<{ step: number; provider: string; ok: boolean;
    effect: "none" | "uncertain" | "dispatched"; message: string }> {
    const rows = this.db.prepare(`SELECT step, provider, ok, effect, message
      FROM action_provider_attempts WHERE task_id=? ORDER BY id`).all(taskId) as Array<{
      step: number; provider: string; ok: number;
      effect: "none" | "uncertain" | "dispatched"; message: string }>;
    return rows.map((row) => ({ ...row, ok: !!row.ok }));
  }

  actionResolutions(taskId: string): Array<{ step: number; selected: string; reason: string;
    candidates: ActionResolution["candidates"]; actual?: string; executedOk?: boolean;
    executionNote?: string }> {
    const rows = this.db.prepare(`SELECT step, selected, reason, candidates_json,
      actual, executed_ok, execution_note FROM action_resolutions WHERE task_id=? ORDER BY step`)
      .all(taskId) as Array<{ step: number; selected: string; reason: string; candidates_json: string;
        actual: string | null; executed_ok: number | null; execution_note: string | null }>;
    return rows.map((row) => ({ step: row.step, selected: row.selected, reason: row.reason,
      candidates: JSON.parse(row.candidates_json) as ActionResolution["candidates"],
      actual: row.actual ?? undefined, executedOk: row.executed_ok === null ? undefined : !!row.executed_ok,
      executionNote: row.execution_note ?? undefined }));
  }

  groundingStats(taskId?: string): Array<{
    strategy: string; attempts: number; matches: number; selections: number;
    executedSuccesses: number; executedFailures: number;
    matchRate: number; executionSuccessRate: number | null;
  }> {
    const rows = this.db.prepare(`SELECT strategy, COUNT(*) AS attempts,
      SUM(matched) AS matches, SUM(selected) AS selections,
      SUM(CASE WHEN executed_ok = 1 THEN 1 ELSE 0 END) AS executedSuccesses,
      SUM(CASE WHEN executed_ok = 0 THEN 1 ELSE 0 END) AS executedFailures
      FROM grounding_attempts WHERE (? IS NULL OR task_id = ?)
      GROUP BY strategy ORDER BY strategy`).all(taskId ?? null, taskId ?? null);
    return (rows as Array<{
      strategy: string; attempts: number; matches: number; selections: number;
      executedSuccesses: number; executedFailures: number;
    }>).map((row) => ({
      ...row,
      matchRate: row.matches / row.attempts,
      executionSuccessRate: row.executedSuccesses + row.executedFailures > 0
        ? row.executedSuccesses / (row.executedSuccesses + row.executedFailures) : null,
    }));
  }

  close(): void { this.db.close(); }
}
