/**
 * EVAL-only 装配：独立 Oracle 旁路通道。
 *
 * 生产启动（`npm run dashboard` / 计划任务）绝不加载 testbench Oracle 桥：
 * 对 `testbench/oracle-bridge` 的引用是函数体内的**动态 import**，仅在显式 EVAL 开关下才求值，
 * 因此生产进程的模块图里不含该桥，启动入口 `src/app/start.ts` 也不携带其字面路径。
 *
 * 本文件位于装配层 src/composition（与组装扩展的 root.ts 同层），不在 kernel-independence
 * 核心扫描目录内；核心与启动入口始终看不到这一通道。
 *
 * 该通道只读写 `.artifacts` 下的文件队列，从不进入 task model / HTTP API，Agent 不可见；
 * 它的结论也绝不回灌自动判定，仅供独立交叉核对。
 */
export async function startEvalOracleBridge(
  rootDir: string,
  vmId: string | undefined,
): Promise<{ close(): Promise<void> } | undefined> {
  const module = await import("../../testbench/oracle-bridge.js");
  return module.startOracleBridge(rootDir, vmId);
}
