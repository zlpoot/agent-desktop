import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workflow } from "../src/workflows/schema.js";
import { workflowDigest } from "../src/workflows/recovery.js";
import { migrateWorkflowToV2 } from "../src/workflows/migration.js";
import { WorkflowStore } from "../src/workflows/store.js";

const v1: Workflow = { id: "v1-fixture", version: 1, status: "verified", environment: "windows",
  taskPattern: "write {{value}}", inputs: [{ name: "value", example: "A" }], preconditions: [],
  steps: [{ goal: "write", action: { kind: "keypress", keys: "a" }, preferredMethods: [],
    successCondition: { kind: "text_includes", value: "{{value}}" } }],
  successConditions: { pageTextIncludes: "{{value}}" }, knownFailures: [], sourceTaskId: "seed",
  sourceTrace: "seed", createdAt: "", successCount: 1, failureCount: 0 };

test("v1 verified 原 hash 不变：显式标注 workflowSchemaVersion=1 也不改变摘要", () => {
  const h1 = workflowDigest(v1);
  const h2 = workflowDigest({ ...v1, workflowSchemaVersion: 1 });
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test("v1→v2 迁移产生新 hash，verified 不继承、计数清零、stepId 持久化", () => {
  const v2 = migrateWorkflowToV2(v1);
  assert.equal(v2.workflowSchemaVersion, 2);
  assert.equal(v2.status, "candidate");
  assert.equal(v2.lastVerifiedAt, undefined);
  assert.equal(v2.successCount, 0);
  assert.equal(v2.failureCount, 0);
  assert.equal(v2.steps.length, 1);
  assert.ok(typeof v2.steps[0].stepId === "string" && v2.steps[0].stepId!.length > 0);
  assert.notEqual(workflowDigest(v2), workflowDigest(v1), "v1→v2 必须产生新 definitionHash");
  assert.deepEqual(v2.inputs, v1.inputs);
  assert.deepEqual(v2.successConditions, v1.successConditions);
  assert.equal(v1.status, "verified", "迁移不得修改原对象");
  assert.equal(v1.steps[0].stepId, undefined);
});

test("v2 迁移幂等：同一 v1 两次迁移得到相同 stepId 与相同 hash；v2 再迁移拒绝", () => {
  const a = migrateWorkflowToV2(v1);
  const b = migrateWorkflowToV2(v1);
  assert.deepEqual(a.steps[0].stepId, b.steps[0].stepId);
  assert.equal(workflowDigest(a), workflowDigest(b));
  assert.throws(() => migrateWorkflowToV2(a), /已是 v2/);
});

test("v2 摘要对执行定义敏感：stepId 变化即新 hash", () => {
  const v2 = migrateWorkflowToV2(v1);
  const changed = { ...v2, steps: [{ ...v2.steps[0], stepId: "step-1-other" }] };
  assert.notEqual(workflowDigest(v2), workflowDigest(changed));
});

test("store 不静默转换：存 v1 取回仍为 v1（无 workflowSchemaVersion、无 stepId）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-v1-"));
  const store = new WorkflowStore(join(dir, "workflows.sqlite"));
  try {
    store.addCandidate({ ...v1, status: "candidate" as const });
    const saved = store.get("v1-fixture", 1)!;
    assert.equal(saved.workflowSchemaVersion, undefined);
    assert.equal(saved.steps[0].stepId, undefined);
    assert.equal(saved.status, "candidate");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("v1 verified 与 v2 candidate 同库共存：v2 用旧 hash 记录被拒，新 hash 才能晋级", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-migrate-"));
  const store = new WorkflowStore(join(dir, "workflows.sqlite"));
  try {
    store.addCandidate({ ...v1, status: "candidate" as const });
    store.recordReplay("v1-fixture", 1, "seed", true);
    assert.equal(store.get("v1-fixture", 1)?.status, "verified");
    const v2 = migrateWorkflowToV2(store.get("v1-fixture", 1)!);
    store.addCandidate(v2);
    const v1Saved = store.get("v1-fixture", 1)!;
    const v2Saved = store.get("v1-fixture", 2)!;
    assert.equal(v1Saved.status, "verified");
    assert.equal(v1Saved.workflowSchemaVersion, undefined);
    assert.equal(v2Saved.status, "candidate");
    assert.equal(v2Saved.workflowSchemaVersion, 2);
    assert.notEqual(workflowDigest(v1Saved), workflowDigest(v2Saved));
    assert.throws(() => store.recordReplay("v1-fixture", 2, "trial-v1hash", true, undefined,
      workflowDigest(v1Saved)), /定义已改变/);
    assert.equal(store.get("v1-fixture", 2)?.status, "candidate");
    store.recordReplay("v1-fixture", 2, "trial-v2hash", true, undefined, workflowDigest(v2Saved));
    assert.equal(store.get("v1-fixture", 2)?.status, "verified");
    assert.equal(store.get("v1-fixture", 1)?.status, "verified", "v1 行原样保留");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("v2 发布路径防重放：候选未试运行不能以旧 hash 发布", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-publish-"));
  const store = new WorkflowStore(join(dir, "workflows.sqlite"));
  try {
    const v2 = migrateWorkflowToV2(v1);
    store.addCandidate(v2);
    const saved = store.get("v1-fixture", 1)!;
    assert.throws(() => store.publish("v1-fixture", 1, workflowDigest(v1), 0, 0),
      /已变化|至少需要/);
    assert.equal(store.get("v1-fixture", 1)?.status, "candidate");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
