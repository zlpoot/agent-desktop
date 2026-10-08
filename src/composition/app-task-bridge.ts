import type { EnvironmentAppService } from '../contracts/environment-apps.js';
import type { TaskDesktopTarget } from '../contracts/task-desktop.js';
import { ControlledAppLauncher } from '../environment-apps/launcher.js';
import { UnavailableAppTaskBridge } from '../environment-apps/task-bridge.js';

/** Trusted composition only; never registered as an admitted DesktopTaskExecutor. */
export function createUnavailableAppTaskBridge(service: EnvironmentAppService) {
  if (!(service.launcher instanceof ControlledAppLauncher)) throw new Error('app-task-controlled-issuer-unavailable');
  return new UnavailableAppTaskBridge(service.launcher, service.registry);
}

/** Source-audited capability gaps, not live readiness or an executable permission. */
export function appTaskBridgeReadiness(target: TaskDesktopTarget) {
  const blockers: Record<string, string> = {
    physical: '本机环境尚未证明原启动窗口绑定和撤销应用许可后的动作拒绝；通用本机输入仍未验证。',
    'hyper-v': '虚拟机尚未接入原启动窗口到任务的绑定，也未证明撤销应用许可后停止新动作；不回退本机。',
    'local-workspace': '现有工作区只支持自有目标上的固定场景；尚不能把原启动窗口绑定到任务，也未证明撤销应用许可后停止新动作。',
  };
  return { state: 'unavailable' as const, reason: Object.hasOwn(blockers, target.providerId) ? blockers[target.providerId] : '该环境没有已验证的启动目标到任务桥接实现。',
    nativeTargetProof: 'not-proven' as const, registryEffectFence: 'unavailable' as const, liveAction: 'forbidden' as const };
}

export const appBridgeCandidatePreview = Object.freeze({
  environment: '本地隔离工作区（需已有可信配置）', application: '网易云音乐', applicationVersion: '3.1.40.205461',
  scenario: 'd0-netease-fixed-track-v1', mechanism: '已核对控件和窗口上的固定场景',
  actions: ['在已核对的搜索控件中搜索孙燕姿《我怀念的》', '核对匹配结果，再使用固定播放控件', '读取画面和控件信息供独立结果验证'],
  targetStatus: '实际工作区配置、安装版本和原目标实例尚未验证；预览不选择真实目标。',
  consent: '本页只展示拟议步骤，不派发动作。受控实测需先完成独立审查，再单独授权准确环境、版本、动作和时间窗口。',
});
