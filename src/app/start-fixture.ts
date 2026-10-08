import { resolve } from 'node:path';
import { createFixtureDashboard } from '../composition/fixture-dashboard.js';
import { createShutdown } from '../composition/shutdown.js';
import { createDashboardServer } from './server.js';

// A separate data directory prevents importing normal Dashboard traces/configuration.
const rootDir = resolve('.artifacts', 'mvp-fixture');
const assembly = await createFixtureDashboard(rootDir);
const server = createDashboardServer(rootDir, assembly.controller, undefined, undefined,
  undefined, assembly.inspect, undefined, true);
const shutdown = createShutdown(server, assembly);
const stop = () => { void shutdown().catch(error => { console.error(error); process.exitCode = 1; }); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
server.once('error', error => { console.error(error); process.exitCode = 1; stop(); });
server.listen(Number(process.env.DASHBOARD_PORT ?? 4173), '127.0.0.1', () => {
  console.log('合成固定场景 Dashboard：http://127.0.0.1:' + (server.address() as { port: number }).port);
  console.log('无真实桌面输入、应用启动或模型调用。结果仅证明合成链路；NOT HUMAN VERIFIED。');
});
