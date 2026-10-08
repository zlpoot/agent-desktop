import { resolve } from 'node:path';
import { createDashboardPreflight } from '../composition/dashboard-preflight.js';
import { createDashboardServer } from './server.js';

const args = process.argv.slice(2);
if (args.length !== 2 && args.length !== 4 || args[0] !== '--config' || !args[1] ||
    args.length === 4 && args[2] !== '--port') {
  throw new Error('Usage: npm run dashboard:preflight -- --config <operator-file> [--port 4173]');
}
const port = args.length === 4 ? Number(args[3]) : 4173;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid-preflight-port');
const assembly = await createDashboardPreflight(resolve(args[1]), process.cwd());
const server = createDashboardServer(process.cwd(), assembly.controller, undefined, undefined, undefined, undefined, assembly.view);
let stopping: Promise<void> | undefined;
const stop = () => stopping ??= (async () => {
  try { await new Promise<void>(done => server.close(() => done())); }
  finally { await assembly.close(); process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown); }
})();
const shutdown = () => { void stop().catch(() => { console.error('A1 preflight shutdown failed'); process.exitCode = 1; }); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
server.on('error', () => { console.error('A1 preflight listen failed; check localhost port'); process.exitCode = 1; shutdown(); });
server.listen(port, '127.0.0.1', () => {
  console.log(`A1 环境预检：http://127.0.0.1:${port}/#/apps`);
  console.log('配置已显式加载。扫描/启动/Task/模型/输入/VM 控制关闭。Ctrl+C 停止。NOT HUMAN-VERIFIED。');
});
