/** Synthetic classification and SQLite trace regressions; historical experiments remain private. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import {
  classifyFixtureEvidence,
  loadTraceObservations,
  matchTargetInItems,
  samePage,
  type FixtureObservation,
} from "../src/observation/fixture-gate.js";

const obs = (o: Partial<FixtureObservation> & { url: string }): FixtureObservation => ({
  pageText: "",
  items: [],
  ...o,
});

test('synthetic SQLite trace preserves page provenance, blocked rendering, truncation and absent attrs', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'fixture-trace-'));
  const path = resolve(dir, 'trace.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE events (node TEXT, payload_json TEXT)');
    const insert = db.prepare('INSERT INTO events VALUES (?, ?)');
    for (const observation of [
      { url: 'https://fixture.test/home', pageText: '首页', structured: { items: [{ role: 'link', text: '围棋' }], complete: true } },
      { url: 'https://fixture.test/body', pageText: '波函数与其他理论。'.repeat(10), structured: { items: [{ role: 'link', text: '其他理论' }], complete: false } },
      { url: 'https://fixture.test/blocked', pageText: '搜索', structured: { items: [], complete: false } },
    ]) insert.run('observe', JSON.stringify({ observation }));
    insert.run('execute', JSON.stringify({ observation: { url: 'ignored' } }));
  } finally { db.close(); }
  try {
    const [source, body, blocked] = loadTraceObservations(path);
    assert.equal(loadTraceObservations(path).length, 3);
    const cross = classifyFixtureEvidence({ obs: body, target: '围棋', source: { observation: source } });
    assert.equal(cross.classification, 'wrong-page-contract');
    assert.equal(cross.admissible, false);
    const unavailable = classifyFixtureEvidence({ obs: blocked, target: '蓝牙音箱' });
    assert.equal(unavailable.classification, 'not-rendered');
    assert.equal(unavailable.admissible, false);
    assert.equal(body.complete, false);
    assert.equal(matchTargetInItems(body.items, '波函数').via, 'none');
    const truncated = classifyFixtureEvidence({ obs: body, target: '波函数' });
    assert.equal(truncated.classification, 'rendered-visible');
    assert.equal(truncated.admissible, true);
    const unknown = classifyFixtureEvidence({ obs: body, target: '棋類遊戲' });
    assert.equal(unknown.classification, 'undetermined');
    assert.equal(unknown.admissible, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- 单测：分类决策树 ----------

test("rendered-visible: target 在 pageText 中真实存在 → admissible", () => {
  const v = classifyFixtureEvidence({
    obs: obs({ url: "https://zh.wikipedia.org/wiki/量子力学", pageText: "波函数是量子力学的核心概念" }),
    target: "波函数",
  });
  assert.equal(v.classification, "rendered-visible");
  assert.equal(v.admissible, true);
});

test("rendered-visible 优先于 wrong-page-contract：pageText 有 target + provenance 页面不同 → rendered-visible", () => {
  const v = classifyFixtureEvidence({
    obs: obs({ url: "https://zh.wikipedia.org/wiki/量子力学", pageText: "围棋 棋類遊戲 也是条目" }),
    target: "围棋",
    source: { observation: obs({ url: "https://zh.wikipedia.org/wiki/Wikipedia:首页", pageText: "围棋" }) },
  });
  assert.equal(v.classification, "rendered-visible");
  assert.equal(v.admissible, true);
});

test("rendered-semantic-only: pageText 正常长度无目标，item.name（aria-label/name 投影）匹配 → admissible", () => {
  const v = classifyFixtureEvidence({
    obs: obs({
      url: "https://s.taobao.com/search?q=x",
      pageText: "这是一段正常渲染的结果页可见文本，但没有目标商品的文字。".repeat(3),
      items: [{ role: "link", text: "", name: "真无线蓝牙音箱 长尾商品名" }],
    }),
    target: "蓝牙音箱",
  });
  assert.equal(v.classification, "rendered-semantic-only");
  assert.equal(v.admissible, true);
});

test("not-rendered 优先于 semantic 匹配：pageText 极短（验证码/壳层）即使 name 匹配 → not-rendered", () => {
  const v = classifyFixtureEvidence({
    obs: obs({
      url: "https://s.taobao.com/search?q=x",
      pageText: "搜索\n搜同款",
      items: [{ role: "link", text: "", name: "蓝牙音箱 壳层导航" }],
    }),
    target: "蓝牙音箱",
  });
  assert.equal(v.classification, "not-rendered");
  assert.equal(v.admissible, false);
});

test("rendered-semantic-only: pageText 无目标，item.href URL 解码后匹配 → admissible", () => {
  const v = classifyFixtureEvidence({
    obs: obs({
      url: "https://zh.wikipedia.org/wiki/量子力学",
      pageText: "这是一段正常长度的页面正文，但语义与目标无关，足以超过渲染阈值判定。".repeat(2),
      items: [{ role: "link", text: "条目", href: "/wiki/%E5%9B%B4%E6%A3%8B" }],
    }),
    target: "围棋",
  });
  assert.equal(v.classification, "rendered-semantic-only");
  assert.equal(v.admissible, true);
});

test("undetermined: 旧 trace 未保存 semantic attrs（items 只有 text），pageText 无目标 → fail closed", () => {
  const v = classifyFixtureEvidence({
    obs: obs({
      url: "https://zh.wikipedia.org/wiki/量子力学",
      pageText: "这是一段正常长度的正文但没有目标，包含足够的文字以便超过渲染阈值判定。".repeat(2),
      items: [{ role: "link", text: "条目甲" }, { role: "link", text: "条目乙" }],
    }),
    target: "围棋",
  });
  assert.equal(v.classification, "undetermined");
  assert.equal(v.admissible, false);
});

test("wrong-page-contract: provenance 证明 source 存在 target 且页面不一致 → 隔离", () => {
  const v = classifyFixtureEvidence({
    obs: obs({
      url: "https://zh.wikipedia.org/wiki/%E9%87%8F%E5%AD%90%E5%8A%9B%E5%AD%A6",
      pageText: "波函数、薛定谔方程……",
    }),
    target: "围棋",
    source: {
      observation: obs({
        url: "https://zh.wikipedia.org/wiki/Wikipedia:%E9%A6%96%E9%A1%B5",
        pageText: "欢迎来到维基百科",
        items: [{ role: "link", text: "围棋棋類遊戲" }],
      }),
    },
  });
  assert.equal(v.classification, "wrong-page-contract");
  assert.equal(v.admissible, false);
});

test("undetermined: provenance 无法证明 source 存在 target → fail closed（不得猜 wrong-page-contract）", () => {
  const v = classifyFixtureEvidence({
    obs: obs({ url: "https://zh.wikipedia.org/wiki/量子力学", pageText: "正文不含目标" }),
    target: "围棋",
    source: {
      observation: obs({ url: "https://zh.wikipedia.org/wiki/Wikipedia:首页", pageText: "首页也没有该目标" }),
    },
  });
  assert.equal(v.classification, "undetermined");
  assert.equal(v.admissible, false);
});

test("not-rendered: pageText 极短（渲染未就绪/外部阻塞）→ 隔离", () => {
  const v = classifyFixtureEvidence({
    obs: obs({
      url: "https://s.taobao.com/search?q=蓝牙音箱",
      pageText: "搜索\n搜同款",
      items: [{ role: "link", text: "tb883699228233" }],
    }),
    target: "蓝牙音箱",
  });
  assert.equal(v.classification, "not-rendered");
  assert.equal(v.admissible, false);
});

test("undetermined: pageText 正常长度、无目标、无 semantic 匹配、无 provenance → fail closed", () => {
  const v = classifyFixtureEvidence({
    obs: obs({
      url: "https://zh.wikipedia.org/wiki/量子力学",
      pageText: "这是一段正常长度的页面正文，包含足够多的文字".repeat(8),
      items: [{ role: "link", text: "条目甲" }],
    }),
    target: "棋類遊戲",
  });
  assert.equal(v.classification, "undetermined");
  assert.equal(v.admissible, false);
});

test("samePage 规范化：URL 编码/哈希/尾斜杠视为同页", () => {
  assert.equal(samePage("https://zh.wikipedia.org/wiki/Wikipedia:%E9%A6%96%E9%A1%B5", "https://zh.wikipedia.org/wiki/Wikipedia:首页"), true);
  assert.equal(samePage("https://a.com/x/", "https://a.com/x#frag"), true);
  assert.equal(samePage("https://a.com/x", "https://a.com/y"), false);
});

test("matchTargetInItems 优先级 text > name > href", () => {
  const items = [
    { role: "link", text: "A", name: "B", href: "/c" },
  ];
  assert.equal(matchTargetInItems(items, "A").via, "text");
  // name 与 text 相同不算 semantic（text 已覆盖）
  assert.equal(matchTargetInItems([{ role: "link", text: "围棋", name: "围棋" }], "围棋").via, "text");
  // name 独立于 text
  assert.equal(matchTargetInItems([{ role: "link", text: "其他", name: "围棋入口" }], "围棋").via, "name");
  // href URL 解码
  assert.equal(matchTargetInItems([{ role: "link", text: "条目", href: "/wiki/%E5%9B%B4%E6%A3%8B" }], "围棋").via, "href");
  assert.equal(matchTargetInItems([{ role: "link", text: "条目", href: "/wiki/x" }], "围棋").via, "none");
});

test("boundary: 空 pageText → not-rendered；空 items + 正常 pageText → undetermined", () => {
  const a = classifyFixtureEvidence({
    obs: obs({ url: "https://x.test/", pageText: "" }),
    target: "目标",
  });
  assert.equal(a.classification, "not-rendered");
  const b = classifyFixtureEvidence({
    obs: obs({ url: "https://x.test/", pageText: "这是一段正常长度的页面文本，超过渲染阈值判定。".repeat(2) }),
    target: "目标",
  });
  assert.equal(b.classification, "undetermined");
});
