# v0.2-C 日常任务闭环（#62）

开发基线：main@4dfaed4be22d2dd70b5b14c38acb018664f39db0。C 只核对现有任务链、补合成证据和一个历史回读 P1；D 的 Owner LIVE UAT / 发布另行授权。

## 现有链路与用户可见事实

| 路径 / 状态 | 已有实现与用户所见 | 实际断点或验证结论 |
| --- | --- | --- |
| 模型设置 | `/api/settings/model` 保存本机配置，来源与覆盖分别显示，Key 不回显；Browser 新任务读取当次有效配置 | 配置完整 ≠ 连接 PASS。测试通过真实设置表单写入临时目录里的合成值，Controller 注入 FakeModel，无模型网络请求 |
| 环境 / 模式 | Browser 自主通用任务；Local Workspace / Hidden Chrome 只走已声明有限场景；稳定模式经已有工作流入口，学习 / 优化尚未接通 | 未发现不推断离线；读取失败 UNKNOWN；Physical 通用能力未证；目录 supported / executable 不证明执行完成。完整支持矩阵见 [B 入口说明](v02-b-environment-entry.md) |
| 普通 Browser | `task-experience.js → app.js → POST /api/tasks → DesktopTaskController → Agent Loop → SqliteTrace`；明确 `destination=browser` | 合成目标“打开合成结果页”，FakeRuntime 导航到 localhost 身份的假页面；独立完成条件 `urlIncludes=/synthetic-result` 在动作后通过。UI 显示一次执行回执、自动验收 PASS；清理持久记录仍 UNKNOWN，人工未验收 |
| 固定有限场景 | `POST /api/desktop/scenarios/tasks → production queue / provider / input gates → ScenarioWorkspace → Trace`；`d0-fixture-text-click-v1` | `dashboard:fixture` 的真实装配完成 D0：独立观察 text_length=26、clicks=1，执行 / 验证 / 清理 PASS。不是任意文字任务，也不是 Windows 实验通过 |
| 失败 / 人工 / 不确定 | Browser 规划失败为 failed；FakeModel 的 ask_user 为 waiting_user；有限场景不确定派发为 paused / execution UNKNOWN / verification UNKNOWN | 刷新和 Host 重建保持其事实；无自动再次执行。有限场景重启追加既有 host_restart 事件，不抹去历史；清理 PASS 不代表目标完成 |
| 提交回执 UNKNOWN | HTTP 请求已处理但响应丢失时，UI 提示先核对任务记录，保留草稿，不自动重试 | 故障注入让真正 Controller 接收一次任务后丢弃响应；历史读回同一 failed Task；POST 次数保持一次，失败规划无 Runtime / 输入 |
| 已知 Task 的历史回读 | `/api/runs` 列表与 `/api/runs/{source}/{taskId}` 详情都已有 | **P1 复现**：打开已知历史链接并刷新，仅让列表 GET 返回 503，真实详情 GET 仍 200；旧 UI 无法显示 Task。修复前闭环测试 1/2，通过有限场景、失败在 Browser 历史回读。修复后历史按已知身份直接读详情；详情失败显示可重试，不宣称记录已删除；重试不派发任务 |
| Guest 画面 / 准备帮助 | workbench 按当前活动 Guest Task 绑定画面；`/environment-help` 固定读取 B 文档 | Browser / 有限场景不复用旧 Guest 帧。保留原有“工作台等待列表追上回执”语义与旧断言。帮助入口在 localhost 未复现缺失，不改其分发 |

仅修改 `app.js` 的历史读取路径与反馈：列表读取失败时按已知身份独立读详情，继续校验异步选择和返回身份；详情读取失败可独立重试。列表成功但缺少指定 Task，或详情确认 404，保留既有“找不到指定任务记录”空态；503 等故障不宣称记录已删除。Task 状态、API、核心契约、Host/Guest 协议、Workflow schema、规划/执行/安全/预算/输入策略不变。通用 Browser 的清理持久证据缺口保留 UNKNOWN，执行器扩展留在 #51 / 后续 Issue。

## Windows 普通用户手顺（6 步）

