import { DatabaseSync } from "node:sqlite";
import { semanticTarget } from "../actions/semantic-target.js";
import type { Workflow } from "./schema.js";
import { workflowDigest } from './recovery.js';

export class WorkflowStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: 1000 });
    this.db.exec(`CREATE TABLE IF NOT EXISTS workflows (
      workflow_id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
      environment TEXT NOT NULL, task_pattern TEXT NOT NULL, source_task_id TEXT NOT NULL,
      data_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(workflow_id, version)
    );
    CREATE INDEX IF NOT EXISTS workflows_environment ON workflows(environment, status);
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, version INTEGER NOT NULL,
      task_id TEXT NOT NULL, stage_id TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL, reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workflow_runs_id ON workflow_runs(workflow_id, version, id);`);
    const columns = this.db.prepare("PRAGMA table_info(workflow_runs)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "stage_id")) {
      this.db.exec("ALTER TABLE workflow_runs ADD COLUMN stage_id TEXT NOT NULL DEFAULT ''");
    }
  }

  addCandidate(proposed: Workflow): Workflow {
    if (proposed.status !== "candidate" || !proposed.steps.length || !proposed.sourceTaskId) {
      throw new Error("只能保存有来源且包含语义步骤的候选流程");
    }
    const prior = this.db.prepare(`SELECT MAX(version) AS version FROM workflows WHERE workflow_id = ?`)
      .get(proposed.id) as { version: number | null };
    const workflow = { ...proposed, version: (prior.version ?? 0) + 1,
      createdAt: new Date().toISOString(), successCount: 0, failureCount: 0 };
    this.db.prepare(`INSERT INTO workflows
      (workflow_id, version, status, environment, task_pattern, source_task_id, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(workflow.id, workflow.version, workflow.status,
      workflow.environment, workflow.taskPattern, workflow.sourceTaskId,
      JSON.stringify(workflow), workflow.createdAt);
    return workflow;
  }

  get(id: string, version: number): Workflow | undefined {
    const row = this.db.prepare(`SELECT data_json FROM workflows WHERE workflow_id = ? AND version = ?`)
      .get(id, version) as { data_json: string } | undefined;
    return row ? JSON.parse(row.data_json) as Workflow : undefined;
  }

  list(environment?: Workflow["environment"]): Workflow[] {
    const rows = this.db.prepare(`SELECT data_json FROM workflows
      WHERE (? IS NULL OR environment = ?) ORDER BY created_at DESC`)
      .all(environment ?? null, environment ?? null) as Array<{ data_json: string }>;
    return rows.map((row) => JSON.parse(row.data_json) as Workflow);
  }

  /** 只补可确定的语义目标；不改动作、版本、状态或原有验收数据。 */
  migrateSemanticTargets(): { scanned: number; updated: number; steps: number } {
    const rows = this.db.prepare("SELECT workflow_id, version, data_json FROM workflows")
      .all() as Array<{ workflow_id: string; version: number; data_json: string }>;
    let updated = 0;
    let steps = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const save = this.db.prepare(`UPDATE workflows SET data_json = ?
        WHERE workflow_id = ? AND version = ?`);
      for (const row of rows) {
        const workflow = JSON.parse(row.data_json) as Workflow;
        let changed = false;
        workflow.steps = workflow.steps.map((step) => {
          if (step.semanticTarget) return step;
          const action = step.action;
          const target = action.kind === "click" || action.kind === "double_click" ||
            action.kind === "type" || action.kind === "paste_text" ? action.target : undefined;
          const semantic = target ? semanticTarget(target) :
            step.targetHint ? semanticTarget(step.targetHint) : undefined;
          if (!semantic) return step;
          changed = true;
          steps++;
          return { ...step, semanticTarget: semantic };
        });
        if (!changed) continue;
        save.run(JSON.stringify(workflow), row.workflow_id, row.version);
        updated++;
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { scanned: rows.length, updated, steps };
  }

  recordReplay(id: string, version: number, taskId: string, success: boolean, reason?: string,
    expectedDefinitionHash?: string, promotion: "automatic" | "record_only" = "automatic",
    stageId = ""): Workflow {
    this.db.exec('BEGIN IMMEDIATE');
    try {
    const workflow = this.get(id, version);
    if (!workflow) throw new Error("流程版本不存在");
    if (workflow.status === 'retired' || expectedDefinitionHash &&
        workflowDigest(workflow) !== expectedDefinitionHash) {
      throw new Error('原版本已撤回或定义已改变，不能更新验证结果');
    }
    if (this.db.prepare(`SELECT 1 FROM workflow_runs
      WHERE workflow_id=? AND version=? AND task_id=? AND stage_id=?`).get(id, version, taskId, stageId)) {
      this.db.exec('COMMIT'); return workflow;
    }
    const now = new Date().toISOString();
    const updated: Workflow = { ...workflow, status: success && promotion === "automatic" ? "verified" : workflow.status,
      successCount: workflow.successCount + Number(success),
      failureCount: workflow.failureCount + Number(!success),
      lastVerifiedAt: success ? now : workflow.lastVerifiedAt,
      knownFailures: !success && reason ? [...new Set([...workflow.knownFailures, reason])].slice(-20)
        : workflow.knownFailures };
      this.db.prepare(`UPDATE workflows SET status = ?, data_json = ?
        WHERE workflow_id = ? AND version = ?`).run(updated.status, JSON.stringify(updated), id, version);
      this.db.prepare(`INSERT INTO workflow_runs
        (workflow_id, version, task_id, stage_id, outcome, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, version, taskId, stageId, success ? "success" : "failure", reason ?? null, now);
      this.db.exec("COMMIT");
      return updated;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  publish(id: string, version: number, expectedDefinitionHash: string,
    expectedSuccessCount: number, expectedFailureCount: number): Workflow {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const workflow = this.get(id, version);
      if (!workflow) throw new Error('流程版本不存在');
      if (workflow.status !== 'candidate') throw new Error('只有候选版本可以发布');
      if (workflow.scope === 'stage') throw new Error('阶段流程由阶段验收管理，不能在整任务流程库发布');
      if (workflowDigest(workflow) !== expectedDefinitionHash ||
        workflow.successCount !== expectedSuccessCount || workflow.failureCount !== expectedFailureCount) {
        throw new Error('流程定义或回放记录已变化，请刷新后重新审核');
      }
      if (workflow.successCount < 1) throw new Error('至少需要一次成功试运行才能发布');
      const updated: Workflow = { ...workflow, status: 'verified' };
      this.db.prepare('UPDATE workflows SET status=?, data_json=? WHERE workflow_id=? AND version=?')
        .run(updated.status, JSON.stringify(updated), id, version);
      this.db.exec('COMMIT');
      return updated;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  close(): void { this.db.close(); }
}
