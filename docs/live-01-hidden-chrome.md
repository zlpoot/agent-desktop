# LIVE-01：Hidden Workspace Chrome 单 Key 实际执行

Refs zlpoot/agent-desktop#47。基线为 main `2ca406c664352b7c7dd4047694e1281023fd8008`。
这是本次明确授权的狭窄 LIVE-01 路由；通用 Dashboard Chrome 路由尚未接通。
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
候选没有实现默认 Dashboard 的通用 Chrome 路由，不能在现有默认路由中用 Host/Physical 或直接 API 替代，也没有用真实站点测试候选回放。
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

## 回归验证

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
