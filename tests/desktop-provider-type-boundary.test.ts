import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesktopProvider as EnvironmentProvider } from "../src/contracts/desktop-environment.js";
import type { LegacyDesktopProvider } from "../src/contracts/desktop-provider.js";
import type { HyperVDesktopProvider } from "../src/desktop-provider/hyperv-provider.js";
import type { DesktopSessionManager } from "../src/desktop-session/session-manager.js";

/**
 * R1.2 类型契约回归：旧管理契约（Legacy transport）与新环境契约（Environment Provider）
 * 必须是两个互不继承、互不可互换的不同职责接口，且旧契约不再导出同名 `DesktopProvider` 别名。
 * 全部为类型层 / 源码层断言，不触碰运行时行为。
 */
type Expect<T extends true> = T;
type NotAssignable<A, B> = [A] extends [B] ? false : true;
type Assignable<A, B> = [A] extends [B] ? true : false;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(directory: string, files: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}

test("legacy contract exports no DesktopProvider alias; only one unqualified DesktopProvider exists", () => {
  const legacy = readFileSync(join(root, "src/contracts/desktop-provider.ts"), "utf8");
  assert.equal(/^export\s+type\s+DesktopProvider\b/m.test(legacy), false,
    "旧管理契约不得再导出同名 DesktopProvider 别名");
  assert.match(legacy, /export interface LegacyDesktopProvider \{/);

  const contracts = walk(join(root, "src/contracts"));
  const declared = contracts.flatMap(file =>
    (readFileSync(file, "utf8").match(/^export\s+(?:interface|type)\s+DesktopProvider\b/gm) ?? [])
      .map(() => file.replace(`${root}\\`, "").replace(/\\/g, "/")));
  assert.equal(declared.length, 1,
    `应当只有 desktop-environment.ts 声明 DesktopProvider，实际：${declared.join(", ")}`);
  assert.match(declared[0] ?? "", /desktop-environment\.ts$/);
});

test("no source file imports DesktopProvider from the legacy contract", () => {
  const offenders = [...walk(join(root, "src")), ...walk(join(root, "tests"))]
    .map(file => ({ file: file.replace(`${root}\\`, "").replace(/\\/g, "/"),
      source: readFileSync(file, "utf8") }))
    .filter(({ source }) =>
      /import\s+type\s*\{[^}]*\}\s*from\s*["'][^"']*contracts\/desktop-provider\.js["']/s.test(source) &&
      /import\s+type\s*\{[^}]*\bDesktopProvider\b[^}]*\}\s*from\s*["'][^"']*contracts\/desktop-provider\.js["']/s.test(source))
    .map(({ file }) => file);
  assert.deepEqual(offenders, [], "旧别名仍有消费者遗漏");
});

test("legacy transport and environment provider remain two distinct, non-interchangeable contracts", () => {
  // 两个契约互不赋值：既确认没有合并成一个巨型接口，也确认没有被误配对方。
  type LegacyNotEnvironment = Expect<NotAssignable<LegacyDesktopProvider, EnvironmentProvider>>;
  type EnvironmentNotLegacy = Expect<NotAssignable<EnvironmentProvider, LegacyDesktopProvider>>;
  // 真实实现仍然分别落在各自契约上，且互不满足对方契约。
  type ManagerIsLegacy = Expect<Assignable<DesktopSessionManager, LegacyDesktopProvider>>;
  type HyperVIsEnvironment = Expect<Assignable<HyperVDesktopProvider, EnvironmentProvider>>;
  type ManagerNotEnvironment = Expect<NotAssignable<DesktopSessionManager, EnvironmentProvider>>;
  type HyperVNotLegacy = Expect<NotAssignable<HyperVDesktopProvider, LegacyDesktopProvider>>;
  // 引用上述别名，使其在同一编译单元被求值；断言不成立时 check 直接失败。
  const guard = [null as unknown as LegacyNotEnvironment, null as unknown as EnvironmentNotLegacy,
    null as unknown as ManagerIsLegacy, null as unknown as HyperVIsEnvironment,
    null as unknown as ManagerNotEnvironment, null as unknown as HyperVNotLegacy];
  assert.equal(guard.length, 6);
});
