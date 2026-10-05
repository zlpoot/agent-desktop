import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * P8 批次 1（卫生与护栏）：独立 Oracle 旁路通道的装配门控。
 * 生产默认进程的模块图不得携带 testbench Oracle 桥；桥只能由显式 EVAL 开关，
 * 经装配层 src/composition/eval-oracle.ts 以函数内动态 import 懒加载。
 * 与 kernel-independence 同为白盒源码断言（不启动进程、不触碰 .artifacts）。
 */
const read = (relative: string): string =>
  readFileSync(join(process.cwd(), relative), "utf8");

test("启动入口不静态携带 testbench Oracle 桥，桥仅由显式 EVAL 开关装配", () => {
  const start = read("src/app/start.ts");
  assert.ok(!/testbench/i.test(start), "start.ts 不得出现 testbench 字面引用（含静态路径/注释暗号）");
  assert.ok(!/oracle-bridge/.test(start), "start.ts 不得静态引用 oracle-bridge 模块");
  assert.ok(/AGENT_DESKTOP_EVAL_ORACLE/.test(start), "必须提供 env EVAL 开关 AGENT_DESKTOP_EVAL_ORACLE");
  assert.ok(/--eval-oracle/.test(start), "必须提供跨平台 CLI EVAL 开关 --eval-oracle");
  assert.ok(/evalOracleEnabled/.test(start), "桥启动必须受显式布尔门控，而非无条件装配");
  assert.ok(/startEvalOracleBridge/.test(start), "桥必须经装配层函数启动，启动入口不直接持有其实现");
});

test("EVAL 桥装配位于 src/composition 装配层，对 testbench 只用函数内动态 import", () => {
  const loader = read("src/composition/eval-oracle.ts");
  const staticSpecs = [...loader.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((match) => match[1]);
  assert.ok(!staticSpecs.some((spec) => /testbench/i.test(spec)),
    "装配层顶层不得静态 import testbench，否则生产默认模块图仍会传递加载该桥");
  assert.ok(
    /import\(\s*["'][^"']*testbench\/oracle-bridge(?:\.js)?["']\s*\)/.test(loader),
    "桥模块必须通过函数内动态 import() 懒加载，仅在 EVAL 开关调用时才求值",
  );
});

test("package.json 提供一键 EVAL 入口，且生产默认 dashboard 不带 EVAL 开关", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
  assert.equal(pkg.scripts?.["dashboard"], "tsx src/app/start.ts", "生产默认入口不得携带 --eval-oracle");
  assert.ok(/--eval-oracle/.test(pkg.scripts?.["dashboard:eval"] ?? ""),
    "必须提供一键 EVAL 入口 dashboard:eval");
  assert.ok(!/--eval-oracle/.test(pkg.scripts?.["dashboard"] ?? ""),
    "生产默认 dashboard 脚本必须保持无 Oracle");
});
