import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { ChatCompletionsModel } from "../src/agent/chat-completions-model.js";
import type { Workflow } from "../src/workflows/schema.js";

test("语义检索只能选择存储中的流程，参数必须来自当前目标", async () => {
  const workflow: Workflow = { id: "saved", version: 2, status: "verified", environment: "browser",
    taskPattern: "搜索 {{input1}}", inputs: [{ name: "input1", example: "苹果" }],
    preconditions: [], steps: [{ goal: "输入 {{input1}}",
      action: { kind: "type", target: { kind: "role", role: "textbox", name: "搜索" },
        text: "{{input1}}" }, preferredMethods: ["accessibility"],
      successCondition: { kind: "text_includes", value: "{{input1}}" } }],
    successConditions: { pageTextIncludes: "{{input1}}" }, knownFailures: [],
    sourceTaskId: "source", sourceTrace: "trace.sqlite", createdAt: new Date().toISOString(),
    successCount: 1, failureCount: 0 };
  const answers = [
    { workflow_id: "unknown", version: 2, inputs: { input1: "香蕉" } },
    { workflow_id: "saved", version: 2, inputs: { input1: "梨子" } },
    { workflow_id: "saved", version: 2, inputs: { input1: "香蕉" } },
  ];
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answers.shift()) } }] }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("模拟模型未启动");
    const model = new ChatCompletionsModel({ apiKey: "test", model: "test",
      baseUrl: `http://127.0.0.1:${address.port}` });
    assert.equal((await model.matchWorkflows("帮我查找香蕉", [workflow])).match, undefined);
    assert.equal((await model.matchWorkflows("帮我查找香蕉", [workflow])).match, undefined);
    const result = await model.matchWorkflows("帮我查找香蕉", [workflow]);
    assert.equal(result.match?.workflow.id, "saved");
    assert.deepEqual(result.match?.values, { input1: "香蕉" });
  } finally { await new Promise<void>((done) => server.close(() => done())); }
});
