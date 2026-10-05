import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createDashboardServer } from "../src/app/server.js";
import { promptDefinitions, readPrompt } from "../src/agent/prompt-store.js";

test("提示词可以通过本机页面接口维护，修改立即被读取", async () => {
  const root = mkdtempSync(join(tmpdir(), "computer-use-prompts-"));
  mkdirSync(join(root, "prompts"));
  for (const item of promptDefinitions) {
    copyFileSync(resolve("prompts", item.file), join(root, "prompts", item.file));
  }
  const server = createDashboardServer(root);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("页面服务未启动");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const list = await fetch(`${base}/api/prompts`);
    assert.equal(list.status, 200);
    assert.equal((await list.json()).prompts.length, promptDefinitions.length);
    const update = await fetch(`${base}/api/prompts/task-planner`, {
      method: "PUT", headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ content: "新的中文规划提示词" }),
    });
    assert.equal(update.status, 200);
    assert.equal(readPrompt("task-planner", root), "新的中文规划提示词");
    const invalid = await fetch(`${base}/api/prompts/outside`, {
      method: "PUT", headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ content: "不可写" }),
    });
    assert.equal(invalid.status, 400);
    const foreign = await fetch(`${base}/api/prompts/task-planner`, {
      method: "PUT", headers: { "Content-Type": "application/json", Origin: "http://elsewhere.test" },
      body: JSON.stringify({ content: "不应生效" }),
    });
    assert.equal(foreign.status, 403);
    assert.equal(readPrompt("task-planner", root), "新的中文规划提示词");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
