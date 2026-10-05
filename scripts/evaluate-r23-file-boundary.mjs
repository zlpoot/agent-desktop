import { requiredEndpoint } from '../src/agent/local-config.ts';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileEvidenceInput, currentFileEvidence } from '../src/verification/file-evidence.ts';
import { taskEvidenceInput } from '../src/verification/task-evidence.ts';
import { VerificationEngine } from '../src/verification/engine.ts';
import { JevSemanticVerifier } from '../src/verification/jev.ts';
import { configuredVerifier } from '../src/agent/local-config.ts';

const fixturePath = resolve('testbench/verification/r23-file-cases.json');
const fixtureBytes = readFileSync(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
const useJev = process.argv.includes('--jev');
const key = useJev ? (process.env.COMPUTER_USE_API_KEY ?? readFileSync('.env.local', 'utf8')
  .split(/\r?\n/).find(line => /^\s*COMPUTER_USE_API_KEY\s*=/.test(line))
  ?.replace(/^\s*COMPUTER_USE_API_KEY\s*=\s*/, '').trim().replace(/^(['"])(.*)\1$/, '$2')) : undefined;
if (useJev && !key) throw new Error('JEV key is unavailable');
const jev = useJev ? new JevSemanticVerifier({ baseUrl: requiredEndpoint('JEV_BASE_URL'),
  apiKey: key, instructions: () => readFileSync('prompts/verification-semantic.md', 'utf8') }) : undefined;
const hybrid = useJev ? configuredVerifier() : undefined;
const sha = value => createHash('sha256').update(value).digest('hex');
const root = 'C:\\Users\\agent\\Desktop';
const path = `${root}\\result.txt`;
const expectedFile = { kind: 'desktop_file', path: 'result.txt', contentEquals: 'hello' };
const snapshot = (value, time) => value === 'rpc-unavailable' ? undefined : {
  path, root, capturedAt: time, exists: value !== null, complete: true,
  ...(value !== null ? { kind: 'file', size: Buffer.byteLength(value), mtimeMs: time - 5,
    sha256: sha(value), text: value } : {}),
};
const before = snapshot(null, 1000);
const after = snapshot('hello', 1100);
const observation = { windowTitle: 'result.txt - Notepad', pageText: 'hello',
  textEvidence: [{ source: 'uia', text: 'hello' }], capture: {
    epoch: 'fixture-r23', object: 'window:7', sequence: 3, startedAt: 1200, finishedAt: 1250,
    clock: 'collector', atomic: false, fields: { pageText: { source: 'uia', complete: true } },
  } };
const criteria = { windowTitleIncludes: 'result.txt', pageTextIncludes: 'hello' };
const now = () => performance.now();
const rows = [];
for (const item of fixture.cases) {
  const id = `r23-${item.id}`;
  let normalized;
  if (item.layer === 'action') normalized = fileEvidenceInput(id, 1, expectedFile, before,
    snapshot(item.after, 1100), 'dispatched');
  else if (item.proof === false) normalized = { reason: 'missing_declared_file_proof' };
  else {
    const proof = { taskId: id, step: 1, expected: expectedFile, before, after };
    const checked = currentFileEvidence(proof, snapshot(item.current, 1300));
    normalized = checked.current ? taskEvidenceInput(id, 'Save hello to result.txt', criteria,
      observation, { exactContract: true, files: [{ proof, current: checked.current }] })
      : { reason: checked.reason };
  }
  const evaluate = async auxiliary => {
    if (!normalized.input) return { verdict: 'unknown', reason: normalized.reason, modelCalls: 0,
      inputTokens: 0, outputTokens: 0, durationMs: 0 };
    const result = await new VerificationEngine({}, auxiliary).verify(normalized.input);
    return { verdict: result.verdict, checks: result.checks, ...result.metrics };
  };
  const rule = await evaluate(undefined);
  const ruleJev = useJev ? await evaluate(jev) : { status: 'not_run' };
  let legacy = { status: 'not_run' };
  if (hybrid) {
    const started = now();
    const result = await hybrid.evaluate('Save hello to Desktop/result.txt', criteria, observation, 'task');
    legacy = { verdict: result.verdict, checks: result.checks, auxiliary: result.auxiliary,
      durationMs: now() - started, modelCalls: result.auxiliary && !result.auxiliary.error ? 1 : 0,
      inputTokens: result.auxiliary?.usage?.inputTokens ?? 0,
      outputTokens: result.auxiliary?.usage?.outputTokens ?? 0 };
  }
  rows.push({ id: item.id, layer: item.layer, expected: item.expected, labelStatus: fixture.labelStatus,
    normalizedReason: normalized.reason, rule, ruleJev, legacy });
}
const summary = field => {
  const evaluated = rows.filter(row => row[field].verdict);
  const times = evaluated.map(row => row[field].durationMs).sort((a, b) => a - b);
  return { evaluated: evaluated.length, correct: evaluated.filter(row => row[field].verdict === row.expected).length,
    falsePass: evaluated.filter(row => row[field].verdict === 'pass' && row.expected !== 'pass').length,
    falseFail: evaluated.filter(row => row[field].verdict === 'fail' && row.expected !== 'fail').length,
    unknown: evaluated.filter(row => row[field].verdict === 'unknown').length,
    p50Ms: times.length ? times[Math.floor(times.length / 2)] : null,
    p95Ms: times.length ? times[Math.ceil(times.length * .95) - 1] : null,
    modelCalls: evaluated.reduce((n, row) => n + (row[field].modelCalls ?? 0), 0),
    inputTokens: evaluated.reduce((n, row) => n + (row[field].inputTokens ?? 0), 0),
    outputTokens: evaluated.reduce((n, row) => n + (row[field].outputTokens ?? 0), 0) };
};
const report = { version: fixture.version, fixtureHash: sha(fixtureBytes),
  codeHashes: Object.fromEntries([
    'src/verification/file-evidence.ts', 'src/verification/task-evidence.ts',
    'src/verification/engine.ts', 'src/verification/jev.ts',
    'src/verifier/hybrid-verifier.ts', 'prompts/verification-semantic.md',
    'scripts/evaluate-r23-file-boundary.mjs',
  ].map(file => [file, sha(readFileSync(file))])),
  createdAt: new Date().toISOString(), labelStatus: fixture.labelStatus,
  scope: 'Synthetic same-window replay. New verifier receives declared file snapshots; legacy HybridVerifier only accepts the window observation. Timings exclude collection and network setup.',
  summary: { rule: summary('rule'), ruleJev: summary('ruleJev'), legacy: summary('legacy') }, rows };
const output = resolve('.artifacts/verification-r23', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, fixtureHash: report.fixtureHash, summary: report.summary }, null, 2));
if (process.argv.includes('--strict') && (report.summary.rule.correct !== fixture.cases.length ||
  useJev && report.summary.ruleJev.correct !== fixture.cases.length)) process.exitCode = 1;
