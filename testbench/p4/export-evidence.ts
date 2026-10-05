import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SqliteTrace } from '../../src/trace/sqlite-trace.js';
import { WorkflowStore } from '../../src/workflows/store.js';
import { readTaskBudget } from '../../src/runtime/model-budget.js';

const [outputFile, ...cases] = process.argv.slice(2);
if (!outputFile || cases.length < 2)
  throw new Error('Usage: export-evidence.ts <output.json> <case-dir> <case-dir> ...');
const result = [];
for (const dir of cases) {
  const rootDir = resolve(dir);
  const taskId = readFileSync(resolve(rootDir, 'task-id.txt'), 'utf8').trim();
  const trace = new SqliteTrace(resolve(rootDir, 'web-tasks.sqlite'));
  const workflows = new WorkflowStore(resolve(rootDir, 'workflows.sqlite'));
  try {
    const state = trace.load(taskId);
    assert(state);
    const events = trace.events(taskId);
    const actions = events.filter(event => event.node === 'execute').map(event => {
      const action = event.state.lastAction;
      const target = action && 'target' in action ? action.target : undefined;
      return { step: event.step, kind: action?.kind,
        target: target?.kind === 'role' ? target.name : undefined,
        text: action?.kind === 'type' ? action.text : undefined,
        effect: event.state.lastResult?.effect };
    });
    assert.equal(state.status, 'done');
    assert.equal(state.goalVerification?.ok, true);
    assert.equal(state.completedStages?.length, 3);
    assert.equal(actions.filter(action => action.target === '打开张三资料').length, 1);
    assert.equal(actions.filter(action => action.target === '保存客户资料').length, 1);
    assert.equal(state.completedStages[1].workflowVersion, 1);
    assert(workflows.get('p4-live-phone', 2));
    result.push({ taskId, status: state.status, step: state.step,
      stages: state.completedStages.map(stage => ({ goal: stage.goal, source: stage.source,
        workflowId: stage.workflowId, workflowVersion: stage.workflowVersion,
        evidencePresent: !!stage.evidence })),
      actions, eventSequence: events.map(event => event.node),
      workflowVersionsAvailable: [1, 2], checkpointLineage: state.checkpointLineage,
      retryCount: state.retryCount, goalVerification: state.goalVerification,
      modelBudget: readTaskBudget(rootDir, taskId)?.usage,
      modelBudgetNote: 'Synthetic usage from deterministic fixture; no DeepSeek or JEV request.' });
  } finally { workflows.close(); trace.close(); }
}
const output = resolve(outputFile);
writeFileSync(output, JSON.stringify({
  generatedAt: new Date().toISOString(),
  environment: 'Real Hyper-V Windows Guest, real AgentDesktop Worker and TestBench; deterministic Host model',
  cases: result,
}, null, 2) + '\n');
console.log(output);
