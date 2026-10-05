import type { WindowInfo } from "../../runtime/desktop/desktop-runtime.js";
import type { AgentExtension, TaskProfile } from "../../contracts/extension.js";

/** Windows Agent TestBench 场景配置：测试场景允许保留具体业务，生产 Kernel 不依赖它。 */
export function createTestbenchExtension(): AgentExtension {
  const profiles: readonly TaskProfile[] = [
    {
      id: "windows-agent-testbench-shopping",
      matches: (goal) => /(?:Windows Agent TestBench|拾光商城)/.test(goal) && /(?:模拟商城|拾光商城|购物 TestBench)/.test(goal),
      environment: "windows",
      selectWindows(windows) {
        const matches = windows.filter((window) => window.title.includes("Windows Agent TestBench - 模拟商城"));
        if (matches.length !== 1) {
          throw new Error(`模拟商城窗口匹配数量为 ${matches.length}，请确保测试窗口已打开且唯一`);
        }
        return matches;
      },
    },
    {
      id: "windows-agent-testbench",
      matches: (goal) => /Windows Agent TestBench/.test(goal),
      environment: "windows",
      selectWindows(windows) {
        const matches = windows.filter((window) =>
          window.title.includes("Windows Agent TestBench - 仓库与订单管理"));
        if (matches.length !== 1) {
          throw new Error(`TestBench 窗口匹配数量为 ${matches.length}，请确保测试窗口已打开且唯一`);
        }
        return matches;
      },
    },
  ];
  return { id: "windows-agent-testbench", name: "Windows Agent TestBench", profiles };
}
