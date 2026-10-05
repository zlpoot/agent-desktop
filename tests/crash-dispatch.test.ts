import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { MemorySaver } from "@langchain/langgraph";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";
import { recoverDesktopTasks, restartedDesktopState } from "../src/desktop-session/recovery.js";
import { createAgentLoop } from "../src/graph/graph.js";
import { FakeModel } from "../src/agent/model-adapter.js";
import { WorkflowReplayModel } from "../src/workflows/replay-model.js";
import { reconcileWorkflow } from "../src/workflows/recovery.js";
import type { Workflow } from "../src/workflows/schema.js";

for (const workflowMode of [false, true]) for (const applied of [false, true]) test(`真实子进程${workflowMode ? ' Workflow' : ''}在动作${applied ? "已生效响应丢失" : "未生效"}时崩溃，不盲目重放`, { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "crash-dispatch-"));
  const workflow: Workflow = { id: 'crash-workflow', version: 1, status: 'verified', environment: 'windows',
    taskPattern: 'controlled test', inputs: [], preconditions: [], steps: [{ goal: 'complete',
      action: { kind: 'keypress', keys: 'space' }, preferredMethods: [], successCondition: { kind: 'text_includes', value: 'complete' } }],
    successConditions: { pageTextIncludes: 'complete' }, knownFailures: [], sourceTaskId: 'fixture', sourceTrace: '', createdAt: '', successCount: 0, failureCount: 0 };
  writeFileSync(join(dir, 'workflow.json'), JSON.stringify(workflow));
  const child = fork(new URL("./fixtures/crash-dispatch.ts", import.meta.url), [dir, applied ? "applied" : "none", ...(workflowMode ? ['workflow'] : [])],
    { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let trace: SqliteTrace | undefined;
  try {
    const [message] = await once(child, "message");
    assert.deepEqual(message, { boundary: "execute-entered" });
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    trace = new SqliteTrace(join(dir, "web-tasks.sqlite"));
    assert.ok(trace.load("crash-task")?.inFlightAction);
    assert.equal(trace.events("crash-task").at(-1)?.node, "dispatch_pending");
    recoverDesktopTasks(dir);
    assert.equal(trace.load("crash-task")?.status, "paused");
    let executions = 0;
    const graph = createAgentLoop({ trace, checkpointer: new MemorySaver(),
      model: workflowMode ? new WorkflowReplayModel(workflow, new FakeModel([])) : new FakeModel([]),
      ...(workflowMode ? { workflowRecovery: state => reconcileWorkflow(state, workflow) } : {}),
      runtime: {
        observe: async () => ({ pageText: existsSync(join(dir, "effect.txt")) ? readFileSync(join(dir, "effect.txt"), "utf8") : "before" }),
        execute: async () => { executions++; throw new Error("must not replay"); },
      } });
    for (let restart = 0; restart < (applied ? 1 : 2); restart++) {
      const recovered = restartedDesktopState(trace.load("crash-task")!);
      await graph.invoke(recovered, { configurable: { thread_id: recovered.checkpointThreadId } });
      assert.equal(trace.load("crash-task")?.status, applied ? "done" : workflowMode ? "paused" : "waiting_user");
      assert.equal(executions, 0);
    }
    assert.ok(trace.events("crash-task").some(e => e.node === (workflowMode ? "workflow_recovery" : "resume_reconcile")));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
    trace?.close(); rmSync(dir, { recursive: true, force: true });
  }
});
