# LIVE-01：Hidden Workspace Chrome 单 Key 实际执行

Refs zlpoot/agent-desktop#47。基线为 main `2ca406c664352b7c7dd4047694e1281023fd8008`。
这是本次明确授权的狭窄 LIVE-01 路由；Dashboard 另提供只读固定场景，通用 Chrome Task / Workflow 尚未接通。
独立 Review 尚未完成，本记录不改变 Windows 实验 PAUSED、A5 safety FAIL 或项目整体未完成的状态。

## 实际结果（2026-10-09 10:00，Asia/Shanghai）

| 项目 | 结果 |
| --- | --- |
| Task | `00d6ce04-fe4b-4440-b27c-bd538cb66b81`，`done` / `SUCCESS` |
| 浏览器 | 安装的 GUI Chrome `154.0.8037.98`，新建自有 profile |
| 环境 | `windows-local-workspace` / `local-workspace:chrome` |
| Native 绑定 | Worker 线程桌面、Chrome PID、窗口、Session、Job 与 localhost CDP listener 归属通过 |
| 站点 | `http://192.168.2.3:8102/`，通过网页 UI |
| 配置 | 全部 9 个模型；max_output_tokens = 40000；保留网页默认 RPM = 60、days = 90 |
| 创建 | 唯一一次表单提交；网页显示完整新 Key；没有第二次创建或创建回放 |
| 本机文件 | Windows Known Folder Desktop 下 `AgentDesktop_8102_API_Key.txt`；UTF-8 完整值加换行，55 字节 |
| 验收 | 保存时与当前 GUI 值逐字节比较；现有独立文件完成门重新读取，存在性与内容哈希证据通过；Task goalVerification / acceptance = pass |
| 清理 | `ownedJobEmpty = true`，`desktopHandleClosed = true` |
| Workflow | `0d555df7-03ce-4347-8b49-0b6c5bd49a4e`，schema v2，candidate，15 个已执行且验证的步骤，未发布、未回放 |

执行轨迹为导航、接入权限 tab、打开 Key 表单、填写名称和 Token 上限、勾选 9 个模型、一次提交，共 15 个 UI action；第 16 次决策为完成。
驱动器是读取实时 DOM 的 `kind = rule`，没有调用真实或辅助模型，也没有使用 FakeRuntime、录制页面或站点 API。
CDP 仅控制经 Native 核对的自有 Hidden Chrome 页面；没有默认桌面的输入或 Physical Desktop 回退。

私有证据留在本机忽略目录 `.artifacts/live-01/<Task ID>/`：`task.sqlite`、`result.json`、`discovery.json`、`workflows.sqlite`、`workflow-candidate.json`、`executed-source.json`。
单次提交台账 `.artifacts/live-01/create-once.json` 已标为 `confirmed_saved`。
既有台账或桌面 TXT 会阻止再次运行创建；未知结果也必须先只读核对，不能重提表单。
这些数据库、浏览器状态和生成资产均不提交。Key 明文不进入本记录、控制台、Task trace、Workflow 或 GitHub。
本机审计检查了成功运行目录的 393 个文件与本 PR 的 10 个文件，Key 的 UTF-8 / UTF-16LE 明文匹配均为 0；桌面文件仍与完成验收哈希相符。审计只输出计数和布尔值。

## 最小接线与边界

- 复用 D0 的 `Api.desktop/job/launch`、Native guard、原进程句柄与 60 秒时限、3 秒租约。Hidden Worker 启动 Chrome，Host 不把默认线程误当作 Hidden Chrome。
- 新 `LocalWorkspaceChromeProvider` 使用既有 DesktopSession、ResourceInputControl 与 RuntimeAdapter；grant 的绑定、epoch、grantId、owner/client 均固定，Native ACK 重新读取当前完整 grant。
- `PlaywrightRuntime.attach` 复用现有 grounding / dispatch，实现对已绑定自有 page 的连接，不另起浏览器。观察及实际输入前检查 Native 身份；输入还需未消费的 2 秒内观察。
- 仅允许指定 origin 的请求和 LIVE-01 语义动作。表单设置与初始 RPM/days 不符、目标不唯一、登录字段或权限未知均阻断。每次提交先独占持久化 intent，再执行一次输入。
- 复用现有 Agent Loop、风险 interrupt、Task budget、SqliteTrace、文件完成门与 WorkflowStore。用户一次创建授权只消费对应的提交风险门；没有扩大其它审批、重试或预算。
- Collector 只输出固定安全词汇、结构、授权数值和布尔状态。完整 Key 从 GUI 读取后只进入私有本机文件 sink；`wx` 禁止覆盖；inspectFile 返回元数据和哈希，绝不返回正文。
- 核心 model-only Workflow 蒸馏条件保持不变。单独的 LIVE-01 candidate 构造器要求真实 Task 已完成、独立验收 pass、文件证据、每个成功执行步骤有验证、唯一非幂等创建提交。候选参数包括名称、Token 上限、站点和输出文件。

