# 合成测试台

`browser-fixture` 和 `todo-server.mjs` 是本地浏览器测试页面，输入都是人工编写的合成数据。TypeScript 浏览器回归负责创建自己的本地服务，无需先启动测试台。

Windows C# 测试台保留 `build.ps1` / `run.ps1` / `verify.ps1` / `start-guest.ps1`。这些是显式现场入口，可能启动应用或 VM，本轮未执行。`oracle-bridge.ts` 是独立 EVAL 旁路，不向 Agent 暴露标签。

`verification` 的场景/字段契约为合成夹具；历史 P7 快照、真实 RPC、截图和 watcher 留在私有工程。`p4` / `p5` harness 用于另行授权的 VM 恢复测试；不会随离线入口运行。