1. 合成体验在仓库 PowerShell 运行 `npm run dashboard:fixture`，打开它输出的 localhost 地址；此模式仅有限合成场景，无真实模型/应用/VM。普通 Browser 的完整合成回归由 `tests/task-closure-ui.test.ts` 注入 FakeModel / FakeRuntime 运行；真实 Browser 或桌面输入需要 Owner 另行明确授权与配置。
2. 普通 Browser 经“设置”保存地址、模型名称和 Key，查看生效来源与环境覆盖；Key 输入会清空。配置完整只表示配置已备齐。合成固定场景不需要模型。这里不创建真实 Key 或测试连接。
3. 回“工作台”，明确选择环境，核对准备状态；Browser 使用自主模式，有限环境再明确选一个 supported 固定场景。未配置 / 目录 UNKNOWN / 离线 / 不支持 / 未证分别处理；旧或一次性场景失效必须重选，不由目标文字回退。
4. 核对目标与完成条件，只点击一次“发送任务”，记下 Task ID。排队、正在运行、等待人工、暂停、失败均为过程或状态；202 仅表示接收。回执 UNKNOWN 时先到“任务”按目标、ID、环境核对，不再次发送。需要人工时只使用该 Task 提供的入口；有限场景停止后不支持 Resume / 接管。
5. 打开任务结果，分别读“实际执行 / 自动完成验收 / 清理与遗留 / 人工核对记录”，再看逐步证据与时间。未执行用 NOTRUN，缺证据用 UNKNOWN，验收未通过不能由 done、模型自述或清理 PASS 补成通过。
6. 刷新页面；停止并重启同一 Dashboard（相同根目录与启动配置），从“任务”选择同一 ID，或打开其历史链接。列表读取失败时已知链接仍可独立读详情；详情失败用“重试读取任务”。重启后的有限场景仍按原结果核对，不自动重放；明确重试须显式新建任务并重新核对准入。

## 可复查合成证据与交付停点

新增 `tests/task-closure-ui.test.ts`：真实 UI / HTTP / Controller / Trace / history，受控 Chromium 仅用于 localhost UI。Browser 的生产 launch 在测试作用域内替换为 FakeRuntime，不调用真实模型或原生桌面；有限成功用 `createFixtureDashboard`，不确定派发用生产 Root + ScenarioWorkspace。全部模型配置、数据库、Task、观察均在新临时目录生成，退出删除；只保存合成摘要到忽略的 `.artifacts/issue-62/`。

- `closure-before-fix.log`：修复前 1/2；Browser 历史列表 503 / 详情 200 后刷新回读超时，有限场景通过。
- `closure-after-final.log`：定向闭环与现有环境 / 工作台回归结果；旧测试断言未放宽。
- `final-ui.log`：最终 5 个相关文件，另覆盖列表 503 下详情确认 404 与读取 503 的区别。全套曾暴露两个“指定 Task 不存在”空态回归，已收窄到列表失败回读并保留 404 空态；全套原始失败不覆盖为通过。
- `browser-loop.json`、`finite-loop.json`：当次 Task ID、身份、开始 / 末次事件时间、节点、执行 / 独立验证 / 清理事实、人工未验收和 LIVE NOT RUN。记录的 end 是最后持久事件时间；等待 / 暂停 Task 仍未完成。
- `check.log`、`offline.log`、`python.log`、`browser.log`：本次常规检查原始记录，最终结果列于 Draft PR。旧 #45 的下载测试若取消，明确保留失败项，不改旧断言或声称全套绿色。

本次 check 通过，offline 761/761，Python 18 文件 / 179 项通过。完整 Browser 在空态修正前为 95/99：两个缺项空态回归已由最终 `final-ui.log` 的 13/13 定向检查覆盖；另两个旧下载取消分别是 `desktop-selection-ui.test.ts` 的 createReadStream canceled 与 `workflow-library.test.ts` 的 saveAs canceled，保持原始失败记录，未重跑全套。后续修正仅涉及 UI 读取 / 空态，最终 UI 与类型检查已覆盖，后端 / Python 契约未变。

Owner D 阶段待办：另行授权真实模型和目标后，核对真实 Browser 业务目标与独立证据、资源清理 / 遗留、人工验收、重启回读与实际操作可达性。合成 PASS ≠ Owner LIVE UAT；普通 Browser cleanup UNKNOWN 未被此修复补成 PASS。

交付独立 Draft PR，等待 ChatGPT 独立 Review Gate；不 Ready、不合并、不关闭 #62、不进入 D、不 tag/release。#51 保持 DEFERRED_AFTER_V0.2；A5 safety FAIL / Windows PAUSED / overall INCOMPLETE 保持。
