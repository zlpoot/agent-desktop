import type { WindowInfo } from "../../runtime/desktop/desktop-runtime.js";
import type { AgentExtension, TaskProfile } from "../../contracts/extension.js";

/** 首轮导航只从已打开、唯一且可见的炉石游戏窗口开始。 */
export function mercenariesGameWindow(windows: readonly WindowInfo[]): WindowInfo {
  const found = windows.filter((window) => window.title === "炉石传说" &&
    window.windowClass === "UnityWndClass" && window.visible && !window.minimized);
  if (found.length !== 1) throw new Error(found.length
    ? "发现多个炉石传说游戏窗口，请只保留一个可见窗口后重试"
    : "请先打开《炉石传说》游戏窗口并保持可见，再提交佣兵之书导航任务");
  return found[0];
}

export function mercenariesNavigation(goal: string): boolean {
  return /炉石传说|炉石/.test(goal) && /佣兵之书/.test(goal) &&
    /进入|打开|游玩|前往|找到/.test(goal);
}

/** 可停在明确指定的页面；进入关卡仍须由用户指定关卡。 */
export function mercenariesTarget(goal: string): string | undefined {
  const ordinal = goal.match(/第\s*[一二三四五六七八九十百零\d]+\s*[章关]/);
  if (ordinal) return ordinal[0].replace(/\s+/g, "");
  const named = goal.match(/(?:关卡|章节)\s*[：:]\s*([^，。；;]{1,40})/);
  if (named?.[1]?.trim()) return named[1].trim();
  if (/(?:进入|打开|前往|找到).*佣兵之书\s*$/.test(goal)) return "佣兵之书";
  return undefined;
}

/** 《炉石传说》场景配置：导航与酒馆战棋战绩由扩展注册，核心不识别游戏名。 */
export function createHearthstoneExtension(): AgentExtension {
  const profiles: readonly TaskProfile[] = [
    {
      id: "hearthstone.mercenaries.navigation",
      matches: mercenariesNavigation,
      target(goal) {
        const target = mercenariesTarget(goal);
        if (!target) throw new Error("请指定要进入佣兵之书页面或具体关卡，例如“进入佣兵之书”或“佣兵之书第一关”");
        return target;
      },
      constraint: "只导航至指定页面或关卡；不执行战斗内操作、购买或游戏设置修改",
      allowedActions: ["click", "double_click", "keypress", "scroll", "wait", "screenshot", "ask_user", "done"],
      requireTargetedScroll: true,
      environment: "windows",
      selectWindows(windows) { return [mercenariesGameWindow(windows)]; },
    },
    {
      id: "hearthstone.battlegrounds.record",
      environment: "windows",
      matches: (goal) => /炉石传说/.test(goal) && /酒馆战棋/.test(goal) &&
        /(?:查看|查询|看)/.test(goal) && /(?:战绩|数据|统计)/.test(goal),
      completionCriteria: { pageTextIncludes: "完整数据", pageTextNumberLabels: ["四强玩家", "夺冠次数"] },
    },
  ];
  return { id: "hearthstone", name: "《炉石传说》", profiles };
}
