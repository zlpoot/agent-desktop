import { mkdirSync } from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { WorkflowStore } from "../src/workflows/store.js";

const source = resolve("workflows.sqlite");
const backupPath = resolve(".artifacts", "workflow-backups",
  `workflows-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
mkdirSync(dirname(backupPath), { recursive: true });
const database = new DatabaseSync(source, { readOnly: true });
try { await backup(database, backupPath); }
finally { database.close(); }
const store = new WorkflowStore(source);
try {
  const result = store.migrateSemanticTargets();
  process.stdout.write(`已备份：${backupPath}\n扫描 ${result.scanned} 个流程版本，更新 ${result.updated} 个版本、${result.steps} 个语义目标。\n`);
} finally { store.close(); }
