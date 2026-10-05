import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { JevChoiceModel } from "../src/agent/jev-choice-model.js";
import { initialState } from "../src/graph/state.js";

test("Jev 只能选择项目提供的动作，并记录用量", async () => {
  let received: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== "Bearer test-key") {
      response.statusCode = 401; response.end("{}"); return;
    }
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ object: "list", data: [{ id: "jev" }] })); return;
    }
    if (request.url === "/v1/systemone" && request.method === "POST") {
      let text = "";
      for await (const chunk of request) text += String(chunk);
      received = JSON.parse(text) as Record<string, unknown>;
      response.end(JSON.stringify({ model: "typesafe-ai/jev", answers: {
        next_action: { type: "choice", choice: "action_0", confidence: 0.98,
          probabilities: { action_0: 0.98, action_1: 0.02 } },
      }, usage: { input_tokens: 80, output_tokens: 10 } }));
      return;
    }
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("模拟服务未启动");
  const actions = [
    { kind: "click" as const, target: { kind: "role" as const, role: "Button", name: "搜索" } },
    { kind: "click" as const, target: { kind: "role" as const, role: "Button", name: "退出" } },
  ];
  try {
    const model = new JevChoiceModel({ baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "test-key", candidateActions: () => actions });
    await model.checkConnection();
    assert.deepEqual(await model.decide({ ...initialState("task", "搜索歌曲"),
      observation: { accessibility: "Button | 搜索\nButton | 退出" } }), actions[0]);
    assert.equal(received?.model, "jev");
    assert.deepEqual(Object.keys((received?.questions as { next_action: { criteria: object } })
      .next_action.criteria), ["action_0", "action_1"]);
    assert.match(JSON.stringify(received?.state), /搜索歌曲/);
    assert.deepEqual(model.takeUsage(), { inputTokens: 80, outputTokens: 10, totalTokens: 90 });
    assert.equal(model.takeUsage(), undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Jev 拒绝没有候选动作或无效置信度阈值", async () => {
  const noCandidates = new JevChoiceModel({ baseUrl: "http://127.0.0.1:1",
    apiKey: "test-key", candidateActions: () => [] });
  await assert.rejects(() => noCandidates.decide(initialState("task", "目标")), /1 到 64/);
  assert.throws(() => new JevChoiceModel({ baseUrl: "http://localhost",
    apiKey: "test-key", candidateActions: () => [], confidenceThreshold: 2 }), /阈值/);
});

test("Jev 低置信度时不会执行所选动作", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ answers: { next_action: {
      type: "choice", choice: "action_0", confidence: 0.4,
      probabilities: { action_0: 0.4, action_1: 0.6 },
    } }, usage: { input_tokens: 12, output_tokens: 3 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("模拟服务未启动");
  try {
    const model = new JevChoiceModel({ baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "test-key", candidateActions: () => [
        { kind: "click", target: { kind: "role", role: "Button", name: "搜索" } },
        { kind: "click", target: { kind: "role", role: "Button", name: "退出" } },
      ] });
    await assert.rejects(() => model.decide(initialState("task", "搜索")), /置信度不足/);
    assert.deepEqual(model.takeUsage(), { inputTokens: 12, outputTokens: 3, totalTokens: 15 });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
