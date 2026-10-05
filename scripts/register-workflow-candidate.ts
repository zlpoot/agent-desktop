import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkflowStore } from '../src/workflows/store.js';
import { workflowDigest } from '../src/workflows/recovery.js';
import type { Workflow } from '../src/workflows/schema.js';

const source = process.argv[2];
if (!source) throw new Error('Usage: node --import tsx scripts/register-workflow-candidate.ts <workflow.json>');
const proposed = JSON.parse(readFileSync(resolve(source), 'utf8')) as Workflow;
if (!proposed || proposed.status !== 'candidate' || proposed.environment !== 'windows' ||
    proposed.scope === 'stage' || !proposed.id || !proposed.taskPattern ||
    !Array.isArray(proposed.steps) || !proposed.steps.length ||
    !Array.isArray(proposed.preconditions) || !Array.isArray(proposed.inputs))
  throw new Error('Expected a Windows task-scope candidate Workflow with steps');
const store = new WorkflowStore(resolve('workflows.sqlite'));
try {
  const saved = store.addCandidate(proposed);
  console.log(JSON.stringify({id:saved.id,version:saved.version,status:saved.status,
    definitionHash:workflowDigest(saved)}));
} finally { store.close(); }
