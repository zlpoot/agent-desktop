# UI-01 阶段 C：Runs + Workflow 候选

状态：`C_IMPLEMENTED_REVIEW_PENDING / v0.1_NOT_RELEASED`。本候选等待 ChatGPT 独立 Review，不代表 C 已验收、Owner UAT 或真实业务回放通过。

基线为 clean main `58b7a7d5f26a8ee30fafd595778e9919e8211655`；依据 [#49 阶段 C 最新执行说明](https://github.com/zlpoot/agent-desktop/issues/49#issuecomment-6076501505) 和仓库 `docs/ui-v01.md` 的 4.3、4.4、5、7、9 节。工作分支为 `codex/issue-49-phase-c`；exact head 在对应 Draft PR 交付记录中列明。

## 页面实现与事实来源

- 任务列表支持目标、Task ID、来源搜索，进行中/待处理与终态记录筛选，以及独立状态筛选；每条记录显示完整 ID 和来源。详情继续使用完整 `source/taskId`，保留旧 Hash、深链接、刷新及 B 的成功提交优先选择。
- 同一 Task 详情按目标、实际过程、结果及核对组织。步骤证据继续展示观察文本及来源、决策/定位、节点耗时；动作回执与独立验证分别呈现。缺少验证不能因动作成功显示“已验证”，缺少文本、步骤和截图均明确说明。
- 结果面板分别展示执行/副作用、自动完成验收、可靠清理/遗留状态和人工核对；另外呈现 `acceptanceReport`。自动结论优先读取 `outcome.autoVerification`，兼容 `goalVerification`。Task `done`、人工确认、清理 PASS 不推导自动 PASS。没有可靠清理字段时为 UNKNOWN。
- `waiting_user`、`paused` 保留原后端控制资格；`blocked`、`unknown` 展示错误与禁止自动重放非幂等动作的提示。通用接管、停止、紧急停止仍禁用。旧 Guest 与 Browser 的画面及控制归属规则未扩大。
- Workflow 详情分为定义与参数、版本资格与回放记录，突出固定版本、用途、来源 Task、环境、阶段/整任务、步骤、前后条件、参数类型/绑定、已知失败与回放计数。文件结果契约仅作声明展示，不作已生成证明。
- 预览仍调用现有 `POST .../preview`：校验只读响应及固定版本身份，阻止并发预览，参数或版本变化使旧预览失效，迟到响应不能重新启用执行。错误和加载均真实显示；旧库无回放表与没有回放记录分别说明。
- 候选、已验证、停用分别展示。已支持的受限整任务接口仍须先预览并由后台核对环境、前置条件、风险和授权。停用、阶段、未接通环境、未接通参数类型显示禁用操作与原因。
- `owned-chrome-cdp` 与现有后台拒绝条件一致：Hidden Chrome 创建候选显示“未回放 / 不允许通用回放 / 未晋升”，试运行与页面发布禁用。预览不继承任何创建授权。
- 390、700、900、1366、1440px 检查任务与 Workflow 页面无横向溢出；窄屏优先显示版本限制与操作资格，结果四项事实重排为单列。

没有改 Agent Loop、Provider、Guest/Host、Hidden Desktop、风险门、预算或 3 秒输入租约；没有修改 Task/Workflow 执行接口、持久 schema、存储或依赖。首次候选生产变更仅限六个既有前端文件；下述限定修复另外在只读 Run 投影中添加可选来源字段。

## 独立 Review 唯一 P1 的限定修复

[Review 5467638259](https://github.com/zlpoot/agent-desktop/pull/54#pullrequestreview-5467638259) 对 `925672e` 的结论为 `REQUEST_CHANGES_SCOPED`（原生 GitHub 状态为 COMMENTED）。[唯一 P1](https://github.com/zlpoot/agent-desktop/pull/54#discussion_r4228149697) 指出 `ground` 失败直接进入 `recover`，没有 `execute`，但页面把共享 `step.result` 当作失败动作回执。本次只修复这项来源归属，等待新 HEAD 的独立限定复审。

- `server.ts` 的既有只读 Run 投影从 trace 节点增加可选 `resultOrigin='ground'|'execute'`；不新增持久字段，不改 Graph、Task/Workflow Store/schema 或执行路由。
- 汇总只统计有明确 execute 来源的回执；ground 失败显示“定位失败 / 未派发”，不计入成功或失败动作次数。步骤卡、详情、流程图、时间线与记录观察共用同一来源判定。缺少来源时降级 UNKNOWN，不凭 `result.ok` 声称派发。
- 新增一条合成 Browser 回归：生产 HTTP 路由读取 `observe→decide→ground(ok=false)→recover`，核对数据库中完全没有 execute；逐个核对汇总、步骤/流程图/时间线及零执行计数，再与实际 execute 成功/失败回执对照，验证来源缺失时为 UNKNOWN、全程零 POST。
- B 的一个文字断言同步为“动作回执 成功 · 验证 未知”，继续保留独立验证 UNKNOWN；未删减输入、控制归属或下载断言。
- 新 HEAD 定向组合 10/10 PASS（`.ui-c-p1-targeted.log`），`npm run check` PASS（`.ui-c-p1-check.log`）。按本次限定 Review 明确要求不重复全套 CI；下方 Offline/Python/完整 Browser 为首次候选 `925672e` 的结果，不冒充新 HEAD 的重跑。两项 #45 失败继续保留。

## 已有 API 的表现边界

1. `GET /api/runs` 当前没有列表级环境字段，列表显示“未记录，请打开详情核对”，详情读取原绑定；不复制另一活动任务的环境。
2. 通用 Task 没有独立可靠清理字段，显示 UNKNOWN；固定场景只读取 `desktopScenarioResult.cleanup`，不能由 `done` 或停止事件猜测清理结果。
3. 页面预览 API 仅接受文字参数；数值/布尔参数的页面执行适配未接通，明确禁用执行，仅保留查看与文字展开预览。本阶段未扩展后端类型转换或 schema。
4. 真实 #48 候选和 Task 未读取。本阶段用 15 步合成 `owned-chrome-cdp` 候选验证呈现与拒绝规则；Owner 查找真实候选属于后续 E 页面验收。

这些缺失以“未记录 / UNKNOWN / 未接通”呈现，不新增后端设计或伪造运行事实。

## 合成验证

新增 `tests/ui-v01-runs-workflows.test.ts`：真实 headless Chromium 访问临时 localhost 的生产 Dashboard HTTP 路由，事实源为临时合成 SQLite。测试控制器拒绝创建、执行、暂停或恢复 Task；不导入真实数据库、截图、配置、浏览器状态或密钥，不访问 8102。

| 定向用例 | 核对内容 |
| --- | --- |
| Runs 事实及归属 | done / waiting_user / paused / failed / unknown / blocked；人工确认+清理 PASS+自动 UNKNOWN 与自动 PASS+清理 FAIL 独立；动作成功+验证 UNKNOWN；观察来源、125ms 耗时、无截图、同 ID 不同 source、深链接、刷新、筛选、缺失记录；零 POST |
| Workflow 生命周期 | candidate / verified / retired、三个固定版本、来源、阶段范围、15 步 Hidden Chrome 候选、预览及非幂等提示；参数编辑与版本变化失效；仅三个指定 preview POST，零 trial/execute/publish；存储前后相同、无新 Task |
| 预览迟到及错误 | 延迟真实只读 preview 响应、阻止并发 POST、参数/版本改变后忽略旧响应、400/503、重试入口、空库；不启用执行 |

首次候选 `925672e` 的定向组合 `node --import tsx --test tests/ui-v01-runs-workflows.test.ts tests/workbench.test.ts tests/ui-v01-workspace.test.ts tests/dashboard.test.ts`：9/9 PASS（`.ui-c-targeted.log`）。保留 B 的新 Browser B 优先于 paused Guest A、延迟列表/刷新/深链接/画面与控制隔离、丢失响应不自动重发回归。

首次候选 `925672e` 的仓库必要检查使用既有依赖与 Chromium 缓存 `PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers`：

| 命令 | 结果 | 本机原始日志 |
| --- | --- | --- |
| `npm run check` | PASS，退出码 0 | `.ui-c-check.log` |
| `npm run test:offline` | 755/755 PASS，退出码 0 | `.ui-c-offline.log` |
| `npm run test:python` | 18 个契约文件 PASS，退出码 0 | `.ui-c-python.log` |
| `npm run test:browser` | 85/87 PASS、2 FAIL、0 cancelled、0 skip，退出码 1；C 新用例和 B 归属/提交链均 PASS | `.ui-c-browser.log` |

完整 Browser 的两项失败仍是既有 [#45](https://github.com/zlpoot/agent-desktop/issues/45) 下载 canceled：`desktop-selection-ui.test.ts:184` 的 `download.createReadStream: canceled` 与 `workflow-library.test.ts:159` 的 `download.saveAs: canceled`，B 在精确基线 `32370a8` 中已有复现。原因仍未确定，不在 C 修复范围。这里不重跑私有数据或删减断言，也不把部分 Browser PASS 写成全绿。

本机 `.artifacts/ui-v01-stage-c/runs-{390,1440}.png`、`workflow-{390,1440}.png` 为合成 UI 视觉复核素材，不是真实执行证据。截图、日志、SQLite 和其它生成资产均不提交。

## 独立 Review 的五步页面路径

1. 打开「任务」，用完整 `source/taskId` 搜索，切换进行中/待处理、终态及状态；打开一条记录，刷新后核对同一完整身份。
2. 核对目标、实际过程与「结果及核对」四项事实；展开诊断的步骤证据，分别检查动作回执、独立验证、来源和耗时。无截图时应显示空态，不能借用其它 Guest 帧。
3. 打开「工作流」，选择 Hidden Chrome 15 步候选，检查来源、候选/未回放/未晋升和通用回放禁用原因。只读预览后，试运行及发布仍须禁用。
4. 在普通合成 Workflow 切换 candidate / verified / retired 版本；预览后修改参数或版本，旧预览必须失效。阶段或停用版本不开放单独执行。
5. 检查空库、缺失 Task、读取错误、waiting_user / paused / unknown 的事实提示和条件化入口；390px 与桌面宽度均能阅读限制及结果。此路径只用于合成 fixture/已有记录查阅，不授权真实提交或回放。

## 停点

单独 Draft PR 停在 ChatGPT 独立 Review；不自行合并、转 Ready、发布、打标签或关闭 #49，不启动 D/E、Owner UAT、#51 或新实机任务。不创建或回放 API Key。历史 `A5 safety FAIL / Windows PAUSED / overall INCOMPLETE` 原样保留。
