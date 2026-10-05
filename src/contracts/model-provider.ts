import type { ModelAdapter, TokenUsage } from "../agent/model-adapter.js";
import type { PlannedTask } from "../agent/task-planner.js";
import type { RegisteredApp } from "../runtime/desktop/app-catalog.js";
import type { WindowInfo } from "../runtime/desktop/desktop-runtime.js";
import type { CompletionCriteria } from "../verifier/verifier.js";

/** 通用任务规划与决策模型：在 ModelAdapter 之上增加任务规划与视觉观察能力。 */
export interface PlanningModel extends ModelAdapter {
  planTask(goal: string, windows?: readonly WindowInfo[], apps?: readonly RegisteredApp[],
    criteriaOverride?: CompletionCriteria): Promise<{ task: PlannedTask; usage?: TokenUsage }>;
  /** 截图文字识别（桌面视觉观察）。 */
  transcribeScreenshot(path: string): Promise<{ text: string; usage?: TokenUsage }>;
  /** 截图内目标定位（视觉接地）。 */
  locateVisualTarget(path: string, description: string): Promise<{
    x: number; y: number; confidence: number; usage?: TokenUsage }>;
  takeVisualUsage(): TokenUsage | undefined;
}

/** 模型提供方：配置与具体提供方分离，核心只依赖此接口。 */
export interface ModelProvider {
  /** 创建通用任务使用的规划/决策模型；环境参数只在创建时决定提示词与视觉模式。 */
  createModel(options?: { environment?: "browser" | "desktop"; visualMode?: boolean }): PlanningModel;
}
