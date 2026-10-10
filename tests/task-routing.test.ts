import assert from "node:assert/strict";
import { test } from "node:test";
import { routeTask } from "../src/app/task-routing.js";
import { createDefaultExtensionRegistry } from "../src/extensions/index.js";

const registry = createDefaultExtensionRegistry({ rootDir: process.cwd() });

test("仅已验收操作命中专用能力，其他应用需求进入通用主线", () => {
  const music = routeTask("打开网易云播放稻香", {}, registry);
  assert.equal(music.kind, "specialized");
  if (music.kind === "specialized") assert.equal(music.capability.id, "netease.play");

  const nte = routeTask("在异环里把主音量调到 50%", { admin: true }, registry);
  assert.equal(nte.kind, "specialized");
  if (nte.kind === "specialized") assert.equal(nte.capability.id, "nte.volume.50");

  assert.deepEqual(routeTask("查看网易云的设置页", {}, registry),
    { kind: "generic", goal: "查看网易云的设置页" });
  assert.deepEqual(routeTask("查看异环当前画面", {}, registry),
    { kind: "generic", goal: "查看异环当前画面" });
  assert.deepEqual(routeTask("查看炉石传说酒馆战棋战绩", {}, registry),
    { kind: "generic", goal: "查看炉石传说酒馆战棋战绩" });
  assert.deepEqual(routeTask("VM: 打开网易云播放稻香", { desktopTarget: { providerId: "fixture", environmentId: "env" } }, registry),
    { kind: "generic", goal: "VM: 打开网易云播放稻香" });
  assert.throws(() => routeTask("打开网易云播放稻香", { admin: true }, registry), /仅适用于/);
  assert.throws(() => routeTask("查看异环当前画面", { admin: true }, registry), /通用任务暂不支持/);
  assert.deepEqual(routeTask('打开网易云播放稻香', { destination: 'browser' }, registry),
    { kind: 'generic', goal: '打开网易云播放稻香' });
  assert.throws(() => routeTask('普通 Browser goal', { destination: 'browser', admin: true }, registry), /通用任务暂不支持/);
  assert.throws(() => routeTask('普通 Browser goal', { destination: 'browser', desktopTarget: { providerId: 'fixture', environmentId: 'env' } }, registry), /desktop-target-destination-conflict/);
});
