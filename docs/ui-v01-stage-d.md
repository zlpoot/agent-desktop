# UI-01 阶段 D：Environment / Apps / Settings / Responsive

状态：`D_IMPLEMENTED_REVIEW_PENDING / E_NOTRUN / v0.1_NOT_RELEASED`。此候选等待 ChatGPT 独立 Review，不代表 D 验收、Owner UAT 或实机能力验证通过。

基线为 clean main `bd664e7d8983e23ec416347c0c5471136512c4bd`；依据 [#49 阶段 D 执行说明](https://github.com/zlpoot/agent-desktop/issues/49#issuecomment-6077694289) 和 [最终页面合同](ui-v01.md) 的 4.5、4.6、6、9 节。独立分支 `codex/issue-49-phase-d`；exact HEAD 在 Draft PR 交付记录中列明。

## 页面变更与真实来源

- 五个一级入口保持不变。「环境与应用 / 环境」增加同一目录、Provider/环境 ID 搜索与 Physical / VM / Local Workspace 类型筛选。只读取既有 `GET /api/desktop/environments` 与 `GET /api/desktop/sessions`，不自动连接、发现应用、启动或取得输入权。
- 每个环境单独显示通用 Task 准入及阻断原因、有限场景声明、匹配 Session 的连接状态与错误。旧 Guest Session 的 `vmId` 只匹配同一 `hyper-v / vm:<id>`；不将其离线或 VM 未配置套用到 Physical 或 Local Workspace。
- supported / unsupported / not-proven / forbidden 保留独立含义；场景的 unavailable 也保留原因。通用 `executable` 仅表示接口准入，不证明目标、应用、输入权或 Provider 全部能力就绪。
- 环境卡的「查看此环境的应用」进入现有应用页并明确选择同一完整身份，只读取应用配置。共享目录加载 Promise，避免页内导航与卡片选择抢先读取；切换或离页使迟到选择失效，不自动扫描或启动。
- 应用页分别展示候选发现、当前配置确认、历史启动验证、业务能力。确认按当前 profile revision/digest 核对，验证历史不作为新的启动许可或业务证据。原扫描、prepare、confirm、verify、revoke、配置版本和取消生命周期保持不变，禁用操作说明其条件。
- 设置保留本机预算/提示词真实 API 与只读 Host 插件入口。预算成功读取前保存禁用，可显式重读；所有数值先验证再展示。非法输入标记并聚焦；保存期间冻结输入与按钮，确认返回值与提交一致后才显示已保存。失败保留输入、提示未确认、不自动重试。
- 模型/Provider、默认模式/环境、权限/文件隐私、外观列为待后端接入项，保存禁用并说明原因。插件 active 只表示 Host 装配，不能当作 Session/目标就绪。
- 旧 VM 专属全局提示改为当前 Guest 范围；未配置的 Guest VM 管理按钮隐藏。环境、应用四项事实与设置卡使用现有 Shell 样式、窄屏重排和可见焦点。

## 现有接口的缺失明确呈现

1. 环境目录没有 Provider 基础能力明细或当次 Target readiness / 输入许可，显示「目录未提供 / UNKNOWN」，没有按环境类型推测支持状态，也没有扩展后端契约。
2. Session API 当前为 legacy Guest 管理面。没有匹配记录的环境显示「未记录匹配绑定」，不声称它离线。Session 读取失败单独说明，不能抹成所有环境不可用。
3. 应用发现、当前配置确认、历史启动验证均不升级业务操作资格；无业务证据时为 not-proven。可用操作仍由现有后台适配、风险、预算、输入权与独立验收控制。
4. 未接通的设置不能持久化。当前真实配置与未来规划有明确来源及作用范围；失败不会乐观显示成功。

生产后端变更只有新增前端静态 JS 文件的路由映射；Task / Workflow / Provider 接口、执行器、schema、Host/Guest 协议、Agent Loop、风险门、预算边界与输入租约没有改动。没有升级依赖或重构底层隔离。

## 定向合成验证

仅使用临时目录、合成数据及既有 FakeModel/FakeRuntime / 应用管理 fixture；真实 headless Chromium 访问临时 localhost 的生产 HTTP 路由。没有访问 8102、#48 私有 Key/Task/数据库/浏览器状态，没有新实机任务、真实模型调用或 Workflow 回放。

新增 `tests/ui-v01-environments-settings.test.ts` 两例核对：

- 四环境目录、搜索筛选、精确应用页链接、零自动扫描/启动；legacy 与显式身份 Session 只属于各自环境，错误不泄漏给 Local；离页迟到响应、目录 503、空目录均不误开应用或执行。模型、Runtime、输入租约计数为零。
- 预算读取失败时禁用保存、明确重读、输入焦点/错误、实际临时配置保存、并发阻止、未确认保存时输入保留、页内草稿及插件真实空态；四个未来设置始终禁用，零应用启动/模型/输入权。
- 环境、应用、设置分别在 **390、601、668、700、900、1366、1440px** 检查无横向溢出、按钮中心无遮挡、Tab / Shift+Tab 与可见焦点。

现有应用管理测试补充发现/确认/启动验证/业务能力四项断言。旧工作台测试的静态文件白名单加入新 JS，保留全部控制归属及响应式断言。首轮该夹具漏供新 JS 而超时，补齐后最终组合通过；未扩大生产能力或删除断言。

| 检查 | 结果 | 本机日志 |
| --- | --- | --- |
| `npm run check` | PASS | `.ui-d-check.log` |
| 定向页面/预算组合：新 D、app-management-ui、dashboard-preflight-ui、ui-v01-workspace、ui-v01-runs-workflows、workbench、model-budget、dashboard | 23/23 PASS | `.ui-d-browser-final.log` |
| `desktop-selection-ui`，仅匹配 `fixed scenario button reaches submit` | 7/7 PASS；七个宽度真实点击 → submit → 合成 HTTP → 202 Task ID → 临时存储，同 ID、单次副作用 | `.ui-d-submit.log` |
| 定向离线 `app-management` + `dashboard-preflight` | 13/13 PASS | `.ui-d-offline.log` |

页面组合保留 B 的丢失响应不自动重发、旧 paused Guest A 与新 Browser B 的画面/控制归属，以及 C 的 full source/task key、Workflow 预览边界和 ground 失败未 execute 的 P1 回归。

依 #49 本轮不重跑完整 Offline / Python / Browser。此前完整 Browser 两项下载 canceled 仍属于 [#45](https://github.com/zlpoot/agent-desktop/issues/45)：`download.createReadStream` 与 `download.saveAs`；不改下载断言，不将本轮定向 PASS 表述为完整 Browser 全绿。

合成截图位于本机 `.artifacts/ui-v01-stage-d/{environments,apps,settings}-{390,1440}.png`，已查看环境桌面宽度、应用及设置窄屏截图。截图、日志、临时数据库和其它生成资产不进入 Git。

## 独立 Review 页面路径

在隔离的合成 fixture 或既有只读记录中核对；这些路径不授权实机执行：

1. `/#/environments`：核对三类环境与完整身份、搜索/类型筛选、准入/有限场景/Session/缺失能力分离；刷新失败及空目录有明确状态。
2. 环境卡「查看此环境的应用」→ `/#/environments?view=apps`：选择同一身份，核对四项事实和禁用原因；返回/快速切页后旧响应不得重新选环境或启动应用。
3. `/#/settings`：读取来源、本机预算与提示词、未来设置禁用。错误时检查聚焦、保留输入和未确认提示；不以私有配置测试保存。
4. `/#/settings?view=plugins`：插件来源为当前 Host，缺少快照显示真实原因；返回预算页草稿保留。
5. 390 至 1440px 七个断点检查无横向溢出和遮挡，键盘能找到操作入口。B/C 的任务深链接、Workflow 只读预览及 Guest A / Browser B 控制归属沿用已有回归。

## 停点

独立 Draft PR 等待 ChatGPT Review；不自行合并、转 Ready、关闭 #49 或开始 E / Owner UAT。未开展 #50 Tag/Release、#51 LIVE-02、实机输入、真实模型、Key 创建或 Workflow 回放。历史 `A5 safety FAIL / Windows PAUSED / overall INCOMPLETE` 保留。
