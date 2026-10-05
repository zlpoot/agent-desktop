// Controlled startup probe: no model, account, VM or physical desktop input.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const env = { ...process.env, DASHBOARD_PORT: String(port) };
for (const key of Object.keys(env)) {
  if (/^(COMPUTER_USE_|AGENT_DESKTOP_|JEV_|NETEASE_APP_PATH$)/.test(key)) delete env[key];
}
const child = spawn(process.execPath, ['--import', 'tsx', 'src/app/start.ts'],
  { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', data => { output += data; });
child.stderr.on('data', data => { output += data; });
const exited = new Promise(resolve => child.on('exit', resolve));
try {
  const until = Date.now() + 20000;
  while (!output.includes(`127.0.0.1:${port}`)) {
    if (child.exitCode !== null || Date.now() > until) throw Error(`Dashboard failed to start: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const base = `http://127.0.0.1:${port}`;
  for (const path of ['/', '/api/runtime/plugins', '/api/prompts', '/api/workflows']) {
    const response = await fetch(base + path);
    if (!response.ok) throw Error(`${path}: ${response.status}`);
  }
  console.log('Dashboard startup and local read routes PASS; model/Guest configuration absent');
} finally {
  child.kill('SIGTERM');
  await exited;
}
