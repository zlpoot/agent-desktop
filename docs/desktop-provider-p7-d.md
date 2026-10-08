# P7-D：Task 驱动应用接入

日期：2026-10-08。范围：[#20](https://github.com/zlpoot/agent-desktop/issues/20)，Parent #16。基线：P7-C squash `d448e0df629ec73fd868ca17dd869917c35a4d30`。

状态：**实现候选 / Ready for independent review；未 ACCEPTED、未 merge。** 按 #20 Kickoff 交付 Task 集成、最小确认 UI/API、文档及合成 E2E，停止于 ChatGPT Independent Review Gate。没有关闭 #20 或启动 #21/P7-E。

## Task 接入与恢复边界

`TaskAppOnboarding` 从结构化 `desktopTarget` 获取同环境 P7-C 服务。名称使用零模型的保守规则：例如 `使用 AA音乐 搜索…`、`用QQ音乐播放…`、`在QQ音乐中搜索…`、`open "Synthetic App" …`；带空格的名称使用引号。名称不决定执行环境、命令或启动路径。其他任务语法保留既有规划路径，没有新增通用自然语言应用解析模型。

同环境 confirmed/verified 当前 profile 走 P7-C `reuse`，只有启动检查事件，不扫描、不重复确认、不另建 Task。未知应用在业务规划、Worker runtime 和 Agent `beginTask` 之前进入 `waiting_user`，专用 `interactionKind=app_onboarding`；普通 resume approval 不接受该等待。先冻结并检查原 Provider Session，不取得 Agent 输入权。接入只允许尚未观察/派发的准备阶段，已有 observation、业务窗口绑定、step、in-flight/verification pending 或 uncertainty 一律拒绝，不在在途 graph 中插入新的启动/重放通道。

SQLite Task state 与 graph checkpoint 增量保存 taskId、名称、desktopTarget、安装域、interactionId、状态、候选 ID/revision 与已选 appBindingId/profileRevision/profileDigest。运行 receipt、opaque targetToken 与 authority 不写入配置/HTTP，不把管理 reservation 当作 Task 输入授权。Task 原 goal、plan、Workflow 版本/hash/参数、重试与独立预算记录沿用原值；配置成功仅标记 app ready，不写 Task done、业务 PASS 或 Workflow 晋级。

确认后重新核验 Task 身份、Session、安装域和当前 profile，才将同一 taskId 放回原队列。Task 按原 InputControl 获取输入，连接原被冻结 Session 的新 Worker runtime，按已验证配置过滤唯一可见进程窗口。规划器不能替换窗口或触发另一次 legacy ensureApp；attach 后复核实际 process path/PID/class、窗口句柄、权限和新 observation，并沿用原 capability、风险、预算和结果验收。

Host 重启将所有应用接入 Task 标为 `new_task_required`，保留配置成果与原 uncertainty，但不复用原 Session、恢复旧业务动作或自动新建任务。配置成功而 Task Session 已失效时同样保留 Registry 验证并要求显式新 Task。P6 finite-scenario no-replay、Physical generic 拒绝、Local Workspace 的有限范围和 Native Physical 缺 dispatch fence 的新启动拒绝继续有效。

## 最小 UI/API

任务详情与待处理列表展示应用接入等待。卡片包含所选环境/安装域、名称、候选路径/参数/cwd、版本、发布者与来源；没有默认首项，唯一候选也要选择并确认。按钮包括确认并验证启动、不是这个应用、指定路径、重新扫描、安装后重扫及取消。指定路径只经所选环境的只读 discovery 检查，不执行客户端路径；安装由用户自行完成。未找到、扫描/环境不可用、拒绝、启动失败和新 Task 要求分别显示，支持移动端布局。应用文字通过 textContent 显示。

`POST /api/tasks/:taskId/app-onboarding` 只接受 interactionId、desktopTarget、action，以及该 action 所需的候选 ID/revision 或 path。保留本机同源与 JSON/body 限制，并要求 Origin 来识别本地页面操作员；operatorId 由服务器指定，客户端不能提交。没有暴露 P7-C 管理凭据、任意 launchSpec、shell、verified 或 revoke/管理端口。

每次操作核验持久 Task/interaction/目标；候选来自服务器保留的 P7-B 快照，确认继续使用 P7-C 摘要/CAS/安装检查。重复/并发 confirm 共用操作结果；重扫、拒绝、失败会更新 interaction；跨 Task/环境、旧 revision、晚到/取消后请求拒绝。取消在启动期间撤销原 managed operation；结果晚到不会恢复已停止 Task。服务和环境能力仍要求显式可信 composition 配置，默认应用管理端口为空；确认不能启用未经准入的执行器。

## 验证证据

只使用合成应用、FakeModel、Fake Worker/backend 和本地网页，未安装应用、连接第三方音乐服务、调用真实模型、VM 或实机输入。没有导入私有快照、凭据、数据库或浏览器用户状态，也没有升级依赖、修改 Workflow schema 或 Host/Guest 协议。

| 检查 | 结果 |
| --- | --- |
| `npm run check` | PASS |
| `npm run test:offline` | 666/666 PASS，0 fail/skip |
| `npm run test:python` | 15/15 contract files PASS，failed: [] |
| `npm run test:browser` | **54/55 PASS、1 FAIL** |
| 最终接入/恢复定向 | 25/25 PASS |
| 接入 Browser 与后端定向 | 11/11 PASS；最终重启提示/UI Browser 定向 1/1 PASS |

offline 初次 663/664，唯一新增失败是取消后拒绝错误码已收紧为 `app-onboarding-new-task-required`，原测试只匹配 expired。补充终态拒绝断言后重跑失败矩阵为 666/666；初次日志保留 `.validation/p7-d-offline-initial.log`。没有降低“取消后零恢复/零输入”的行为断言。

Browser 唯一失败仍为 `tests/workflow-library.test.ts:159` 的 `download.saveAs: canceled`。未修改的精确 kickoff 基线 `d448e0d` 独立运行同一用例也为 0/1、同一行同一错误。下载测试、workflow-view 和 workflow-library 文件无 diff；本期没有改下载代码/断言或跳过失败。完整日志为 `.validation/p7-d-browser.log`，对照为 `.validation/p7-d-baseline-download.log`；其余日志为 `.validation/p7-d-{offline,python,focused-final,recovery-final,ui-final}.log`。必要矩阵之后的配置/Task 绑定复核、候选展示/移动布局、重启提示增量分别由受影响的接入/恢复及 Browser 定向用例覆盖，没有重复无关全量矩阵。日志与生成资产不提交。

历史 **A5 safety FAIL / Windows PAUSED / overall INCOMPLETE** 不变，Browser 不全绿。本候选不代表 QQ音乐/AA音乐等真实业务能力已获准或完成验收，等待独立评审。
