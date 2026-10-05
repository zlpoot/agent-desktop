import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Workflow } from '../workflows/schema.js';
import { workflowDigest } from '../workflows/recovery.js';
import { instantiateWorkflow } from '../workflows/matcher.js';

export function readWorkflowMetadata(root: string): Record<string, { displayName: string; description: string; revision: number }> {
  const path = join(root, 'workflows.sqlite');
  if (!existsSync(path)) return {};
  const db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_metadata'").get()) return {};
    const rows = db.prepare('SELECT workflow_id, display_name, description, revision FROM workflow_metadata').all() as Array<{ workflow_id: string; display_name: string; description: string; revision: number }>;
    return Object.fromEntries(rows.map(row => [row.workflow_id, { displayName: row.display_name, description: row.description, revision: row.revision }]));
  } finally { db.close(); }
}

export function saveWorkflowMetadata(root: string, id: string, body: Record<string, unknown>) {
  if (typeof body.displayName !== 'string' || !body.displayName.trim() || body.displayName.trim().length > 80 ||
    typeof body.description !== 'string' || body.description.length > 500 || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0) throw new Error('名称须为 1–80 字，说明最多 500 字，且需携带有效修订号');
  const path = join(root, 'workflows.sqlite');
  if (!existsSync(path)) throw new Error('流程不存在');
  const db = new DatabaseSync(path, { timeout: 1000 });
  try {
    if (!db.prepare('SELECT 1 FROM workflows WHERE workflow_id=?').get(id)) throw new Error('流程不存在');
    db.exec('CREATE TABLE IF NOT EXISTS workflow_metadata (workflow_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, description TEXT NOT NULL, revision INTEGER NOT NULL)');
    db.exec('BEGIN IMMEDIATE');
    try {
      const prior = db.prepare('SELECT revision FROM workflow_metadata WHERE workflow_id=?').get(id) as { revision: number } | undefined;
      if ((prior?.revision ?? 0) !== body.revision) { db.exec('ROLLBACK'); return null; }
      const metadata = { displayName: body.displayName.trim(), description: body.description.trim(), revision: Number(body.revision) + 1 };
      db.prepare('INSERT INTO workflow_metadata VALUES (?,?,?,?) ON CONFLICT(workflow_id) DO UPDATE SET display_name=excluded.display_name,description=excluded.description,revision=excluded.revision')
        .run(id, metadata.displayName, metadata.description, metadata.revision);
      db.exec('COMMIT'); return metadata;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

/** Dashboard queries never create or migrate the execution store. */
export function readWorkflowVersion(root: string, id: string, version: number) {
  const path = join(root, 'workflows.sqlite');
  if (!existsSync(path)) return undefined;
  const db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
  try {
    const row = db.prepare('SELECT data_json FROM workflows WHERE workflow_id=? AND version=?')
      .get(id, version) as { data_json: string } | undefined;
    if (!row) return undefined;
    const workflow = JSON.parse(row.data_json) as Workflow;
    const hasRuns = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_runs'").get();
    const hasStageId = hasRuns && (db.prepare("PRAGMA table_info(workflow_runs)").all() as Array<{ name: string }>)
      .some((column) => column.name === 'stage_id');
    const runs = hasRuns ? db.prepare(`SELECT task_id AS taskId, ${hasStageId ? 'stage_id' : "''"} AS stageId,
      outcome, reason, created_at AS createdAt
      FROM workflow_runs WHERE workflow_id=? AND version=? ORDER BY id DESC LIMIT 100`).all(id, version) : [];
    return { workflow, metadata: readWorkflowMetadata(root)[id] ?? { displayName: '', description: '', revision: 0 }, definitionHash: workflowDigest(workflow), runs,
      runsLimit: 100, runsAvailable: !!hasRuns };
  } finally { db.close(); }
}

export function previewWorkflow(workflow: Workflow, values: unknown) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('参数必须为对象');
  const entries = Object.entries(values);
  const names = new Set(workflow.inputs.map(input => input.name));
  if (entries.some(([name, value]) => !names.has(name) || typeof value !== 'string' || !value.trim() || value.length > 300)) {
    throw new Error('只接受已声明参数，每项须为 1–300 字符的非空文字');
  }
  const params = Object.fromEntries(entries) as Record<string, string>;
  if ([...names].some(name => !Object.hasOwn(params, name))) throw new Error('请填写全部流程参数');
  const preview = instantiateWorkflow({ workflow, values: params, score: 1 });
  return { executed: false, id: workflow.id, version: workflow.version,
    definitionHash: workflowDigest(workflow), values: params,
    steps: preview.steps, preconditions: preview.preconditions,
    stageCondition: preview.stageCondition, successConditions: preview.successConditions };
}
