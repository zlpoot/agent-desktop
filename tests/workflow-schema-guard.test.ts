import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Workflow } from "../src/workflows/schema.js";
import { workflowDigest } from "../src/workflows/recovery.js";
import { WorkflowStore } from "../src/workflows/store.js";
import { readWorkflowVersion } from "../src/app/workflow-view.js";
import { createDashboardServer } from "../src/app/server.js";
import { selectWorkflow } from "../src/workflows/matcher.js";

/**
 * R1.3 / U3（Issue #75）定向回归：
 * 1. 未知 workflowSchemaVersion 在 Store.get/list、详情入口、Dashboard 列表一律 fail-closed；
 * 2. 已知版本（缺省 / 1 / 2）的读取、摘要与 matcher 行为零漂移；
 * 3. 显式 v1→v2 迁移只 INSERT 新版本，源行逐字节不变，且幂等。
 * 全部使用临时 SQLite，不触碰任何真实 workflows 数据。
 */
const base: Workflow = { id: "guard-fixture", version: 1, status: "candidate", environment: "windows",
  taskPattern: "write {{value}}", inputs: [{ name: "value", example: "A" }], preconditions: [],
  steps: [{ goal: "write", action: { kind: "keypress", keys: "a" }, preferredMethods: [],
    successCondition: { kind: "text_includes", value: "{{value}}" } }],
  successConditions: { pageTextIncludes: "{{value}}" }, knownFailures: [], sourceTaskId: "seed",
  sourceTrace: "seed", createdAt: "", successCount: 0, failureCount: 0 };

const REMOVE = Symbol("remove");

interface Temp { dir: string; path: string; store: WorkflowStore; cleanup(): void; }

