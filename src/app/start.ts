import { createDashboardServer } from "./server.js";
import { createRootAssembly } from "../composition/root.js";
import { mountSessionScope } from "../composition/session-scope.js";
import { createShutdown } from "../composition/shutdown.js";
import { startEvalOracleBridge } from "../composition/eval-oracle.js";
import type { Server } from "node:http";
import { loadDesktopEnvironmentConfig } from '../composition/desktop-environment-config.js';
import { loadWorkbenchAppConfig, nativeWorkbenchApps } from '../desktop-provider/workbench-apps.js';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const option = (name: string) => { const index = process.argv.indexOf(name); if (index < 0) return undefined;
  const value = process.argv[index + 1]; if (!value || value.startsWith('--')) throw Error('dashboard-option-value-required'); return value; };
const port = Number(option('--port') ?? process.env.DASHBOARD_PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('invalid-dashboard-port');
if (process.env.AGENT_DESKTOP_VM_ID && !process.env.AGENT_DESKTOP_TOKEN) {
  throw new Error("Agent Desktop 配置需要 Token");
}

// 集中装配：Root Context + 基础设施服务 + 任务控制器（失败自动回收已创建资源）。
const projectDir = process.cwd();
const appConfig = loadWorkbenchAppConfig(projectDir, option('--apps-config') ?? process.env.AGENT_DESKTOP_WORKBENCH_CONFIG);
// App-only startup has fresh state; never imports prior Task traces, confirmations or model keys.
const rootDir = appConfig ? resolve(projectDir, '.artifacts/workbench-apps/runtime') : projectDir;
if (appConfig) mkdirSync(rootDir, { recursive: true });
const workbenchApps = appConfig ? await nativeWorkbenchApps(appConfig, projectDir, resolve(rootDir, 'environment-apps.sqlite')) : undefined;
const assembly = await createRootAssembly({ rootDir,
  ...loadDesktopEnvironmentConfig(process.env.AGENT_DESKTOP_ENVIRONMENT_CONFIG),
  ...(workbenchApps ? { workbenchApps, model: { createModel() { throw Error('workbench-app-only-model-disabled'); } } } : {}) });
let server: Server | undefined;
try {
  const sessionId = process.env.AGENT_DESKTOP_SESSION_ID ?? "agent-desktop-default";
  const scope = process.env.AGENT_DESKTOP_VM_ID
    ? mountSessionScope({
        root: assembly.root,
        rootDir,
        sessionId,
        vmId: process.env.AGENT_DESKTOP_VM_ID,
        endpoint: process.env.AGENT_DESKTOP_WORKER_URL ?? assembly.desktop?.get(sessionId)?.workerEndpoint ?? "http://127.0.0.1:8765",
        token: process.env.AGENT_DESKTOP_TOKEN ?? "",
        controlBus: assembly.controlBus,
      })
    : undefined;
  // 等待 Session 作用域装载完成（disposer 注册）；失败则回收整个 Root 后退出。
  if (scope) await scope.fiber;

  server = createDashboardServer(rootDir, assembly.controller,
    assembly.desktop, assembly.vmControl, scope?.control, assembly.inspect);
  if (assembly.desktop) assembly.desktop.attach(server);
  // 独立 Oracle 旁路通道：仅在显式 EVAL 开关下装配（AGENT_DESKTOP_EVAL_ORACLE=1 或 --eval-oracle）。
  // 生产默认（npm run dashboard / 计划任务）不置开关：桥不加载、不存在；该通道从不进入 task model / HTTP API，Agent 不可见。
  const evalOracleEnabled = process.env.AGENT_DESKTOP_EVAL_ORACLE === "1"
    || process.argv.includes("--eval-oracle");
  const oracleBridge = evalOracleEnabled
    ? await startEvalOracleBridge(process.cwd(), process.env.AGENT_DESKTOP_VM_ID)
    : undefined;
  server.on('close', () => { void oracleBridge?.close().catch(error =>
    console.error('Oracle bridge close failed:', error)); });

  const shutdown = createShutdown(server, assembly);
  const requestShutdown = () => {
    void shutdown().catch((error) => {
      console.error("Dashboard 关闭失败：", error);
      process.exitCode = 1;
    }).finally(() => {
      process.off("SIGINT", requestShutdown);
      process.off("SIGTERM", requestShutdown);
    });
  };
  server.on("close", requestShutdown);
  server.on("error", (error) => {
    console.error("网页服务器启动失败：", error);
    process.exitCode = 1;
    requestShutdown();
  });
  process.on("SIGINT", requestShutdown);
  process.on("SIGTERM", requestShutdown);

  server.listen(port, "127.0.0.1", () => {
    console.log(`任务与执行记录页面：http://127.0.0.1:${port}`);
  });
} catch (error) {
  if (server) await createShutdown(server, assembly)();
  else await assembly.dispose();
  throw error;
}
