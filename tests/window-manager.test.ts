import assert from "node:assert/strict";
import test from "node:test";
import { selectUniqueWindow, WindowManager } from "../src/runtime/desktop/window-manager.js";
import type { WindowInfo } from "../src/runtime/desktop/desktop-runtime.js";

const window: WindowInfo = { handle: 101, title: "测试窗口", windowClass: "TestWindow",
  processId: 10, processPath: "C:\\test.exe", targetElevated: false,
  visible: true, minimized: false, foreground: false,
  rect: { left: 0, top: 0, width: 800, height: 600 } };

test("窗口管理器拒绝不唯一目标及非绝对启动路径", async () => {
  assert.equal(selectUniqueWindow([]), undefined);
  assert.deepEqual(selectUniqueWindow([window]), window);
  assert.throws(() => selectUniqueWindow([window, { ...window, handle: 102 }]), /必须指定唯一/);
  const manager = new WindowManager(".artifacts/test-window-manager");
  await assert.rejects(() => manager.ensure({ windowTitle: "测试窗口" }, "relative.exe"), /绝对路径/);
});
