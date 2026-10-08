# MVP-01：固定场景 Task 使用闭环

基线：`main@d72f2f141b8e7ee28d71243ea26187aa42cb9702`。对应 Issue #38。

| 主链路 | 已有能力，本轮复用 | 本轮补齐 / 限制 |
| --- | --- | --- |
| Dashboard → 选择 | P6-C 环境与固定场景 catalog；显式选择与专用 POST | 可直接运行的合成 Dashboard；环境和场景均不自动选中 |
| Task → 执行 | P6-B 持久 Task/Session、队列、预算、能力/目标/租约预检、单次执行 | 合成后端从既有测试提取共享；不写新执行框架 |
| 验证 → 结果 | D0 有限场景前后状态与截图验证；UNKNOWN 不重放 | 保存标准 observe/verify 事件；显示验证事实、阶段历史与清理状态 |
| 停止 → 清理 | 安全边界检查、撤销许可、结束所属资源；禁止旧 Task 重放 | “停止并清理”按钮；不显示场景不支持的继续/接管提示 |
| 失败记录 | 持久 SQLite 错误与恢复阻断 | 下载带操作者备注的 JSON 问题记录；保留 BLOCKED/UNKNOWN/NOTRUN/FAIL |
| 明确禁止 | 无授权真实输入、应用启动/模型/VM 调用 | 合成入口只允许固定场景提交与停止；B4/B5、真实 D0/网易云验收不在本轮 |

## 五步使用（合成，无真实桌面输入）

前提：已有项目依赖、Node.js 支持 `node:sqlite`。在项目工作分支目录使用终端；不需要密钥、Python、VM 或真实应用。端口占用时，PowerShell 可先设置 `$env:DASHBOARD_PORT=4174`。

1. 运行 `npm run dashboard:fixture`，在浏览器打开终端显示的本机地址（默认 `http://127.0.0.1:4173`）。页面注明“合成体验”和 `NOT HUMAN VERIFIED`。
2. 在“工作台”的“执行位置”明确选择 `windows-local-workspace / local-workspace:fixture`，再选固定场景 `d0-fixture-text-click-v1`。未选择、不可用、不支持或尚未验证的场景不能执行；自由文本不参与固定场景。
3. 点击“发送任务”。Task 进入生产持久队列，详情页展示预检、执行一次、独立验证、清理、完成的历史。正常结果为执行/验证/清理 `PASS`，事实包含 `text_length: 26`、`clicks: 1`、`human_actions: 0`，模型调用为 0。合成截图沿用测试中的占位 PNG；它证明证据管道，不能证明真实桌面效果。
4. 尚未结束的 Task 可点击“停止并清理”，等待当前调用返回并完成清理。执行前停止显示 `NOTRUN`；发出后未验证显示 `UNKNOWN`，不重放。清理失败显示 `FAIL`，保持阻断。固定场景没有 Dashboard Take Control/Resume；新建草稿仍需人工明确提交。合成成功很快，可能已经结束，此时没有停止按钮。
5. 在固定场景结果下填写反馈，点击“下载问题记录”，保留 Task ID、环境/场景、错误、各阶段与清理证据。退出用终端 `Ctrl+C`，等待关闭；记录保留在该检出的 `.artifacts/mvp-fixture/`，重启可查看。问题记录可人工附到 Issue #38，不自动上传。

## 结果解释与验收边界

验证 `PASS` 只来自固定场景独立读取的后状态，不来自 execute ACK。Task 只有验证和所属资源清理均确认后才完成；验证通过但清理失败仍为失败。未取得 Session 的清理结果不冒充 PASS；异常退出后的旧绑定或未记录清理保持 UNKNOWN。暂停状态沿用原持久契约，页面对固定场景解释为停止。

`dashboard:fixture` 使用隔离数据目录、现有 `ScenarioWorkspace` 合成后端和生产 Task/Provider/准入链路；没有真实 D0 worker、模型或通用执行入口。普通 `npm run dashboard` 的配置和权限边界保留；不要把普通入口的 `{ app: "fixture" }` 配置误认为这个无 OS 输入的合成入口，它会使用原 Windows D0 后端，需要另次明确授权。

代码层合成通过不等于 Windows 实机/用户层通过。状态保持 **NOT HUMAN VERIFIED / A5 safety FAIL / Windows PAUSED / overall INCOMPLETE**。真实桌面输入、应用启动、模型、VM、网易云安装版本均 **NOTRUN**；本 PR 不完成 #30，不关闭 #29/#27/#16，也不自行 Merge。
