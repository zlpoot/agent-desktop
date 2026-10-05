import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatCompletionsModel } from "../src/agent/chat-completions-model.js";

test("视觉定位只接受唯一、高置信度且位于截图内的目标", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-vision-test-"));
  const image = join(dir, "synthetic.png");
  writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAARUlEQVR4nO3OMQHAIBAAsVL/nh8JDDfAkCjImpn5HvbfDpwIVoKVYCVYCVaClWAlWAlWgpVgJVgJVoKVYCVYCVaClWC1AT7qBEy3QrO1AAAAAElFTkSuQmCC", "base64"));
  const responses = [
    { visible: true, unique: true, box: [10, 10, 20, 20], confidence: 0.9 },
    { visible: true, unique: false, box: [10, 10, 20, 20], confidence: 0.9 },
    { visible: true, unique: true, box: [10, 10, 20, 20], confidence: 0.5 },
    { visible: true, unique: true, box: [-1, 10, 20, 20], confidence: 0.9 },
  ];
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(responses.shift()) } }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("模拟模型未启动");
    const model = new ChatCompletionsModel({ apiKey: "test", model: "test",
      baseUrl: `http://127.0.0.1:${address.port}` });
    assert.deepEqual(await model.locateVisualTarget(image, "设置齿轮"),
      { x: 15, y: 15, confidence: 0.9,
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } });
    await assert.rejects(model.locateVisualTarget(image, "设置齿轮"), /不唯一/);
    await assert.rejects(model.locateVisualTarget(image, "设置齿轮"), /置信度不足/);
    await assert.rejects(model.locateVisualTarget(image, "设置齿轮"), /超出截图/);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  }
});
