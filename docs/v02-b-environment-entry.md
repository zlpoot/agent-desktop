# v0.2-B 执行环境入口（#59）

基线：main@1e6ffd20503888962d3a9a4360b395524dccf7c0。范围是现有 Dashboard 的 UI/API 接线；不改变执行器、Host/Guest 协议、Workflow schema、安全门或预算。

## 实际支持矩阵

这是源代码与合成目录的状态核对，不是本机私有配置扫描或 LIVE UAT。主页和环境页以当次 GET /api/desktop/environments 的返回显示实际配置目录；读取失败是 UNKNOWN，成功但没有条目是“未发现”，不能推断未配置、离线或目标已就绪。

| 路径 | 现有入口与状态依据 | 配置 / 阻断与下一步 |
| --- | --- | --- |
| Browser | 已支持通用 Task；POST /api/tasks 的 destination=browser。task-runner.ts 使用 PlaywrightRuntime 的受控 Chromium；与 Hidden Chrome 分开 | 工作台读取 GET /api/settings/model 的地址、模型、Key 是否配置和来源。空配置或读取失败禁用新建 Browser 任务；配置完整仍未验证连通或 Chromium 安装/启动。到设置保存，重新读取准备状态 |
| Hidden Workspace Chrome | 仅有限场景。HiddenChromeTaskExecutor.assertAvailable 明确拒绝通用任务；scenarios 声明只读 live-01-chrome-readonly-8102，走 POST /api/desktop/scenarios/tasks | 仅显式 hiddenChrome 配置时注册，环境为 local-workspace:chrome。只读场景打开既定 8102 接入权限页面，不创建 Key；目标、登录、能力、输入租约在执行时重新检查。创建 Key 候选仅独立一次性授权存在时声明，已绑定/消费授权 unavailable，不激活或复用 |
| Physical | 目录存在不等于通用任务准入。PhysicalTaskExecutor 拒绝：无策略为 physical-task-policy-required，有策略仍 physical-task-capability-not-proven | Windows Provider 可发现当前桌面；增加策略不证明通用效果能力，不开放任意应用/RAW 输入。按目录原因核对；通用桥缺口留给 #51 / 独立 Issue |
| Hyper-V Guest | HyperVDesktopProvider.discover 从已有 Guest Session 记录发现 VM；Root 已装配 Guest 任务桥，executable 仅为通用 Task 接口准入 | 必须已有显式 VM / Token / Worker 配置。旧历史记录不能证明当前 Worker、目标或输入权；后台打开 Session 与检查绑定后才可能执行。未发现时不自动安装、启动或选择 VM；本阶段不扩展 VMware / 云桌面 |
| Local Workspace | LocalWorkspaceTaskExecutor 拒绝通用任务，只桥接 Provider.scenarios 的固定计划 | 已配置的 fixture D0 合成 EDIT/BUTTON 或网易云 3.1.40.205461 固定曲目场景；仅声明范围内支持，实际窗口与当次输入权仍须预检。Notepad unsupported，RAW / 任意应用 / Workflow not-proven。未配置不展示为可执行环境 |

追踪：src/composition/root.ts → TaskDesktopSessions.discover/assertTarget/assertScenario → GET /api/desktop/environments → task-experience.js / environment-catalog.js。executable 不证明 Session/Target ready；scenarios[].availability 与通用准入分别核对。目录查询不打开 Session、不构造 Runtime、不申请输入权。

局部接线修复：HTTP 原先只校验 destination=browser，没有传给 Controller。现在明确选择 Browser 时携带 destination，进入既有 generic_routes 并持久化 browser；不再由目标文字命中旧 Windows 专用执行路由。规划模型使用已有 Browser 提示配置；若规划返回 Windows，在创建 Runtime 前拒绝 browser-plan-environment-mismatch。不改 Agent Loop、旧未指定位置的任务、历史归属或 Workflow schema。

## 配置说明（准备不产生运行授权）

- 普通 Browser：设置页保存普通 Chat Completions 地址/模型/Key。只显示 Key 是否已配置，从不回填、复制或读取明文。环境变量优先于本机私有文件，旧 .env.local Key 仅作为原有回退；主页显示当前来源和覆盖提示。配置保存只写本机，下一个任务开始执行时读取，不测试网络。
- Hidden Chrome / Local Workspace：启动装配读取 AGENT_DESKTOP_ENVIRONMENT_CONFIG；只接受现有 desktop-environment-config.ts schema，hiddenChrome 与 localWorkspace 不能同时配置。可核对 config/desktop-environments.hidden-chrome.example.json 和 docs/live-01-hidden-chrome.md；使用已安装 Chrome 的绝对路径，不能把 Browser Chromium 身份与之混同。不在页面安装应用，也不添加 creationAuthorization。
- Hyper-V：现有入口需要 AGENT_DESKTOP_VM_ID、AGENT_DESKTOP_TOKEN，Worker 地址由 AGENT_DESKTOP_WORKER_URL 或原有记录提供。不要因为旧 Guest 在线记录就选择其它环境或推断输入权。本阶段不启动 VM；真实配置与动作须 Owner 另行授权。
- Physical：physicalInputPolicy 仅表达许可，不补充能力证据；目前通用任务继续禁用。
- 读取失败可用“重新读取准备状态”或“刷新环境目录”重试；不把错误解释成“未配置”。场景不可用/不支持/未证保留各自原因。重读后旧选择不自动替换，须核对后明确选择。

## Windows Owner 手顺（6 步）

1. 本阶段只做合成验收时用 npm run dashboard:fixture 打开本机 localhost 页面；不启动真实 Chrome、VM 或 Windows 输入。真实 Browser/桌面提交须另行明确授权与配置后才做 LIVE UAT。
2. 打开“设置”，核对普通模型的生效来源、地址/名称/Key 是否完整；只保存配置不测试连接，不要求重新手改进程 env。合成固定场景无需模型。旧 env 覆盖会单独提示。
3. 回到“工作台”，明确选择 Browser 或目录实际返回的桌面环境，点击“重新读取准备状态”；未发现、读取失败与通用任务阻断分别查看，并可打开此说明。
4. Browser 使用自主通用任务；Hidden Chrome / Local Workspace 必须再明确选择已支持的固定场景。固定场景禁用自由任务文本、完成条件和管理员开关；不消费或复用 Key 创建授权。不可用/未证选项不能提交。
5. 合成固定场景只点一次“发送任务”，观察任务 ID、执行、独立验证和清理记录。处理中按钮禁用；提交回执未知先到任务页核对，不自动重试。
6. 到“任务”查看对应记录，再从历史打开，核对准确的环境身份、场景、结果与清理事实。以此新建草稿会重新读取目录，旧场景失效须重选；旧 Guest 画面不能替代其它任务现场。

## 交付停点

合成验证只能证明入口和既有链路接线；不是 Owner LIVE UAT。Draft PR 指向 main，等待 ChatGPT 独立 Review Gate；不 Ready、不合并、不关闭 #59，不进入 C/D。#51 后置，A5 safety FAIL / Windows PAUSED / overall INCOMPLETE 保持。
