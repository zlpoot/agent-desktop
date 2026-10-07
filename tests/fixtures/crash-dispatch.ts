import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeModel } from "../../src/agent/model-adapter.js";
import { createAgentLoop } from "../../src/graph/graph.js";
import { initialState } from "../../src/graph/state.js";
import { SqliteTrace } from "../../src/trace/sqlite-trace.js";
import { WorkflowReplayModel } from "../../src/workflows/replay-model.js";
import { workflowDigest } from "../../src/workflows/recovery.js";

const [dir, effect, workflowMode] = process.argv.slice(2);
const trace = new SqliteTrace(join(dir, "web-tasks.sqlite"));
const workflow = workflowMode ? JSON.parse(readFileSync(join(dir, 'workflow.json'), 'utf8')) : undefined;
const state = { ...initialState("crash-task", "controlled test", undefined, { pageTextIncludes: "complete" }), desktopVmId: "synthetic-vm" };
if (workflow) state.workflowRef = { id: workflow.id, version: workflow.version, values: {}, definitionHash: workflowDigest(workflow) };
await createAgentLoop({ trace, recoveryJournal: true,
  model: workflow ? new WorkflowReplayModel(workflow, new FakeModel([])) : new FakeModel([{ kind: "keypress", keys: "space" }]),
  runtime: {
    observe: async () => ({ pageText: "before" }),
    execute: async () => {
      if (effect === "applied") writeFileSync(join(dir, "effect.txt"), "complete");
      // The parent kills this process only after the real graph wrote dispatch_pending.
      process.send?.({ boundary: "execute-entered" });
      await new Promise(() => {});
      throw new Error("unreachable");
    },
  },
}).invoke(state);
