import assert from "node:assert/strict";
import { test } from "node:test";
import { readJdProduct, memoryCapacityGb } from "../src/extensions/shop/jd-product.js";
import { createShopExtension } from "../src/extensions/shop/shop-extension.js";
import { FacetRegistry } from "../src/contracts/facets.js";
import { ContributorRegistry } from "../src/contracts/verifier-contributor.js";
import { collectFacets } from "../src/verification/facet-binding.js";
import { createDomainEvaluator } from "../src/verification/domain-evaluator.js";
import type { Observation } from "../src/actions/schema.js";

type DomNode = { text?: string; attr?: string };
/** 预置选择器→节点的只读 DOM，模拟核心托管的 readDom（provider 不接触 page 本身）。 */
function fakeReadDom(pages: Record<string, DomNode[]>) {
  return async (request: { selector: string; attribute?: string }): Promise<DomNode[]> =>
    pages[request.selector + (request.attribute ? `@${request.attribute}` : "")] ?? [];
}

function browserObservation(url: string): Observation {
  const now = Date.now();
  return {
    url,
    capture: { epoch: "test-epoch", sequence: 1, object: `page:${url}`,
      startedAt: now - 30, finishedAt: now, clock: "collector", atomic: false,
      fields: { dom: { complete: true, source: "dom" } }, enumerationComplete: true },
  };
}

function shopRegistries() {
  const extension = createShopExtension();
  const facets = new FacetRegistry();
  for (const provider of extension.facets ?? []) facets.register(provider);
  const contributors = new ContributorRegistry();
  for (const contributor of extension.contributors ?? []) contributors.register(contributor);
  return { facets, contributors };
}

test("memoryCapacityGb 识别 16G×2 套条为 32GB，单条取标称值", () => {
  assert.equal(memoryCapacityGb("测试 32GB(16GB×2) DDR4"), 32);
  assert.equal(memoryCapacityGb("16G x 2 套装"), 32);
  assert.equal(memoryCapacityGb("单条 16GB DDR4"), 16);
  assert.equal(memoryCapacityGb("无规格标题"), undefined);
});

test("扩展侧 readJdProduct 只在 item.jd.com 用当次 readDom 解析标题与价格", async () => {
  const readDom = fakeReadDom({
    ".sku-name": [{ text: "测试品牌 32GB(16GB×2) DDR4 内存条" }],
    ".summary-price .p-price .price": [{ text: "¥1,899.00" }],
  });
  const product = await readJdProduct("https://item.jd.com/100.html", readDom);
  assert.equal(product?.capacityGb, 32);
  assert.equal(product?.priceYuan, 1899);
  // 非商品域页面不产出数据（不硬套到其它站点）。
  assert.equal(await readJdProduct("https://example.com/x", readDom), undefined);
});

test("完整 facet→domain 管道：容量/价格满足时 PASS，并携带当次证据引用", async () => {
  const { facets, contributors } = shopRegistries();
  const url = "https://item.jd.com/100.html";
  const readDom = fakeReadDom({
    ".sku-name": [{ text: "32GB(16GB×2) DDR4 内存条" }],
    ".summary-price .p-price .price": [{ text: "1899.00" }],
  });
  const observation = await collectFacets(browserObservation(url), facets.list(), readDom);
  const evaluate = createDomainEvaluator(contributors, facets);
  const outcomes = evaluate([
    { domain: "shop.jd", predicate: "capacityGb", args: { equals: 32 } },
    { domain: "shop.jd", predicate: "priceAtMost", args: { max: 2000 } },
    { domain: "shop.jd", predicate: "titleIncludes", args: { includes: "内存" } },
  ], observation);
  assert.deepEqual(outcomes.map((item) => item.verdict), ["pass", "pass", "pass"]);
  for (const outcome of outcomes) {
    assert.equal(outcome.audit.contributorFound, true);
    assert.equal(outcome.audit.evidenceRefs.length, 1);
    assert.equal(outcome.audit.evidenceRefs[0].captureId, "test-epoch:1");
    assert.equal(outcome.audit.evidenceRefs[0].facetId, "shop.jd");
  }
});

test("价格超预算 FAIL 绑定当次反证；缺价格时 complete=false 因而价格条件 UNKNOWN", async () => {
  const { facets, contributors } = shopRegistries();
  const url = "https://item.jd.com/101.html";

  const overpriced = await collectFacets(browserObservation(url), facets.list(), fakeReadDom({
    ".sku-name": [{ text: "32GB(16GB×2) DDR4 内存条" }],
    ".summary-price .p-price .price": [{ text: "2100" }],
  }));
  const over = createDomainEvaluator(contributors, facets)(
    [{ domain: "shop.jd", predicate: "priceAtMost", args: { max: 2000 } }], overpriced);
  assert.equal(over[0].verdict, "fail");
  assert.equal(over[0].audit.evidenceRefs.length, 1);

  // 页面只有标题、没有价格：provider 返回 complete=false，价格谓词必须 UNKNOWN（不能猜 PASS/FAIL）。
  const noPrice = await collectFacets(browserObservation(url), facets.list(), fakeReadDom({
    ".sku-name": [{ text: "32GB(16GB×2) DDR4 内存条" }],
  }));
  assert.equal(noPrice.facets?.["shop.jd"]?.complete, false);
  const unknownPrice = createDomainEvaluator(contributors, facets)(
    [{ domain: "shop.jd", predicate: "priceAtMost", args: { max: 2000 } }], noPrice);
  assert.equal(unknownPrice[0].verdict, "unknown");
  assert.equal(unknownPrice[0].audit.evidenceRefs.length, 0);
});
