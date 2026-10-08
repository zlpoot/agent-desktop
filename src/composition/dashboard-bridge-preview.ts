import { createDashboardPreflight } from './dashboard-preflight.js';
import { appTaskBridgeReadiness, appBridgeCandidatePreview } from './app-task-bridge.js';

/** Informational B preview. Reuses A1's inert providers/routes; no identity helper or collector. */
export async function createDashboardBridgePreview(configPath: string, rootDir: string,
  synthetic?: Parameters<typeof createDashboardPreflight>[2]) {
  const assembly = await createDashboardPreflight(configPath, rootDir, synthetic);
  const manage = assembly.controller.manageApps!;
  return { ...assembly, view: { ...assembly.view, bridgePreview: appBridgeCandidatePreview },
    controller: { ...assembly.controller, async manageApps(body: Record<string, unknown>) {
      const result = await manage(body);
      if (body.action === 'close' || body.action === 'cancel') return result;
      const view = result as { desktopTarget: { providerId: string; environmentId: string }; preflight: object };
      return { ...view, preflight: { ...view.preflight, taskBridge: appTaskBridgeReadiness(view.desktopTarget),
        discoveryReason: '本页仅展示桥接状态与拟议测试步骤，不接入安装扫描；已有发现结果不授予启动或任务许可。',
        launchReason: '本页未接入启动适配器，也未授权启动、任务、模型、输入或虚拟机控制。' } };
    } } };
}
