import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { FakeModel } from "../src/agent/model-adapter.js";
import { createAgentLoop } from "../src/graph/graph.js";
import { resumeSavedTask } from "../src/graph/resume.js";
import { initialState } from "../src/graph/state.js";
import { PlaywrightRuntime } from "../src/runtime/browser/playwright-runtime.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";

test("浏览器与程序重启后恢复待批准动作，保留会话且只提交一次", async () => {
  let submissions = 0;
  let cookieSeen = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.pathname === "/form") {
      cookieSeen ||= request.headers.cookie?.includes("session=m4") ?? false;
      response.setHeader("Set-Cookie", "session=m4; Path=/");
      response.end('<form method="POST" action="/done"><button>提交</button></form>');
    } else if (url.pathname === "/done" && request.method === "POST") {
      cookieSeen ||= request.headers.cookie?.includes("session=m4") ?? false;
      if (cookieSeen) submissions++;
      response.statusCode = 303;
      response.setHeader("Location", "/done");
      response.end();
    } else if (url.pathname === "/done") {
      response.end("<main>提交成功</main>");
    } else { response.statusCode = 404; response.end("未找到"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const base = `http://127.0.0.1:${address.port}`;
  const dir = mkdtempSync(join(tmpdir(), "computer-use-browser-resume-"));
  const checkpointPath = join(dir, "checkpoints.sqlite");
  const tracePath = join(dir, "trace.sqlite");
  const profile = join(dir, "browser-profile");
  const config = { configurable: { thread_id: "browser-resume-task" } };
  let runtime: PlaywrightRuntime | undefined;
  let trace: SqliteTrace | undefined;
  let checkpoint: SqliteSaver | undefined;
  try {
    runtime = await PlaywrightRuntime.launch({ artifactDir: join(dir, "screenshots"), userDataDir: profile });
    trace = new SqliteTrace(tracePath);
    checkpoint = SqliteSaver.fromConnString(checkpointPath);
    const graph = createAgentLoop({ model: new FakeModel([
      { kind: "navigate", url: `${base}/form` },
      { kind: "click", target: { kind: "role", role: "button", name: "提交" } },
    ]), runtime, trace, checkpointer: checkpoint });
    const paused = await graph.invoke(initialState("browser-resume-task", "提交表单", undefined,
      { urlIncludes: "/done", pageTextIncludes: "提交成功" }), config);
    assert.equal(paused.status, "waiting_user");
    assert.equal(submissions, 0);
    await runtime.close(); runtime = undefined;
    trace.close(); trace = undefined;
    checkpoint.db.close(); checkpoint = undefined;

    runtime = await PlaywrightRuntime.launch({ artifactDir: join(dir, "screenshots"), userDataDir: profile });
    trace = new SqliteTrace(tracePath);
    checkpoint = SqliteSaver.fromConnString(checkpointPath);
    const resumedGraph = createAgentLoop({ model: new FakeModel([
      { kind: "done", summary: "提交完成" },
    ]), runtime, trace, checkpointer: checkpoint });
    const result = await resumeSavedTask(resumedGraph, runtime, "browser-resume-task", { approved: true });
    assert.equal(result.status, "done");
    assert.equal(result.goalVerification?.ok, true);
    assert.equal(submissions, 1);
    assert.equal(cookieSeen, true);
  } finally {
    await runtime?.close();
    trace?.close();
    checkpoint?.db.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
