/**
 * P9-A4｜Semantic Target Remapping 单元测试。
 * 覆盖：各档位命中（exact/normalized/stable_token/stable_prefix/frozen_overlap）、
 * 淘宝/维基真实文本案例、相似商品/相似链接干扰不误点、多候选冲突拒绝、
 * role 不符、无候选、审计字段（matchedBy/score/alternatives/evidence）、normalize 边界。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTargetText, remapTarget, type RemapCandidate } from "../src/workflows/target-remap.js";

const link = (text: string, href?: string): RemapCandidate =>
  ({ role: "link", text, ...(href ? { href } : {}) });

test("exact 命中：候选文本与冻结名完全一致", () => {
  const verdict = remapTarget({ spec: { kind: "role", role: "link", name: "量子力学" },
    inputTokens: ["量子力学"], candidates: [link("量子力学", "/wiki/量子力学")] });
  assert.equal(verdict.matched, true);
  assert.equal(verdict.matchedBy, "exact");
  assert.equal(verdict.score, 0.95);
  assert.equal(verdict.target?.kind, "role");
});

test("normalized_exact：标点/全角/空白差异可命中（无输入参数时走冻结名维度）", () => {
  const verdict = remapTarget({ spec: { kind: "role", role: "link", name: "量子力学（入门）" },
    inputTokens: [], candidates: [link("量子力学（ 入门 ）")] });
  assert.equal(verdict.matched, true);
  assert.equal(verdict.matchedBy, "normalized_exact");
});

test("stable_token：变体参数出现在候选文本（非前缀）", () => {
  const verdict = remapTarget({ spec: { kind: "role", role: "link",
    name: "真无线蓝牙耳机入耳式长续航大电量电竞运动挂夹高音质2026年新款正在秒杀直降27.58元动圈蓝牙连接支持麦克风¥32.32补贴后4万+人付款广东东莞24小时内发退货宝包邮城瑞达炫皓专卖" },
    inputTokens: ["蓝牙音箱"], candidates: [link("无线蓝牙音箱低音炮高音质2026新款便携式")] });
  assert.equal(verdict.matched, true);
  assert.equal(verdict.matchedBy, "stable_token");
  assert.equal(verdict.score, 0.8);
});

test("stable_prefix：候选文本以变体参数开头（淘宝商品链接典型形态）", () => {
  const verdict = remapTarget({ spec: { kind: "role", role: "link",
    name: "真无线蓝牙耳机入耳式长续航大电量电竞运动挂夹高音质2026年新款正在秒杀直降27.58元动圈蓝牙连接支持麦克风¥32.32补贴后4万+人付款广东东莞24小时内发退货宝包邮城瑞达炫皓专卖" },
    inputTokens: ["蓝牙音箱"], candidates: [link("蓝牙音箱无线音响高音质2026新款户外便捷式德国柏林之音重低音炮", "https://item.taobao.com/item.htm?id=1")] });
  assert.equal(verdict.matched, true);
  assert.equal(verdict.matchedBy, "stable_prefix");
  assert.equal(verdict.score, 0.95);
});

test("frozen_overlap：无输入参数时，冻结名与候选共享稳定 token（探索值场景）", () => {
  const verdict = remapTarget({ spec: { kind: "role", role: "link", name: "围棋 棋類遊戲" },
    inputTokens: [], candidates: [link("围棋 棋類遊戲（中国大陆围棋条目）")] });
  assert.equal(verdict.matched, true);
  assert.equal(verdict.matchedBy, "frozen_overlap");
  assert.equal(verdict.score, 0.70);
});

test("A2 真实案例：蓝牙音箱变体唯一命中目标商品（干扰为不同前缀 token 或无关）", () => {
  const frozen = "真无线蓝牙耳机入耳式长续航大电量电竞运动挂夹高音质2026年新款正在秒杀直降27.58元动圈蓝牙连接支持麦克风¥32.32补贴后4万+人付款广东东莞24小时内发退货宝包邮城瑞达炫皓专卖";
  const candidates = [
    link("蓝牙音箱无线音响高音质2026新款户外便捷式德国柏林之音重低音炮", "https://item.taobao.com/item.htm?id=1001"),
    // 干扰：同关键词但非前缀（token 0.80 < prefix 0.95 − margin 0.15）。
    link("无线蓝牙音箱低音炮便携式", "https://item.taobao.com/item.htm?id=1002"),
    link("手机壳苹果15全包边", "https://item.taobao.com/item.htm?id=1003"),
  ];
  const verdict = remapTarget({ spec: { kind: "role", role: "link", name: frozen },
    inputTokens: ["蓝牙音箱"], candidates });
  assert.equal(verdict.matched, true, "应唯一高置信命中目标商品");
  assert.equal(verdict.matchedBy, "stable_prefix");
  assert.equal(verdict.target?.kind, "role");
  const name = (verdict.target as { name: string }).name;
  assert.ok(name.includes("蓝牙音箱无线音响"), "命中目标应为目标商品而非干扰项");
});

test("A2 相似干扰：同前缀双候选 → 拒绝执行（A4-2/A4-3 正例，禁止 silent fuzzy click）", () => {
  const frozen = "真无线蓝牙耳机入耳式长续航大电量电竞运动挂夹高音质";
  const candidates = [
    link("蓝牙音箱无线音响高音质2026新款", "https://item.taobao.com/item.htm?id=2001"),
    link("蓝牙音箱保护壳硅胶防摔2026新款", "https://item.taobao.com/item.htm?id=2002"),
  ];
  const verdict = remapTarget({ spec: { kind: "role", role: "link", name: frozen },
    inputTokens: ["蓝牙音箱"], candidates });
  assert.equal(verdict.matched, false);
  assert.equal(verdict.rejectReason, "multi_candidate_conflict");
  assert.equal(verdict.target, undefined);
  assert.ok(verdict.alternatives.length >= 2, "应记录全部候选供审计");
});

test("低置信：无输入 token 且冻结名与候选无稳定重叠 → 拒绝", () => {
  const verdict = remapTarget({ spec: { kind: "role", role: "link", name: "量子力学" },
    inputTokens: ["蓝牙音箱"], candidates: [link("长城 世界文化遗产")] });
  assert.equal(verdict.matched, false);
  assert.equal(verdict.rejectReason, "low_confidence");
});

test("role 不符：期望 link 但候选为 button → 拒绝", () => {
  const verdict = remapTarget({ spec: { kind: "role", role: "link", name: "量子力学" },
    inputTokens: ["量子力学"], candidates: [{ role: "button", text: "量子力学" }] });
  assert.equal(verdict.matched, false);
  assert.equal(verdict.rejectReason, "role_mismatch");
});

test("无候选 → no_candidate 拒绝", () => {
  const verdict = remapTarget({ spec: { kind: "role", role: "link", name: "量子力学" },
    inputTokens: ["量子力学"], candidates: [] });
  assert.equal(verdict.matched, false);
  assert.equal(verdict.rejectReason, "no_candidate");
});

test("审计字段完整：matchedBy/score/alternatives/evidence 全部可读", () => {
  const verdict = remapTarget({ spec: { kind: "role", role: "link", name: "量子力学" },
    inputTokens: ["量子力学"], candidates: [link("量子力学", "/wiki/量子力学")] });
  assert.equal(verdict.matched, true);
  assert.equal(verdict.matchedBy, "exact");
  assert.ok(typeof verdict.score === "number");
  assert.ok(Array.isArray(verdict.alternatives));
  assert.equal(verdict.evidence.roleOk, true);
  assert.equal(verdict.evidence.exact, true);
  assert.deepEqual(verdict.evidence.tokenHits, ["量子力学"]);
});

test("href 辅助证据：提供特征时命中可加分并记录 hrefHit", () => {
  const verdict = remapTarget({ spec: { kind: "role", role: "link", name: "量子力学" },
    inputTokens: ["量子力学"], hrefFeatures: ["item.htm"],
    candidates: [link("量子力学", "https://item.taobao.com/item.htm?id=9")] });
  assert.equal(verdict.matched, true);
  assert.equal(verdict.evidence.hrefHit, true);
  assert.equal(verdict.score, 1.0);
});

test("normalize 边界：价格/促销数字/全角/标点被剥离", () => {
  assert.equal(normalizeTargetText("¥32.32补贴后4万+人付款"), "补贴后 人付款");
  assert.equal(normalizeTargetText("真无线蓝牙耳机，入耳式！"), "真无线蓝牙耳机 入耳式");
  assert.equal(normalizeTargetText("２０２６新款"), "新款");
  assert.equal(normalizeTargetText("A  B   C"), "A B C");
});

test("最长 token 优先：更具体的输入 token 命中", () => {
  const verdict = remapTarget({ spec: { kind: "role", role: "link", name: "真无线蓝牙耳机" },
    inputTokens: ["耳机", "蓝牙音箱"], candidates: [link("蓝牙音箱无线音响低音炮")] });
  assert.equal(verdict.matched, true);
  // 「蓝牙音箱」长于「耳机」，应命中蓝牙音箱候选而非耳机（干扰）。
  assert.equal(verdict.evidence.tokenHits[0], "蓝牙音箱");
});