候选只能在可信且显式配置的 Hidden Chrome Runtime 中尝试执行；创建步骤需要下一次明确授权和独立风险门。
候选没有实现 Dashboard 的通用 Chrome Task / Workflow 路由，不能用 Host/Physical 或直接 API 替代，也没有用真实站点测试候选回放。
当前 CLI 是本次授权配置的执行入口，不承诺任意站点、任意模型组合或任意 Token 配置。

## 失败与审查后的修正

创建前的发现过程曾因默认线程不能取得 Hidden 桌面名称、实际导航 role 为 tab、旧 ACK 读取、psutil 方法差异、隐藏同名表单和心跳调度而阻断。
这些尝试没有创建提交；实际表单确认后用户指定全部模型 / 40000 / 其它默认，成功运行仅提交一次。
心跳修正使 Host 客户端续租不被尚未完成的 Native ping 抑制；两端租约和观察时限没有放宽。
本次没有开展多模式重构或 Hidden Desktop 底层隔离复测。

成功运行后的逐文件审查修正了能力范围的旧“仅发现”文字、失败结果的报告和 CLI 失败退出码。
如果提交后失败，现在明确报告已经提交或已经保存，禁止再次创建。
这些报告修正仅经合成回归验证，没有再次真实创建；私有 `executed-source.json` 保留成功执行时的源码哈希，没有改写为最终 PR 源码。
真实运行的最终文件完成门采用核心文件验收路径；自定义 GUI/文件比较 verifier 另有合成测试，不把它描述为真实完成门中已运行的回调。

## 回归验证（首次 CLI 交付）

测试仅用合成页面、合成 Key 和 Fake Native，不读取真实运行证据、桌面 Key 或 profile。
新增浏览器回归覆盖 Collector 脱敏、心跳、身份漂移、origin/新鲜观察边界、风险门等待、唯一提交、私有文件相等、候选不含秘密、修改文件验收失败和重复提交拒绝。
新增 Python 合成测试覆盖 Native 完整 grant、绑定漂移、只读检查不续租、过期租约和 endpoint 替换。

| 检查 | 结果 |
| --- | --- |
| `npm run check` | PASS |
| `npm run test:offline` | 749/749 PASS |
| `npm run test:python` | 18 个测试文件 PASS（含新增 Native 合成测试 3/3） |
| `npm run test:local-workspace` | 53/53 PASS |
| `npm run test:local-workspace:browser` | 1/1 PASS |
| 新增 Hidden Chrome 浏览器回归单独复核 | 4/4 PASS |
| `npm run test:browser` | 完整复核 69/71 PASS、2 项下载失败；新增 4/4 PASS，不能声明全绿 |

沙箱内初始回归因 localhost socket、临时文件原子替换和浏览器缓存重定向失败；重跑使用沙箱外的合成测试及现有测试 Chromium，未访问 8102 或运行真实桌面实验。
首次沙箱外 Browser 回归的新增合成任务未完成，单独复核 4/4 通过；没有放宽 3 秒租约、2 秒观察时限或输入安全门。
两项既有下载测试单独复核仍报取消：`desktop-selection-ui.test.ts:182` 的 `download.createReadStream: canceled`、`workflow-library.test.ts:159` 的 `download.saveAs: canceled`。
相关 Dashboard / Workflow 下载产品代码未修改，取消原因未确认；失败保留，不删除或跳过测试，不声称整套 Browser 回归通过。

PR 停在独立 Review，不自行合并或把候选晋升为已验证 Workflow。

## Dashboard 只读体验入口（操作者反馈后的最小接线）

默认 `npm run dashboard` 不加载 Chrome 配置，所以原先下拉只有浏览器与本机桌面。
显式设置 `AGENT_DESKTOP_ENVIRONMENT_CONFIG` 为 `config/desktop-environments.hidden-chrome.example.json` 后，标准 Root 注册真实的 `local-workspace:chrome` Provider，替换未配置的旧 Local Workspace 条目，仍保留 Hyper-V / Physical 原有准入。
配置必须是绝对 `chrome.exe` 路径；不能同时配置旧 fixture / NetEase 工作区，不默认猜测安装路径或自动启用。

```powershell
$env:AGENT_DESKTOP_ENVIRONMENT_CONFIG = (Resolve-Path config/desktop-environments.hidden-chrome.example.json).Path
npm run dashboard
```