function temp(name: string, seed: Workflow = base): Temp {
  const dir = mkdtempSync(join(tmpdir(), name));
  const path = join(dir, "workflows.sqlite");
  const store = new WorkflowStore(path);
  if (seed) store.addCandidate(seed.status === "candidate" ? seed : { ...seed, status: "candidate" });
  return { dir, path, store, cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** 绕过 Store 直接改写 data_json，模拟数据库中被写入的未知 schema 版本；返回注入后的行内容。 */
function inject(path: string, value: unknown, id = base.id, version = 1): string {
  const db = new DatabaseSync(path, { timeout: 1000 });
  try {
    const row = db.prepare("SELECT data_json FROM workflows WHERE workflow_id=? AND version=?")
      .get(id, version) as { data_json: string };
    const parsed = JSON.parse(row.data_json) as Record<string, unknown>;
    if (value === REMOVE) delete parsed.workflowSchemaVersion;
    else parsed.workflowSchemaVersion = value;
    const next = JSON.stringify(parsed);
    db.prepare("UPDATE workflows SET data_json=? WHERE workflow_id=? AND version=?")
      .run(next, id, version);
    return next;
  } finally { db.close(); }
}

function rawRows(path: string, id = base.id): Array<{ version: number; data_json: string }> {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
  try {
    return db.prepare("SELECT version, data_json FROM workflows WHERE workflow_id=? ORDER BY version")
      .all(id) as Array<{ version: number; data_json: string }>;
  } finally { db.close(); }
}

const UNKNOWN_VALUES: Array<[string, unknown]> = [
  ["数字 3", 3], ["null", null], ["字符串 \"2\"", "2"], ["布尔 true", true],
  ["小数 2.5", 2.5], ["数组", [2]], ["对象", { kind: 2 }], ["负数 -1", -1],
];

test("Store.get 与 Store.list 对未知 schema 一律 fail-closed，且不泄露行内容", () => {
  for (const [label, value] of UNKNOWN_VALUES) {
    const t = temp("wf-guard-");
    try {
      inject(t.path, value);
      assert.throws(() => t.store.get(base.id, 1), /unsupported-workflow-schema-version/,
        `get 应拒绝 ${label}`);
      assert.throws(() => t.store.list(), /unsupported-workflow-schema-version/,
        `list 应拒绝 ${label}`);
      try {
        t.store.get(base.id, 1);
        assert.fail(`get 未拒绝 ${label}`);
      } catch (error) {
        const message = String(error);
        assert.match(message, new RegExp(`workflowId=${base.id}`), "错误信息须便于定位");
        assert.match(message, /version=1/);
        assert.doesNotMatch(message, /\{\{value\}\}|pageTextIncludes|sourceTaskId|seed/,
          "错误信息不得携带私有定义内容");
      }
    } finally { t.cleanup(); }
  }
});

test("已知 schema（缺省 / 1 / 2）读取、摘要与 list 行为零漂移", () => {
  const absent = temp("wf-known-absent-");
  try {
    const workflow = absent.store.get(base.id, 1)!;
    assert.equal(workflow.workflowSchemaVersion, undefined);
    assert.equal(absent.store.list().length, 1);
    assert.match(workflowDigest(workflow), /^[0-9a-f]{64}$/);
  } finally { absent.cleanup(); }

  for (const explicit of [1, 2] as const) {
    const t = temp("wf-known-");
    try {
      inject(t.path, explicit);
      const workflow = t.store.get(base.id, 1)!;
      assert.equal(workflow.workflowSchemaVersion, explicit);
      assert.equal(t.store.list().length, 1, `= ${explicit} 必须仍可读`);
      if (explicit === 1) {
        assert.equal(workflowDigest(workflow), workflowDigest(base), "显式标注 1 的摘要不得漂移");
      }
    } finally { t.cleanup(); }
  }
});

test("既有 v1 verified 仍可被 matcher 选中（守卫未削弱正常路径）", () => {
  const t = temp("wf-matcher-", { ...base, status: "verified" });
  try {
    t.store.recordReplay(base.id, 1, "seed", true);
    assert.equal(t.store.get(base.id, 1)?.status, "verified");
    const match = selectWorkflow(t.store.list("windows"), "write A");
    assert.ok(match, "已验证 v1 必须仍可匹配");
    assert.equal(match!.workflow.version, 1);
  } finally { t.cleanup(); }
});

test("详情入口 readWorkflowVersion 拒绝未知版本；已知版本正常返回", () => {
  const ok = temp("wf-detail-ok-");
  try {
    const detail = readWorkflowVersion(ok.dir, base.id, 1)!;
    assert.equal(detail.workflow.version, 1);
    assert.match(detail.definitionHash, /^[0-9a-f]{64}$/);
  } finally { ok.cleanup(); }

  for (const value of [3, null, "2", true]) {
    const t = temp("wf-detail-bad-");
    try {
      inject(t.path, value);
      assert.throws(() => readWorkflowVersion(t.dir, base.id, 1),
        /unsupported-workflow-schema-version/, `详情入口应拒绝 ${String(value)}`);
    } finally { t.cleanup(); }
  }
});

test("Dashboard /api/workflows 列表不返回未知版本行（HTTP fail-closed）", async () => {
  const t = temp("wf-api-");
  inject(t.path, 3);
  const server = createDashboardServer(t.dir);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address unavailable");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/workflows`);
    const body = await response.json() as { workflows?: unknown[]; error?: string };
    assert.equal(response.status < 200 || response.status >= 300, true,
      "未知版本不得让列表请求成功返回");
    assert.equal(body.workflows, undefined, "不得把未知版本行当作 v1 返回");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    t.cleanup();
  }
});

test("显式迁移 v1→v2：仅新增版本行，源行逐字节不变，v1/v2 并存", () => {
  const t = temp("wf-migrate-", { ...base, status: "verified" });
  try {
    t.store.recordReplay(base.id, 1, "seed", true);
    const before = rawRows(t.path);
    assert.equal(before.length, 1);
    assert.equal(JSON.parse(before[0].data_json).status, "verified");

    const result = t.store.migrateWorkflowToV2(base.id, 1);

    const after = rawRows(t.path);
    assert.equal(after.length, 2, "必须是 INSERT 新行，不能覆写");
    assert.equal(after[0].data_json, before[0].data_json, "源行 data_json 必须逐字节不变");
    assert.equal(after[0].version, 1, "源版本号不得变动");
    assert.equal(result.created, true);
    assert.equal(result.sourceVersion, 1);
    assert.equal(result.workflow.version, 2);
    assert.equal(result.workflow.workflowSchemaVersion, 2);

    const v1Row = JSON.parse(after[0].data_json) as Workflow;
    const v2Row = JSON.parse(after[1].data_json) as Workflow;
    assert.equal(v1Row.status, "verified", "v1 保持 verified，未被降级");
    assert.equal(v1Row.workflowSchemaVersion, undefined, "v1 仍是 v1");
    assert.notEqual(workflowDigest(v1Row), workflowDigest(v2Row), "v2 摘要必须不同于 v1");
    assert.ok(typeof v2Row.steps[0].stepId === "string" && v2Row.steps[0].stepId!.length > 0);
  } finally { t.cleanup(); }
});

test("迁移产物不继承 verified 与计数，必须重新完整 replay 才晋级", () => {
  const t = temp("wf-noinherit-", { ...base, status: "verified" });
  try {
    t.store.recordReplay(base.id, 1, "seed", true);
    t.store.recordReplay(base.id, 1, "seed-2", true);
    const source = t.store.get(base.id, 1)!;
    assert.equal(source.status, "verified");
    assert.equal(source.successCount, 2);
    assert.ok(source.lastVerifiedAt);

    const result = t.store.migrateWorkflowToV2(base.id, 1);
    assert.equal(result.workflow.status, "candidate", "v2 不得继承旧 success");
    assert.equal(result.workflow.successCount, 0);
    assert.equal(result.workflow.failureCount, 0);
    assert.equal(result.workflow.lastVerifiedAt, undefined);

    const stored = t.store.get(base.id, 2)!;
    assert.equal(stored.status, "candidate");
    assert.throws(() => t.store.publish(base.id, 2, workflowDigest(stored), 0, 0),
      /至少需要一次成功试运行/, "未经 replay 不得发布");
    t.store.recordReplay(base.id, 2, "trial-v2", true, undefined, workflowDigest(stored));
    assert.equal(t.store.get(base.id, 2)?.status, "verified", "完整 replay 后才可晋级");
  } finally { t.cleanup(); }
});

test("重复迁移幂等：返回既有行且 created=false，不制造重复版本", () => {
  const t = temp("wf-idempotent-");
  try {
    const first = t.store.migrateWorkflowToV2(base.id, 1);
    assert.equal(first.created, true);
    const second = t.store.migrateWorkflowToV2(base.id, 1);
    assert.equal(second.created, false, "重复提交必须显式表现为幂等复用");
    assert.equal(second.workflow.version, first.workflow.version, "不得产生新版本号");
    const third = t.store.migrateWorkflowToV2(base.id, 1);
    assert.equal(third.created, false);
    assert.equal(rawRows(t.path).length, 2, "库里只能有 1 条 v1 + 1 条 v2");
    assert.equal(t.store.list().length, 2);
  } finally { t.cleanup(); }
});

test("迁移被拒绝时不损坏源行：源不存在 / 源已 v2 / 源未知 schema", () => {
  const missing = temp("wf-rej-missing-");
  try {
    assert.throws(() => missing.store.migrateWorkflowToV2(base.id, 99), /源流程版本不存在/);
    assert.equal(rawRows(missing.path).length, 1);
  } finally { missing.cleanup(); }

  const already = temp("wf-rej-v2-");
  try {
    already.store.migrateWorkflowToV2(base.id, 1);
    const before = rawRows(already.path);
    assert.throws(() => already.store.migrateWorkflowToV2(base.id, 2), /源流程已是 v2/);
    assert.deepEqual(rawRows(already.path).map((row) => row.data_json),
      before.map((row) => row.data_json), "拒绝后数据不得变化");
  } finally { already.cleanup(); }

  for (const value of [3, null, "2"]) {
    const t = temp("wf-rej-unknown-");
    try {
      const before = inject(t.path, value);
      assert.throws(() => t.store.migrateWorkflowToV2(base.id, 1),
        /unsupported-workflow-schema-version/, `源为 ${String(value)} 时必须拒绝`);
      assert.equal(rawRows(t.path)[0].data_json, before, "源行不得被迁移写入");
      assert.equal(rawRows(t.path).length, 1, "不得产生 v2 行");
    } finally { t.cleanup(); }
  }
});

test("stepId 与 definitionHash 确定：同源重复求值一致，且与 v1 不同", () => {
  const first = temp("wf-stable-a-");
  const second = temp("wf-stable-b-");
  try {
    const left = first.store.migrateWorkflowToV2(base.id, 1).workflow;
    const right = second.store.migrateWorkflowToV2(base.id, 1).workflow;
    assert.deepEqual(left.steps.map((step) => step.stepId),
      right.steps.map((step) => step.stepId), "stepId 必须确定性可复现");
    assert.equal(workflowDigest(left), workflowDigest(right), "definitionHash 必须确定");
    assert.notEqual(workflowDigest(left), workflowDigest(base), "v2 hash 必须异于 v1");
  } finally { first.cleanup(); second.cleanup(); }
});
