import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resolveCapability, requireCapability } from "../src/capabilities/registry.js";
import { ExtensionRegistry } from "../src/contracts/extension.js";
import { createNeteaseExtension } from "../src/extensions/netease/netease-extension.js";
import { createNteExtension } from "../src/extensions/nte/nte-extension.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";
import { initialState } from "../src/graph/state.js";

test("按实际条件选择能力，计划中和未验收的能力不能兜底执行", () => {
  const facts = { windowAttached: true, uiaControls: false, screenshotAvailable: true,
    templateAvailable: true, unrealWindow: true, windowForeground: true, permissionsCompatible: true };
  assert.equal(resolveCapability("observe", "windows", facts).selected, "windows.window.observe");
  assert.equal(resolveCapability("locate", "windows", facts).selected, "windows.template.locate");
  assert.equal(resolveCapability("act", "windows", facts).selected, "windows.win32.act");
  const blocked = resolveCapability("act", "windows", { ...facts, windowForeground: false });
  assert.equal(blocked.selected, undefined);
  assert.match(blocked.candidates.find((item) => item.id === "windows.win32.act")!.reasons.join(" "), /windowForeground/);
  assert.throws(() => requireCapability(blocked), /没有可用/);
  assert.equal(resolveCapability("locate", "windows", { ...facts, templateAvailable: false }).selected, undefined);
});

test("Unity 游戏在没有应用 UIA 控件时按动作选已验收的输入方式", () => {
  const facts = { windowAttached: true, uiaControls: false, unrealWindow: false,
    unityWindow: true, windowForeground: true, permissionsCompatible: true };
  assert.equal(resolveCapability("act", "windows", { ...facts, clickAction: true }).selected,
    "windows.win32.unity.click");
  assert.equal(resolveCapability("act", "windows", { ...facts, escapeAction: true }).selected,
    "windows.pyautogui.unity.escape");
  assert.equal(resolveCapability("act", "windows", { ...facts, clickAction: true,
    permissionsCompatible: false }).selected, undefined);
});

test("统一任务入口保留两种受控目标及权限边界", () => {
  const registry = new ExtensionRegistry();
  registry.register(createNeteaseExtension({ rootDir: process.cwd() }));
  registry.register(createNteExtension({ rootDir: process.cwd() }));
  const music = registry.resolveCapability("打开网易云播放周杰伦的稻香");
  assert.equal(music?.capability.id, "netease.play");
  const titleCheck = music?.request.completionCriteria?.domainChecks
    ?.find((check) => check.predicate === "titleIncludes");
  assert.equal(titleCheck?.domain, "music.netease");
  assert.deepEqual(titleCheck?.args, { includes: "稻香" });
  assert.equal(music?.request.facts.deterministicIntent, true);
  const game = registry.resolveCapability("异环主音量调到 50", { admin: true });
  assert.equal(game?.capability.id, "nte.volume.50");
  assert.equal(game?.request.facts.unrealWindow, true);
  assert.throws(() => registry.resolveCapability("异环主音量调到 50"), /管理员权限/);
  assert.throws(() => registry.resolveCapability("打开网易云播放稻香", { admin: true }), /仅适用于/);
});

test("能力选择理由写入任务轨迹", () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-capabilities-"));
  try {
    const trace = new SqliteTrace(join(dir, "trace.sqlite"));
    trace.save("queued", initialState("cap-test", "测试"));
    const facts = { windowAttached: true, uiaControls: false, screenshotAvailable: true };
    trace.recordCapabilityResolution("cap-test", 1, "窗口检查",
      resolveCapability("observe", "windows", facts), facts);
    trace.close();
    const db = new DatabaseSync(join(dir, "trace.sqlite"), { readOnly: true });
    const row = db.prepare("SELECT selected, candidates_json FROM capability_resolutions WHERE task_id = ?")
      .get("cap-test") as { selected: string; candidates_json: string };
    assert.equal(row.selected, "windows.window.observe");
    assert.match(row.candidates_json, /uiaControls/);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
