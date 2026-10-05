import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { registeredApps, registeredGuestApps } from "../src/runtime/desktop/app-catalog.js";
import { FileTool } from "../src/runtime/system/file-tool.js";
import { inspectPort, inspectProcess } from "../src/runtime/system/inspector.js";

test("应用目录只接受合法登记，并拒绝重复 ID 和相对程序路径", async () => {
  const dir = await mkdtemp(join(tmpdir(), "computer-use-apps-"));
  try {
    await writeFile(join(dir, "apps.local.json"), JSON.stringify([{
      id: "demo", name: "示例", executable: resolve("demo.exe"), args: [], windowTitle: "示例",
    }]));
    assert.equal((await registeredApps(dir)).find((app) => app.id === "demo")?.name, "示例");
    await writeFile(join(dir, "apps.local.json"), JSON.stringify([{
      id: "demo", name: "示例", executable: "demo.exe", args: [],
    }]));
    await assert.rejects(registeredApps(dir), /绝对可执行文件路径/);
    await writeFile(join(dir, "apps.local.json"), JSON.stringify([
      { id: "demo", name: "示例", executable: resolve("demo.exe"), args: [] },
      { id: "demo", name: "重复", executable: resolve("demo2.exe"), args: [] },
    ]));
    await assert.rejects(registeredApps(dir), /重复/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Guest 应用从共享配置读取，增减应用无需修改规划器", async () => {
  const dir = await mkdtemp(join(tmpdir(), "computer-use-guest-apps-"));
  try {
    await mkdir(join(dir, "config"));
    const manifest = join(dir, "config", "agent-desktop-apps.json");
    const app = { id: "sample", name: "示例", executable: resolve("sample.exe"),
      args: [], windowClass: "SampleWindow" };
    await writeFile(manifest, JSON.stringify([app]));
    assert.deepEqual((await registeredGuestApps(dir)).map((item) => item.id), ["sample"]);
    await writeFile(manifest, JSON.stringify([app, { ...app, id: "second" }]));
    assert.deepEqual((await registeredGuestApps(dir)).map((item) => item.id), ["sample", "second"]);
    await writeFile(manifest, JSON.stringify([{ ...app, windowClass: undefined }]));
    await assert.rejects(registeredGuestApps(dir), /窗口类名或标题/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("文件工具限制目录、链接、覆盖，并完成复制和重命名", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "computer-use-files-"));
  try {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "source.txt"), "示例内容");
    const files = await FileTool.open(dir);
    assert.equal(await files.readText("source.txt"), "示例内容");
    await files.copy("source.txt", "sub/copied.txt");
    await assert.rejects(files.copy("source.txt", "sub/copied.txt"), /EEXIST/);
    await files.rename("sub/copied.txt", "renamed.txt");
    assert.equal(await readFile(join(dir, "sub", "renamed.txt"), "utf8"), "示例内容");
    await assert.rejects(files.readText("../outside.txt"), /超出/);
    const outside = await mkdtemp(join(tmpdir(), "computer-use-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "outside");
      try {
        await symlink(join(outside, "secret.txt"), join(dir, "link.txt"));
        await assert.rejects(files.readText("link.txt"), /符号链接/);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
        t.diagnostic("当前 Windows 权限不允许创建测试用符号链接，跳过链接分支");
      }
    } finally { await rm(outside, { recursive: true, force: true }); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("系统查询仅返回指定 PID 与端口的状态", async () => {
  const processDetails = await inspectProcess(process.pid);
  assert.equal(processDetails?.pid, process.pid);
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("端口测试服务未启动");
    const connections = await inspectPort(address.port);
    assert.ok(connections.some((item) => item.port === address.port && item.status === "LISTEN"));
    await assert.rejects(inspectPort(70000), /合法正整数/);
  } finally { await new Promise<void>((done) => server.close(() => done())); }
});
