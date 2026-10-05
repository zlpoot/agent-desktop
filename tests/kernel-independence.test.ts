import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 阶段 A 验收的机器可查证据：核心层不导入业务扩展实现、不出现业务名。
 * 连启动入口 src/app/start.ts 也纳入扫描：扩展与 EVAL-only 通道（含 testbench Oracle 桥）
 * 一律在 src/composition 装配层或 src/extensions 内组装，核心/启动入口不得静态携带其字面路径。
 */
const CORE_DIRS = [
  "src/app", "src/contracts", "src/graph", "src/capabilities", "src/verifier",
  "src/actions", "src/agent", "src/trace", "src/workflows", "src/desktop-session",
  "src/runtime",
];

const EXEMPT_FILES = new Set<string>();

// 注意：业务词大小写都要列（无 i 标志）。裸 "oracle" 不入表——它是独立旁路通道的架构概念词，
// 核心注释可合法提及；testbench/扩展路径泄漏由 "testbench" 与扩展 import 测试拦截。
// P8 批次 2（M1/M2）：product/media 业务字段必须出核，下列为精确业务标识符，命中即红。
// 刻意不使用裸 "product"/"media"：windows.media.verify（通用能力 id）、mediaObservable（能力事实）
// 是业务无关的能力门措辞，不得被本表误伤（见 P8-A §3 #12 与批次 2 护栏约束）。
const BUSINESS_PATTERN = /网易云|异环|炉石|佣兵|TestBench|testbench|netease|hearthstone|mercenaries|MusicModel|京东|productCapacityGb|productPriceAtMost|productTitleIncludes|mediaTitleIncludes|mediaArtistIncludes|mediaPlaying|readJdProduct|jd-product|item\.jd|sku-name|capacityGb|priceYuan|priceSource|observation\.product|observation\?\.product|observation\.media|observation\?\.media|\["product"\]|shop\.jd|music\.netease/;

function collectCoreFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...collectCoreFiles(path));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

const coreFiles = CORE_DIRS.flatMap((dir) => collectCoreFiles(join(process.cwd(), dir)))
  .filter((path) => !EXEMPT_FILES.has(path.replaceAll("\\", "/").replace(/^.*\/src\//, "src/")));

test("核心文件不导入业务扩展实现（extensions/ 仅由装配层引用）", () => {
  assert.ok(coreFiles.length > 0, "核心文件集合不应为空");
  for (const file of coreFiles) {
    const text = readFileSync(file, "utf8");
    const matches = [...text.matchAll(/from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']/g)]
      .map((match) => match[1] ?? match[2]);
    for (const spec of matches) {
      if (spec.startsWith("extensions") || spec.includes("/extensions")) {
        assert.fail(`${file} 导入了业务扩展实现：${spec}`);
      }
    }
  }
});

test("核心文件不出现业务名（业务语义只存在于 extensions/ 与独立演示脚本）", () => {
  for (const file of coreFiles) {
    const text = readFileSync(file, "utf8");
    const found = text.match(BUSINESS_PATTERN);
    assert.ok(!found, `${file} 含业务词：${found?.[0]}`);
  }
});

test("扩展层可从核心契约导入，但不反向依赖核心业务路由", () => {
  const extensionDir = join(process.cwd(), "src", "extensions");
  const files = collectCoreFiles(extensionDir);
  assert.ok(files.length >= 4, "内置扩展应存在");
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/from\s+["']([^"']+)["']/g)) {
      const spec = match[1];
      if (spec.includes("extensions/")) {
        assert.fail(`${file} 不应依赖其他业务扩展实现：${spec}`);
      }
    }
  }
});
