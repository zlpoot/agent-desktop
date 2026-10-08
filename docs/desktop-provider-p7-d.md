# P7-D：Task 驱动应用接入

日期：2026-10-08。范围：[#20](https://github.com/zlpoot/agent-desktop/issues/20)，Parent #16。基线：P7-C squash `d448e0df629ec73fd868ca17dd869917c35a4d30`。

状态：**PR #25 独立评审 CHANGES REQUESTED；修复候选待复核，未 ACCEPTED、未 merge。** 评审基于 `7a12fe195ed36cf6c00cd930d66c84926899ebbc`，本次只修复两项 P1、补充定向回归，并小范围保留 Graph 入口的 retryCount。停止于 ChatGPT Independent Review Gate，没有关闭 #20 或启动 #21/P7-E。

## Task 接入与恢复边界

`TaskAppOnboarding` 从结构化 `desktopTarget` 获取同环境 P7-C 服务。名称使用零模型的保守规则：例如 `使用 AA音乐 搜索…`、`用QQ音乐播放…`、`在QQ音乐中搜索…`、`open "Synthetic App" …`；带空格的名称使用引号。名称不决定执行环境、命令或启动路径。其他任务语法保留既有规划路径，没有新增通用自然语言应用解析模型。

同环境 confirmed/verified 当前 profile 走 P7-C `reuse`，只有启动检查事件，不扫描、不重复确认、不另建 Task。未知应用在业务规划、Worker runtime 和 Agent `beginTask` 之前进入 `waiting_user`，专用 `interactionKind=app_onboarding`；普通 resume approval 不接受该等待。先冻结并检查原 Provider Session，不取得 Agent 输入权。接入只允许尚未观察/派发的准备阶段，已有 observation、业务窗口绑定、step、in-flight/verification pending 或 uncertainty 一律拒绝，不在在途 graph 中插入新的启动/重放通道。

SQLite Task state 与 graph checkpoint 增量保存 taskId、名称、desktopTarget、安装域、interactionId、状态、候选 ID/revision 与已选 appBindingId/profileRevision/profileDigest。运行 receipt、opaque targetToken 与 authority 不写入配置/HTTP，不把管理 reservation 当作 Task 输入授权。Task 原 goal、plan、Workflow 版本/hash/参数、重试与独立预算记录沿用原值；配置成功仅标记 app ready，不写 Task done、业务 PASS 或 Workflow 晋级。

确认后重新核验 Task 身份、Session、安装域和当前 profile，才将同一 taskId 放回原队列。首次运行及后续人工回答/继续运行均读取原操作的私有启动 receipt，通过 composition-owned `DesktopTaskExecutor.connectAppRuntime` 将其与原冻结 Provider Session 的 Worker 可信关联。桥接器必须在启动签发者的私有记录中解析 targetToken，验证安装内容、argv/cwd、进程创建及窗口生命周期、Windows session/desktop，再返回已经绑定且每个操作都重新验证目标的 Worker；产生效果时必须原子地检查目标身份。P7-C reservation ID 与 Provider Session ID 不是同一种身份，不能用字符串相等冒充关联。

桥接在 Agent `beginTask` 和模型创建之前完成；仍需既有 InputControl 才能执行业务。路径/PID/class/HWND 检查只是附加一致性检查，不再被用作启动目标身份的证明。Task 不对已绑定 Worker 再做语义/路径/HWND attach，不允许用另一个进程替换失效实例；后续 Graph 的观察、ground、focus 和 execute 必须持续受同一目标约束。规划器不能替换窗口或触发 legacy ensureApp，原 capability、风险、预算和结果验收保留。

**当前 native/真实执行器没有该可信桥接实现。** 没有桥接或不能证明目标时 fail closed，不调用普通 connectRuntime、不取得 Agent 输入、不调用业务模型；保存的验证配置可以保留，但不能声明真实业务可运行。本次只以合成私有目标记录和每次操作/派发 fence 证明集成行为，没有更改 Host/Guest 协议或补做 Windows 实验。

Host 重启将所有应用接入 Task 标为 `new_task_required`，保留配置成果与原 uncertainty，但不复用原 Session、恢复旧业务动作或自动新建任务。配置成功而 Task Session 已失效时同样保留 Registry 验证并要求显式新 Task。P6 finite-scenario no-replay、Physical generic 拒绝、Local Workspace 的有限范围和 Native Physical 缺 dispatch fence 的新启动拒绝继续有效。

`new_task_required` 是旧 Task 的终态。即使环境恢复、Session 重新变为 open，也拒绝 confirm/reject/rescan/path/cancel；不修改 interaction、不扫描、不启动、不恢复 Task。异步 scan 的返回不能覆盖新终态；UI 同时禁用所有接入按钮及候选/路径控件。必须显式创建新 Task 才能重新接入。

## 最小 UI/API

任务详情与待处理列表展示应用接入等待。卡片包含所选环境/安装域、名称、候选路径/参数/cwd、版本、发布者与来源；没有默认首项，唯一候选也要选择并确认。按钮包括确认并验证启动、不是这个应用、指定路径、重新扫描、安装后重扫及取消。指定路径只经所选环境的只读 discovery 检查，不执行客户端路径；安装由用户自行完成。未找到、扫描/环境不可用、拒绝、启动失败和新 Task 要求分别显示，支持移动端布局。应用文字通过 textContent 显示。

`POST /api/tasks/:taskId/app-onboarding` 只接受 interactionId、desktopTarget、action，以及该 action 所需的候选 ID/revision 或 path。保留本机同源与 JSON/body 限制，并要求 Origin 来识别本地页面操作员；operatorId 由服务器指定，客户端不能提交。没有暴露 P7-C 管理凭据、任意 launchSpec、shell、verified 或 revoke/管理端口。

每次操作核验持久 Task/interaction/目标；候选来自服务器保留的 P7-B 快照，确认继续使用 P7-C 摘要/CAS/安装检查。重复/并发 confirm 共用操作结果；重扫、拒绝、失败会更新 interaction；跨 Task/环境、旧 revision、晚到/取消后请求拒绝。取消在启动期间撤销原 managed operation；结果晚到不会恢复已停止 Task。服务和环境能力仍要求显式可信 composition 配置，默认应用管理端口为空；确认不能启用未经准入的执行器。

## 验证证据

只使用合成应用、FakeModel、Fake Worker/backend 和本地网页，未安装应用、连接第三方音乐服务、调用真实模型、VM 或实机输入。没有导入私有快照、凭据、数据库或浏览器用户状态，也没有升级依赖、修改 Workflow schema 或 Host/Guest 协议。

| 检查 | 结果 |
| --- | --- |
| `npm run check` | PASS |
| `npm run test:offline` | 本次修复 672/672 PASS，0 fail/skip |
| `npm run test:python` | 15/15 contract files PASS，failed: [] |
| `npm run test:browser` | **54/55 PASS、1 FAIL** |
| 本次 Review 修复定向 | 后端与 Browser 共 17/17 PASS，0 fail/skip |

本次新增回归覆盖验证 A 被同路径且 PID/HWND 相同的 B 替换、窗口生命周期/安装内容/argv/cwd/desktop 变化、缺少桥接、连接后替换、派发 fence 前替换、原业务 Task 回答续跑、环境恢复后五类 API 操作仍被终态拒绝、晚到扫描结果不能覆盖终态、所有 UI 接入控件禁用，以及真实 Graph 第一条 observe 保留已保存 retryCount。桥接反例断言零业务效果/零普通 runtime fallback；不能关联的初始接入还断言零 Agent lease/模型调用。

初次 PR 交付的 offline 初次 663/664，唯一新增失败是取消后拒绝错误码已收紧为 `app-onboarding-new-task-required`，原测试只匹配 expired。补充终态拒绝断言后重跑失败矩阵为 666/666；初次日志保留 `.validation/p7-d-offline-initial.log`。没有降低“取消后零恢复/零输入”的行为断言。

Browser 唯一失败仍为 `tests/workflow-library.test.ts:159` 的 `download.saveAs: canceled`。初次交付时，未修改的精确 kickoff 基线 `d448e0d` 独立运行同一用例也为 0/1、同一行同一错误，该对照保留于 `.validation/p7-d-baseline-download.log`。下载测试、workflow-view 和 workflow-library 文件无 diff；本次没有改下载代码/断言、跳过失败或重复无关独立审查。

本次最终日志为 `.validation/p7-d-review-{focused,offline,python,browser}.log`。Browser 使用主目录现有 `.playwright-browsers` 中的测试二进制和测试生成的独立临时 profile；没有复制用户浏览器状态或下载新浏览器。原交付日志继续保留，日志与生成资产不提交。

历史 **A5 safety FAIL / Windows PAUSED / overall INCOMPLETE** 不变，Browser 不全绿。本候选不代表 QQ音乐/AA音乐等真实业务能力已获准或完成验收，等待独立评审。
