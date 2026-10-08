import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createDashboardPreflight } from '../composition/dashboard-preflight.js';
import { createDashboardDiscovery } from '../composition/dashboard-discovery.js';
import { createDashboardBridgePreview } from '../composition/dashboard-bridge-preview.js';
import { createDashboardServer } from './server.js';

const args = process.argv.slice(2);
const discovery = args[0] === '--readonly-discovery';
const bridgePreview = args[0] === '--bridge-preview';
if (discovery || bridgePreview) args.shift();
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  if (!['--config', '--port', ...(discovery ? ['--python'] : [])].includes(args[i]) ||
      !args[i + 1] || args[i + 1].startsWith('--') || options.has(args[i])) {
    throw new Error('Usage: npm run dashboard:preflight|dashboard:discovery|dashboard:bridge-preview -- --config <operator-file> [--port 4173] [--python <trusted-python> (A2 only)]');
  }
  options.set(args[i], args[i + 1]);
}
if (!options.get('--config')) throw new Error('preflight-explicit-config-required');
const port = Number(options.get('--port') ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid-preflight-port');
const rootDir = process.cwd();
const python = options.get('--python') ?? (existsSync(resolve(rootDir, '.venv/Scripts/python.exe'))
  ? resolve(rootDir, '.venv/Scripts/python.exe') : 'python');
const assembly = discovery ? await createDashboardDiscovery(resolve(options.get('--config')!), rootDir, python)
  : bridgePreview ? await createDashboardBridgePreview(resolve(options.get('--config')!), rootDir)
  : await createDashboardPreflight(resolve(options.get('--config')!), rootDir);
const server = createDashboardServer(process.cwd(), assembly.controller, undefined, undefined, undefined, undefined, assembly.view);
let stopping: Promise<void> | undefined;
const stop = () => stopping ??= (async () => {
  try { await new Promise<void>(done => server.close(() => done())); }
  finally { await assembly.close(); process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown); }
})();
const shutdown = () => { void stop().catch(() => { console.error('Dashboard preflight shutdown failed'); process.exitCode = 1; }); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
server.on('error', () => { console.error('Dashboard preflight listen failed; check localhost port'); process.exitCode = 1; shutdown(); });
server.listen(port, '127.0.0.1', () => {
  console.log(`${bridgePreview ? 'P8-B 任务桥接只读预览' : discovery ? 'A2 只读应用发现' : 'A1 环境预检'}：http://127.0.0.1:${port}/#/apps`);
  console.log(bridgePreview ? '只读预览：真实桥接不可用，目标验收待反馈；扫描/启动/任务/模型/输入/虚拟机关闭。Ctrl+C 停止。' : discovery ? '配置已显式加载。扫描/路径检查仅由操作者点击触发；启动/任务/模型/输入/虚拟机控制关闭。Ctrl+C 停止。A2 人工体验待反馈。'
    : '配置已显式加载。扫描/启动/任务/模型/输入/虚拟机控制关闭。Ctrl+C 停止。');
});
