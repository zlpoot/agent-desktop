# UI-01 阶段 B：AppShell 与工作台候选

状态：`B_IMPLEMENTED_REVIEW_PENDING / v0.1_NOT_RELEASED`。本候选等待 ChatGPT 独立 Review，不代表 Owner 页面验收或四模式后台全部实现。

基线为 clean main `32370a8063009600357fe5c1060610c507877610`；设计依据是 [Draft PR #52 的 docs/ui-v01.md](https://github.com/zlpoot/agent-desktop/blob/bb20e1d907e57311eb6c503c8b97a3c5bca69c6c/docs/ui-v01.md)。实现对应 [Issue #49](https://github.com/zlpoot/agent-desktop/issues/49) 的 B 切片。

## 本阶段实现

- 新增只负责呈现与路由的 AppShell：工作台、任务、工作流、环境与应用、设置五区；环境/应用及提示词/插件为页内视图。兼容旧 Hash 和 Task 深链接，保留旧版布局入口。
- 工作台先输入目标，再查看模式、明确选择执行环境与支持计划。复用现有环境目录，不自动选择环境、应用或固定场景。手动应用绑定尚未接通，明确禁用；任务内应用发现与确认继续使用既有接口。
- 执行预览展示模式、环境、计划、文件/副作用说明、实际全局预算及单次覆盖；保存全局预算后重新读取预览。预览和模式切换不提交任务、不授予权限。
- 提交沿用原 Task/固定场景接口，成功后在工作台显示同一 Task ID 的现场与结果。提交处理中阻止并发 POST；响应丢失时保留草稿，显示结果未知及核对历史的提示，不自动重试。
- 共享任务现场、最近步骤及右侧上下文。区分已记录观察、历史截图、缺少画面和归属匹配的 Guest 实时流。Browser/Hidden Chrome 记录不绑定另一 Session 的 Guest 画面。
- 任务控制复用现有暂停、继续、审批、停止并清理；未声明的接管/停止/紧急停止明确禁用并解释。等待人工处理时保留审批入口。动作派发、独立验证、清理与人工验收分别展示，UNKNOWN 不自动重放。
- 导航与上下文可折叠；窄屏重排，原生 radio 键盘切换和 focus-visible 保留。轮询不改写任务目标、模式、环境和提示词草稿。

## 模式的真实范围

| 入口 | 本阶段状态 |
| --- | --- |
| 稳定 | 工作台未接通模式提交；明确禁用并提供既有工作流页入口。版本、参数、试运行与发布资格仍由原接口校验，无自主回退。 |
| 自主 | 沿用已有通用 Task 提交入口，只对目录允许的通用目标开放；页面允许提交不代表模型或当前 Session 已就绪，运行前仍由后台核对配置、能力、风险、预算和输入权。 |
| 学习 | 待启用，无专用执行适配；模式可查看，任务提交禁用。 |
| 优化 | 待实现，无优化执行适配；模式可查看，任务提交禁用。 |
| 固定规则计划 | 单独且明确选择的执行计划，使用原有限场景 API；不作为自主/学习/优化能力证明。 |

没有新增 Task/Workflow 状态库、REST 执行接口或模式字段，没有改变 Agent Loop、Host/Guest 协议、Provider Contract、Workflow schema、风险门、预算边界和 3 秒输入租约。

## 合成验证证据

回归使用合成数据；Task/原生部分采用 FakeModel/FakeRuntime/合成 Provider，真实 Chromium 访问本地测试页面与临时目录服务。本阶段没有导入真实 #48 数据库、截图、配置、浏览器状态或密钥；未访问 8102，未创建 Key，未启动新的实机任务。

- `desktop-selection-ui.test.ts` 在 390、601、668、700、900、1366、1440px，以及 598px 低高度，验证可信 click → submit → HTTP 202 → 持久化 Task ID、准确环境/场景、每次仅一个 POST 和一次合成动作。保留无效表单、过期场景、UNKNOWN 停止/清理与禁止 Resume 的断言。
- `ui-v01-workspace.test.ts` 覆盖五区和旧路由、无默认环境、三种未接通模式不能 POST、预算/只读预览、草稿恢复、键盘/折叠、提交位置 elementFromPoint、顶部无覆盖、各断点无横向溢出、Chrome 与 Guest 归属隔离，以及响应丢失不自动重发。
- 既有工作台、全局预算、应用接入、通用 Task 提交与 Workflow 回归继续使用真实 HTTP 接口和合成事实源；只调整必要的导航名称、明确环境选择与工作台落点。
- 本机生成 `.artifacts/ui-v01-stage-b/idle-*.png` 与 `recorded-{390,1440}.png` 供视觉复核。这些是合成 UI 截图，不是实机执行证据；截图、日志、SQLite 和生成资产不提交。

最终检查使用项目已有 Chromium 缓存（`PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers`），没有安装或升级依赖：

| 命令 | 结果 | 本机原始日志 |
| --- | --- | --- |
| `npm run check` | PASS，退出码 0 | `.ui-b-check-final.log` |
| `npm run test:offline` | 755/755 PASS，退出码 0 | `.ui-b-offline-final.log` |
| `npm run test:python` | 18 个契约文件 PASS，退出码 0 | `.ui-b-python-final.log` |
| `npm run test:browser` | 81/83 PASS、2 fail、0 skip，退出码 1；新增 B 用例及七宽度提交链均 PASS | `.ui-b-browser-final.log` |

浏览器专项亦通过：工作台归属回归、模式/草稿/键盘/布局/丢失响应、预算更新与应用接入。没有把合成 Task 完成作为真实业务完成或 Owner 验收。

最终输入归属文案不再从 Guest 活动任务外推其它 Provider 的输入权；七宽度提交链及工作台归属专项另行复核为 8/8 PASS（`.ui-b-binding-final.log`）。

两项下载取消在未经修改的精确基线 `32370a8` 源码快照中复现：`desktop-selection-ui.test.ts` 的 `download.createReadStream: canceled`、`workflow-library.test.ts` 的 `download.saveAs: canceled`。对照日志为本机 `.validation/ui-b-baseline-download.log`，对应既有 [#45](https://github.com/zlpoot/agent-desktop/issues/45)。原因未确定，不跳过、不削弱断言、不声明 Browser 全绿。

## 停点

本交付仅为 B 的独立 Draft PR；任务/Workflow 深度改版、环境/设置完整统一与 Owner 页面验收继续属于 C/D/E。没有合并、发布或进入 #51 实际回放。历史 `A5 safety FAIL / Windows PAUSED / overall INCOMPLETE` 保留；此次合成 UI 检查不改变实机结论。
