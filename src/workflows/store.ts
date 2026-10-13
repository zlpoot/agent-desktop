import { DatabaseSync } from "node:sqlite";
import { semanticTarget } from "../actions/semantic-target.js";
import type { Workflow } from "./schema.js";
import { assertKnownWorkflowSchemaVersion } from "./schema.js";
import { migrateWorkflowToV2 } from "./migration.js";
import { workflowDigest } from './recovery.js';

/** 显式迁移结果。created=false 表示同源 v2 已存在，本次幂等返回既有行、未新增版本。 */
export interface WorkflowMigrationResult {
  workflow: Workflow;
  sourceVersion: number;
  created: boolean;
}

/** 按键排序消除字段顺序影响；数组顺序仍属于定义。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function definitionKey(workflow: Workflow): string {
  // 正面列出稳定定义，运行证据与计数（包括 knownFailures）不参与迁移身份。
  return canonicalJson({ id: workflow.id, workflowSchemaVersion: workflow.workflowSchemaVersion,
    scope: workflow.scope, stageCondition: workflow.stageCondition, environment: workflow.environment,
    taskPattern: workflow.taskPattern, inputs: workflow.inputs, preconditions: workflow.preconditions,
    steps: workflow.steps, successConditions: workflow.successConditions,
    durableContract: workflow.durableContract, sourceTaskId: workflow.sourceTaskId,
    sourceTrace: workflow.sourceTrace });
}

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
    CREATE INDEX IF NOT EXISTS workflow_runs_id ON workflow_runs(workflow_id, version, id);
    CREATE TABLE IF NOT EXISTS workflow_v2_migrations (
      workflow_id TEXT NOT NULL, source_version INTEGER NOT NULL, target_version INTEGER NOT NULL,
      PRIMARY KEY(workflow_id, source_version, target_version)
    );`);
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

  /**
   * 显式 v1→v2 迁移（Issue #75）：**仅 INSERT 同族新版本 candidate**，绝不 UPDATE / DELETE 源行。
   * - 完全复用既有 `migrateWorkflowToV2()`（回到 candidate、清零计数、确定性 stepId）
   *   与既有 `addCandidate()`（自增 version 写入新行），不重新实现任何已有转换；
   * - 幂等：同源记录版本、同稳定定义的 v2 已存在时返回既有行（包括已 replay 的行）；
   *   来源关系单独落库，不改变 Workflow JSON，也不把不同 v1 版本误认成同一来源；
   * - 源行 `data_json` 迁移前后逐字节相同，一旦观测到变动即抛错回滚；
   * - 拒绝：源不存在、JSON 身份与源主键不一致、源已是 v2、源为未知 schema；
   * - 产物不继承 verified / successCount / failureCount / lastVerifiedAt，必须重新完整
   *   replay + verification 后才可晋级 verified。
   */
  migrateWorkflowToV2(sourceId: string, sourceVersion: number): WorkflowMigrationResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const sourceRow = this.db.prepare(`SELECT data_json FROM workflows
        WHERE workflow_id = ? AND version = ?`).get(sourceId, sourceVersion) as
        { data_json: string } | undefined;
      if (!sourceRow) {
        throw new Error(`源流程版本不存在：workflowId=${sourceId} version=${sourceVersion}`);
      }
      const source = JSON.parse(sourceRow.data_json) as Workflow;
      if (source?.id !== sourceId || source?.version !== sourceVersion) {
        throw new Error(`workflow-migration-source-identity-mismatch ` +
          `(workflowId=${sourceId}, version=${sourceVersion}, source=WorkflowStore.migrateWorkflowToV2)`);
      }
      assertKnownWorkflowSchemaVersion(source, "WorkflowStore.migrateWorkflowToV2");
      if (source.workflowSchemaVersion === 2) {
        throw new Error(`源流程已是 v2，无需迁移：workflowId=${sourceId} version=${sourceVersion}`);
      }
      const target = migrateWorkflowToV2(source);
      const existing = this.equivalentV2Candidate(sourceId, sourceVersion, target);
      if (existing) {
        this.db.exec("COMMIT");
        return { workflow: existing, sourceVersion, created: false };
      }
      const created = this.addCandidate(target);
      this.db.prepare(`INSERT INTO workflow_v2_migrations
        (workflow_id, source_version, target_version) VALUES (?, ?, ?)`)
        .run(sourceId, sourceVersion, created.version);
      const afterRow = this.db.prepare(`SELECT data_json FROM workflows
        WHERE workflow_id = ? AND version = ?`).get(sourceId, sourceVersion) as
        { data_json: string } | undefined;
      if (afterRow?.data_json !== sourceRow.data_json) {
        throw new Error(`源记录被意外修改，迁移中止并回滚：workflowId=${sourceId} version=${sourceVersion}`);
      }
      this.db.exec("COMMIT");
      return { workflow: created, sourceVersion, created: true };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  /** 同源记录版本、同稳定定义的 v2；状态晋级/计数变化不改变来源。只读。 */
  private equivalentV2Candidate(id: string, sourceVersion: number, target: Workflow): Workflow | undefined {
    const rows = this.db.prepare(`SELECT w.data_json FROM workflows w
      JOIN workflow_v2_migrations m ON m.workflow_id = w.workflow_id AND m.target_version = w.version
      WHERE m.workflow_id = ? AND m.source_version = ? ORDER BY w.version`)
      .all(id, sourceVersion) as Array<{ data_json: string }>;
    const key = definitionKey(target);
    for (const row of rows) {
      const candidate = JSON.parse(row.data_json) as Workflow;
      if (candidate.workflowSchemaVersion !== 2) continue;
      if (definitionKey(candidate) === key) return candidate;
    }
    // 旧实现/手工 INSERT 的 v2 没有可证明的源记录版本。不能猜来源或再制造重复行。
    const untracked = this.db.prepare(`SELECT w.data_json FROM workflows w
      LEFT JOIN workflow_v2_migrations m ON m.workflow_id = w.workflow_id AND m.target_version = w.version
      WHERE w.workflow_id = ? AND m.target_version IS NULL`).all(id) as Array<{ data_json: string }>;
    if (untracked.some((row) => {
      const candidate = JSON.parse(row.data_json) as Workflow;
      return candidate.workflowSchemaVersion === 2 && definitionKey(candidate) === key;
    })) {
      throw new Error(`既有 v2 定义缺少迁移来源记录，拒绝重复迁移：workflowId=${id} version=${sourceVersion}`);
    }
    return undefined;
  }

  /**
   * 读取守卫：未知 `workflowSchemaVersion`（3 / null / "2" / …）在此 fail-closed，
   * 不会被自动当成 v1，也因此不可能进入 matcher / preview / replay / publish。
   * 已知版本（缺省 / 1 / 2）的读取与返回值保持不变。本方法不改写数据库。
   */
  get(id: string, version: number): Workflow | undefined {
    const row = this.db.prepare(`SELECT data_json FROM workflows WHERE workflow_id = ? AND version = ?`)
      .get(id, version) as { data_json: string } | undefined;
    if (!row) return undefined;
    const workflow = JSON.parse(row.data_json) as Workflow;
    assertKnownWorkflowSchemaVersion(workflow, "WorkflowStore.get");
    return workflow;
  }

  /** 逐行应用与 get 相同的未知版本守卫；任一未知版本使整个读取 fail-closed。 */
  list(environment?: Workflow["environment"]): Workflow[] {
    const rows = this.db.prepare(`SELECT data_json FROM workflows
      WHERE (? IS NULL OR environment = ?) ORDER BY created_at DESC`)
      .all(environment ?? null, environment ?? null) as Array<{ data_json: string }>;
    return rows.map((row) => {
      const workflow = JSON.parse(row.data_json) as Workflow;
      assertKnownWorkflowSchemaVersion(workflow, "WorkflowStore.list");
      return workflow;
    });
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