刷新 Dashboard，在执行位置选择 **Hidden Workspace Chrome**，再显式选择 **只读打开 8102 接入权限页面（不创建 Key）**，点击执行。
唯一场景 `live-01-chrome-readonly-8102` 复用现有固定场景 Task、预算、DesktopExecutionAdmission、完整输入 grant、独立结果观察及清理链路，只允许导航到 8102 与点击接入权限 tab。
它没有创建配置、私有 Key sink、模型或通用 WorkerClient，也不打开 Key 表单，不读取桌面 TXT，不运行创建 Workflow；Runtime 还拒绝配置 Key / sink 与页面的非 GET/HEAD 请求。
网页独立事实只有 `siteConfirmed`、`accessVisible`、`keyCreationAdmitted` 等布尔值；输入仍经过原 Native guard 与单次 2 秒观察门。
原 Native Worker 的 `inspect` 方法仅返回当前窗口/监听器归属状态，不取得 grant、写控制、产生 ACK 或续租；每个实际输入仍重新执行原完整 Native grant ACK 检查。
受控页面的精确应用版本元数据在此桥未报告，Target 标为 `unreported`；不据此宣称其它 Chrome 版本已验证。

初始化、环境列表查询与选择场景不启动 Chrome 或模型；点击执行才启动自有 GUI Chrome。
完成或失败后回收 Job / Desktop；只有确认上一 Session 清理通过才允许显式新建另一个只读 Task。停止后的旧场景不 Resume 或自动回放。
通用 Task / Workflow 的 `executable` 保持 false，创建入口仍受原一次授权台账和 TXT 冲突保护。本次没有第二次创建 Key。

新增合成网页端到端测试覆盖下拉可见、无默认场景、选择前零启动/零 grant、只读 Task 真正走现有队列、无模型、无创建及清理。
测试 HTTP fixture 曾因缺少 UTF-8 charset 导致中文 tab 不可识别，修正合成响应编码后通过；没有改真实页面操作或安全时限。
初版只核对 Dashboard 环境元数据，随后操作者执行只读场景反馈 Native 错误；真实验证与修正见下文。
Dashboard 补丁的检查结果：check PASS；offline 750/750；Python 18 个文件通过（Native inspector 单元测试 4/4）；Local Workspace 53/53；Viewer 1/1；本功能 Browser 单独复核 6/6。
完整 Browser 为 70/73：两项既有下载取消仍复现，一项合成 Key 测试在风险门前 failed、单独复核通过；原因未确认，完整套件保持失败，不能宣称全绿。
本次 PR 的 17 个文件及 PR 描述再次比较 Key 明文，UTF-8 / UTF-16LE 匹配均为 0；原桌面 TXT 与首次真实任务的验收哈希仍一致。

## Dashboard 真实只读反馈与地址验收修正

操作者 Task `c3362719-902b-40d8-b48e-d43f823c7779` 在首次观察、场景发出后报 `Chrome native identity or grant unavailable`，状态 paused，清理完成；原失败记录与禁止自动重放保持。
旧代码要求页面 URL 精确等于根网址，但实际点击接入权限后为 `http://192.168.2.3:8102/#access`，因此独立验收持续 pending。
真实只读诊断确认 origin / 根路径 / 空 query / `#access`、可见 Key opener、未授权创建和资源清理；没有再次创建 Key。
原记录没有保留 Native 具体错误码，不能推断它是 ACK 超时、租约或身份漂移；新增仅输出固定 allowlist 协议错误码，任意错误文本仍不进入 Task。
验收改为精确匹配 `/#access`，并保留接入控件、只读限制和未创建等独立事实；根网址、其它 fragment 或额外 query 均不能通过。
没有增加 ACK timeout、续租权限、Native 预算或观察有效期。

修正后通过标准 Dashboard 固定 Task 入口执行真实 Hidden Chrome，只操作导航与接入权限 tab：Task `05d969e8-142f-40c9-a62e-9fe97f060ecf` 为 done，独立 verdict pass，`siteConfirmed=true`、`accessVisible=true`、`keyCreationAdmitted=false`；记录包含 cleanup_done 和 done，原 Key TXT 验收哈希保持一致。
人工体验交给操作者；新只读 Task 不自动回放旧任务或创建候选。
合成回归新增真实 fragment 行为、错误 fragment / query 拒绝，以及错误诊断脱敏。合成 about:blank Key 测试保留原网址，避免把夹具 fragment 当成被授权站点。

修正后的检查：check PASS；offline 750/750；Python 18 个文件 PASS；Local Workspace 53/53；Viewer 1/1；Hidden Chrome 单独及完整套件中的 8/8 PASS。
完整 Browser 为 73/75，两项既有下载仍 canceled（`download.createReadStream`、`download.saveAs`），原因未确认；不声明全绿。首次未设置项目测试浏览器缓存路径的运行已停止，使用现有 `.playwright-browsers` 配置复核，不安装或升级依赖。
再次将原 Key 与 LIVE-01 产物、本机验证记录 5160 个文件及 PR 17 个文件 / 描述比较，UTF-8 / UTF-16LE 明文匹配均为 0；桌面 TXT 哈希与原验收一致。上述产物和日志保持本机忽略文件，不提交。
