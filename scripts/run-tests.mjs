import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const mode = process.argv[2] ?? 'offline';
if (!['offline', 'browser', 'all'].includes(mode)) throw Error('Use offline|browser|all');
const browser = new Set(JSON.parse(readFileSync('tests/browser-tests.json', 'utf8')));
const files = readdirSync('tests').filter(name => name.endsWith('.test.ts') &&
  (mode === 'all' || browser.has(name) === (mode === 'browser'))).sort();
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(COMPUTER_USE_|AGENT_DESKTOP_|JEV_|NETEASE_APP_PATH$)/.test(key)) delete env[key];
}
// Serial files avoid browser contention and race-sensitive wall-clock failures.
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test',
  '--test-concurrency=1', '--test-reporter=tap', ...files.map(name => `tests/${name}`)],
  { env, stdio: 'inherit' });
process.exit(result.status ?? 1);
