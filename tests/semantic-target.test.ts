import assert from "node:assert/strict";
import { test } from "node:test";
import { bindTarget, semanticTarget } from "../src/actions/semantic-target.js";

test("同名按钮在浏览器和 Windows 中共享语义目标，保留各自的定位证据", () => {
  const browserAction = { kind: "click" as const,
    target: { kind: "role" as const, role: "button", name: "设置" } };
  const desktopAction = { kind: "click" as const,
    target: { kind: "role" as const, role: "Button", name: "设置" } };
  const browser = bindTarget(browserAction, browserAction.target,
    [{ strategy: "role", matched: true, selected: true, detail: "唯一网页按钮" }],
    { url: "https://example.com/settings" });
  const desktop = bindTarget(desktopAction, { kind: "coordinate", x: 480, y: 80 },
    [{ strategy: "vision", matched: true, selected: true, detail: "截图内唯一目标" }],
    { windowHandle: 42, screenshotHash: "frame-1" });
  assert.deepEqual(browser?.semantic, { label: "设置", role: "button" });
  assert.deepEqual(desktop?.semantic, browser?.semantic);
  assert.equal(browser?.strategy, "role");
  assert.equal(browser?.context.url, "https://example.com/settings");
  assert.equal(desktop?.strategy, "vision");
  assert.deepEqual(desktop?.selected, { kind: "coordinate", x: 480, y: 80 });
  assert.equal(desktop?.context.screenshotHash, "frame-1");
});

test("坐标和选择器不冒充语义目标，含歧义的候选不合并", () => {
  assert.equal(semanticTarget({ kind: "coordinate", x: 1, y: 2 }), undefined);
  assert.equal(semanticTarget({ kind: "selector", selector: "#submit" }), undefined);
  assert.deepEqual(semanticTarget({ kind: "candidates", options: [
    { kind: "role", role: "button", name: "搜索" }, { kind: "text", text: "搜索" },
  ] }), { label: "搜索", role: "button" });
  assert.equal(semanticTarget({ kind: "candidates", options: [
    { kind: "role", role: "button", name: "搜索" }, { kind: "text", text: "删除" },
  ] }), undefined);
});
