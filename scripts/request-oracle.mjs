import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = process.env.AGENT_DESKTOP_ORACLE_BASE ?? join(root, '.artifacts', 'agent-desktop', 'oracle');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i]?.startsWith('--') || process.argv[i + 1] === undefined)
    throw new Error('Use --task UUID --kind testbench-phone|todo|desktop-file with check arguments.');
  args.set(process.argv[i].slice(2), process.argv[i + 1]);
}
const taskId = args.get('task');
const kind = args.get('kind');
if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(taskId ?? '')) throw Error('Invalid task UUID.');
let check;
if (kind === 'testbench-phone') {
  const expected = args.get('expected');
  if (!/^1\d{10}$/.test(expected ?? '')) throw Error('Expected an 11-digit phone.');
  check = { kind, expected };
} else if (kind === 'todo') {
  const title = args.get('title');
  const completed = args.get('completed');
  if (!title || title.length > 100 || !['true', 'false'].includes(completed)) throw Error('Invalid Todo title or completed state.');
  check = { kind, title, completed: completed === 'true' };
} else if (kind === 'desktop-file') {
  const fileName = args.get('file');
  const expectedText = args.get('expected');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.txt$/.test(fileName ?? '') || fileName.includes('..') ||
      expectedText === undefined || expectedText.length > 4096) throw Error('Invalid desktop file check.');
  check = { kind, fileName, expectedText };
} else throw Error('Unsupported Oracle kind.');

const statusFile = join(base, 'bridge-status.json');
if (!existsSync(statusFile)) throw Error('Oracle bridge is not running. Install it once and restart AgentDesktop Dashboard.');
const status = JSON.parse(await readFile(statusFile, 'utf8'));
if (status.state !== 'running' || Date.now() - Date.parse(status.updatedAt) > 15000)
  throw Error('Oracle bridge heartbeat is stale. Check AgentDesktop Dashboard.');

const requestId = randomUUID();
const request = { version: 1, requestId, taskId, requestedAt: new Date().toISOString(), check };
const inbox = join(base, 'requests');
const outbox = join(base, 'results');
await mkdir(inbox, { recursive: true });
const name = `${requestId}.json`;
const temporary = join(inbox, `${name}.tmp`);
await writeFile(temporary, JSON.stringify(request), { encoding: 'utf8', flag: 'wx' });
await rename(temporary, join(inbox, name));
const outputPath = join(outbox, name);
let received = false;
for (let i = 0; i < 90; i++) {
  if (existsSync(outputPath)) {
    const result = JSON.parse(await readFile(outputPath, 'utf8'));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === 'unavailable') process.exitCode = 2;
    received = true;
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
if (!received) throw Error(`Oracle did not respond in 90 seconds. Request ID: ${requestId}`);
