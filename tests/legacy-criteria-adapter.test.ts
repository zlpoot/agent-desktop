import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adaptLegacyCriteria, assertNoLegacyCriteriaKeys, hasLegacyCriteriaKeys, LEGACY_CRITERIA_KEYS,
} from "../src/migration/legacy-criteria-adapter.js";

test("历史商品/媒体完成条件只在迁移边界翻译成 domainChecks，不回写旧键", () => {
  const raw = {
    urlIncludes: "item.jd.com",
    productTitleIncludes: "内存", productCapacityGb: 32, productPriceAtMost: 2000,
    mediaTitleIncludes: "稻香", mediaArtistIncludes: "周杰伦", mediaPlaying: true,
  };
  const result = adaptLegacyCriteria(raw);
  assert.equal(result.adapted, true);
  assert.deepEqual(result.legacyKeys.sort(), [...LEGACY_CRITERIA_KEYS].sort());
  // 迁移后对象上不再残留任何旧键。
  for (const key of LEGACY_CRITERIA_KEYS) {
    assert.equal((result.criteria as Record<string, unknown>)[key], undefined);
  }
  const domains = result.criteria.domainChecks!.map((check) =>
    `${check.domain}:${check.predicate}`);
  assert.deepEqual(domains, [
    "shop.jd:capacityGb", "shop.jd:priceAtMost", "shop.jd:titleIncludes",
    "music.netease:titleIncludes", "music.netease:artistIncludes", "music.netease:playing",
  ]);
  // 入参不被修改。
  assert.equal((raw as Record<string, unknown>).productCapacityGb, 32);
  // 与既有 domainChecks 合并而非覆盖。
  const merged = adaptLegacyCriteria({
    productPriceAtMost: 10, domainChecks: [
      { domain: "x", predicate: "y", args: {} }] });
  assert.equal(merged.criteria.domainChecks!.length, 2);
});

test("无旧键的完成条件原样返回，不标记迁移", () => {
  const raw = { urlIncludes: "/done", domainChecks: [
    { domain: "music.netease", predicate: "playing", args: { equals: true } }] };
  const result = adaptLegacyCriteria(raw);
  assert.equal(result.adapted, false);
  assert.equal(result.criteria, raw);
  assert.equal(hasLegacyCriteriaKeys(raw), false);
});

test("新任务边界：含任何旧键即拒绝（fail-closed）", () => {
  for (const key of LEGACY_CRITERIA_KEYS) {
    assert.equal(hasLegacyCriteriaKeys({ [key]: 1 }), true);
    assert.throws(() => assertNoLegacyCriteriaKeys({ [key]: 1 }), /domainChecks/);
  }
  assert.doesNotThrow(() => assertNoLegacyCriteriaKeys({ urlIncludes: "/done" }));
  assert.doesNotThrow(() => assertNoLegacyCriteriaKeys({ domainChecks: [] }));
});
