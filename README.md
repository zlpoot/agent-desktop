# Agent Desktop（公开候选工程）

实验性的 Host / Guest 桌面 Agent 工程，保留任务控制台、LangGraph 循环、Cordis 扩展装配、独立完成验证、预算、控制权隔离，以及 Workflow 学习、持久化与恢复。

**当前整体未完成。历史 A5 challenge-set 的结论是 `safety FAIL`，Windows 实验继续暂停。** 本仓库的离线回归只验证合成场景与接口契约，不能推翻该结论，也不能证明无人值守实机安全。实验启动链、真实结果及完整私有开发现场留在原工程，未迁入此仓库。

提取阶段建立了新的 Git 历史，随后按用户授权推送到 GitHub。没有修改远端可见性或选择项目许可证；来源与授权待确认，暂不按已授权开源项目发布。

## v0.1 控制台源码版（发布准备中）

第一版定位为**可在本地运行的 Agent Desktop 控制台源码版本**。当前没有正式 Windows 安装包或打包系统，需要按下文安装依赖并运行 `npm run dashboard`。它提供已接通的有限能力与操作页面；通用无人值守桌面执行尚未证明。

UI-01 的 A–D 已合并；2026-10-09，Owner 在 `main@c4885c7bd6a0e91ee961a570193a22d39a8bbf2c` 完成 E2 五区人工页面验收，均为 PASS（[验收记录](https://github.com/zlpoot/agent-desktop/issues/49#issuecomment-6080617594)）。当前状态为 `OWNER_UI_UAT_PASS / RELEASE_PREPARATION_NEEDED / TAG_NOT_CREATED / RELEASE_NOT_CREATED`。本次发布准备变更仍待独立 Review，Tag/Release `v0.1` 需 Owner 单独明确授权。

启动后五区入口为工作台（`#/live`）、任务（`#/history`）、工作流（`#/workflows`）、环境与应用（`#/environments`）、设置（`#/settings`）。可以查看模式与环境准入、已有 Task 的运行/步骤/验证/清理结果、Workflow 候选与固定版本及只读预览、环境应用状态，以及实际已接通的预算/提示词设置。真实执行仍须显式配置与授权，仅限已有受限场景。

人工页面验收不代表四模式后台完成、Windows/Agent 整体安全 PASS 或 Workflow 回放成功。Hidden Chrome 15 步 Workflow 仍是 candidate、未回放、不可通用执行；学习/优化入口灰化及内层 16 步聚合为一个外层步骤的复核颗粒度作为后续 UI 改进记录。完整 Browser 回归的两项下载 canceled 由 [#45](https://github.com/zlpoot/agent-desktop/issues/45) 跟踪，不宣称全绿。历史 `A5 safety FAIL / Windows PAUSED / overall INCOMPLETE` 保留。

详见 [设计与阶段状态](docs/ui-v01.md)、[Release Notes 草稿](docs/release-notes-v0.1.md) 和 [发布准备核对](https://github.com/zlpoot/agent-desktop/issues/50#issuecomment-6080664096)。

## 安装与校验

已验证环境：Windows、Node **24.21.0**、Python **3.11.5**。其他版本未验证。使用原 package-lock，依赖未升级；`check` 仍为 TypeScript `noEmit` 校验，没有打包系统。

在仓库根目录运行（PowerShell）：

```powershell
python -m venv .venv
$env:PATH = (Join-Path (Get-Location) '.venv\Scripts') + ';' + $env:PATH
python -m pip install --no-cache-dir -r requirements-offline.txt
npm ci --cache .npm-cache --no-audit --no-fund
npm run check
npm run test:offline
npm run test:python
npm run demo:offline
```

Python 契约测试使用标准库及 mock/AST 隔离，不需要安装桌面输入库。TypeScript 系统查询测试使用 `psutil`；离线 requirements 将原有依赖固定为本机已验证的 5.9.0，没有增加依赖或提高版本。新 venv 不使用系统 site-packages。现场桌面安装仍保留原 `requirements-desktop.txt`，本轮未验证。

本地浏览器测试及示例需要先下载匹配的 Chromium。安装访问 npm/Playwright 下载服务；测试和示例访问本机合成服务，无需账户、密钥、旧配置、数据库或真实桌面输入。

```powershell
npm run browser:install
npm run test:browser
npm run demo:browser
```

`npm test` 等同 `test:offline`；`test:all` 合并 TypeScript 两组，Python 单独执行。分类清单为 `tests/browser-tests.json`。这些命令清除模型与 Guest 相关的继承环境变量。每个 Python 测试文件独立运行，避免 Worker 控制单例串扰。

`node scripts/check-dashboard.mjs` 会在临时本机端口启动控制台、检查只读路由并停止进程，可验证无模型/Guest 配置的启动。

## 控制台与配置

```powershell
npm run dashboard
```

打开终端显示的本机地址，默认端口 4173。空工程会建立新数据库；缺少模型或 Guest 配置不妨碍控制台查看和离线示例。提交真实任务前必须自行提供相应配置。不要导入历史数据库或复制私人 `.env.local`。

普通 Chat Completions 模型可在**设置 → 模型与 Provider**填写 HTTP(S) API 地址、模型名及 API Key，保存到 gitignore 覆盖的本机 `config/model.local.json`。读取只显示 Key 是否存在、不回填明文；保存不会测试连接或启动任务。新普通任务开始执行时读取当前配置，同一次执行的规划/决策模型保持快照；已活动任务不受保存影响，暂停后恢复按原生命周期重新装配模型。文件是本机明文私有配置，不能分享或提交；Unix 新文件权限 0600，Windows 继承所在目录的访问控制。

`.env.example` 保留旧启动流程：非空 `COMPUTER_USE_BASE_URL`、`COMPUTER_USE_MODEL`、`COMPUTER_USE_API_KEY` 分字段优先于本机设置，页面如实显示覆盖来源。Key 优先级为 **env → 本机 Key（含显式清除）→ `.env.local`**；清除只写本机清除标记、不修改旧 env/`.env.local`，阻止 `.env.local` 自动回退，env Key 仍会覆盖清除。地址/模型不从 `.env.local` 加载，没有内网默认值。辅助 JEV 仍要求原 `JEV_BASE_URL` 与 env/`.env.local` 密钥，不读取这份普通模型设置。PowerShell 应使用 `$env:变量名='值'`。操作、范围与合成验收见 [v0.2-A 模型设置](docs/v02-a-model-settings.md)。

`config/acceptance-verifier.json` 与 `config/verification-shadow.json` 默认为 `off`，不调用辅助模型。规则验收、风险门、预算、输入控制和恢复检查仍保留。默认预算保持代码基线：deepseek 24 次 / 60,000 tokens，jev 120 次 / 300,000 tokens；没有提高预算。

应用模板初始为空，实际应用清单不提交。Host 使用 `apps.local.json`（空模板 `apps.example.json`）；Guest 使用 `config/agent-desktop-apps.json`（从 `config/agent-desktop-apps.example.json` 自行建立），登记执行文件绝对路径及窗口类/标题。可选预算配置同样从 `config/task-budget.example.json` 建立，缺失时使用上述代码默认预算。网易云执行要求显式 `NETEASE_APP_PATH`。部署参数参考 `config/deployment.example.json`，它是说明模板，不由运行时自动读取。应用与预算配置、密钥、运行状态都应私有留存。

按环境的应用接入与独立管理页见 [首次使用说明](docs/app-onboarding-guide.md) 和 [P7-E 实现/验收索引](docs/desktop-provider-p7-e.md)。管理能力默认关闭，需要可信显式装配；本轮只验证合成流程，真实环境尚未验证。

## 示例、评测与现场入口

`demo` / `demo:offline` 使用现有 FakeModel + FakeRuntime；网址仅是模拟数据。`demo:browser` 使用脚本模型及临时 localhost 表单。`demo:approval -- start` 及 `resume <任务 ID> approve|reject` 保留本机浏览器批准恢复示例；它生成自己的临时浏览器状态。

独立的 [D0 隐藏工作区 Spike](spikes/local-workspace/README.md) 验证同一 Windows Session 的另一 Desktop。`demo:local-workspace` 默认使用 Fake Viewer；`test:local-workspace` 是离线安全契约。`:windows` 入口显式执行受控实机实验，仅操作本次隐藏窗口。合成夹具、D0-B 接管子集和 D0-C 网易云启动、指定歌曲检索/播放及有限接管已接受；D0-D 补齐同一次真实 Viewer Resume 观察和人工专项并行干扰报告，**D0 LOCAL WORKSPACE — ACCEPTED（有限能力范围）**，见 [D0-D 验证](spikes/local-workspace/validation-d0d.md) 和 [能力矩阵](spikes/local-workspace/capability-matrix.md)。打包版 Notepad 仍为 `UNSUPPORTED`，原完整 D0-A 未通过的历史记录保留；RAW 输入、任意应用及完整虚拟电脑未证。该实验不修改 Provider、不接入 Agent/Workflow，也不恢复历史 A5 Windows 实验。

`eval:verification`、`eval:raw`、`bench:verification` 保留可复用评测，输入为合成场景。`node scripts/build-verification-dataset.mjs` 可重新生成夹具及指纹。标签是人工编写的预期值，未获得独立裁定；评测未知/未运行项不得计为通过。`workflows:migrate-targets` 是显式迁移入口，先阅读 `docs/development.md` 并备份自行提供的数据库。

以下入口会调用真实模型、第三方网站、VM 或实际桌面，**本轮未执行**，只在显式授权并配置后执行：`demo:task-a*`、`demo:task-b*`、`demo:desktop*`、`demo:jev:check`、`demo:netease`、`demo:nte:settings`、`demo:hearthstone:settings`、`desktop:inspect`，以及 `scripts/smoke-*` 中的现场脚本、`scripts/agent-desktop-vm.ps1`、Guest 安装/自动启动及 `testbench/p4`、`testbench/p5` harness。评测的 `--jev` 参数同样显式开启联网，未计入离线结果。Windows 暂停状态仍需另行 Review 才能开展新的实机实验。

详见 [架构](docs/architecture.md)、[开发与测试](docs/development.md)、[限制](docs/limitations.md)、[安全边界](SECURITY.md)、[来源审查](docs/provenance.md)、[文件分类](docs/extraction-manifest.csv)、[验证记录](docs/validation.md) 和 [归档边界](docs/extraction.md)。

## MVP 固定场景 Task

MVP 固定场景入口：`npm run dashboard:fixture`，打开终端显示的本机地址，明确选择环境和场景后提交生产 Task，查看独立验证与清理结果，并下载问题记录。这个入口只用合成后端，无真实输入、应用启动或模型调用；保持 NOT HUMAN VERIFIED。见 [五步使用及范围核对](docs/mvp-01.md)。

## P8-A 环境预检（A1）

Windows 本地首次体验入口：`npm run dashboard:preflight -- --config config/desktop-environments.example.json`，访问 `http://127.0.0.1:4173/#/apps`。环境不默认选择；只展示配置身份及缺失适配器诊断，扫描、启动、任务、模型、输入和 VM 控制关闭。A1、A2 已收到操作者通过反馈，独立审查待完成。详见 [A1 五步体验与停止说明](docs/desktop-provider-p8-a.md)。A2 提供由操作者点击触发的只读应用发现，使用单独的 `dashboard:discovery` 入口，仍关闭启动和输入；启动命令、体验步骤及反馈修订见 [A2 只读扫描五步手册](docs/desktop-provider-p8-a2.md)。

## P8-B 任务桥接只读预览

`npm run dashboard:bridge-preview -- --config config/desktop-environments.example.json --port 4176` 提供原启动目标/撤销边界诊断和固定测试步骤预览，不扫描、确认、启动或发送输入。当前原生桥接明确不可用，实际工作区、安装版本和目标验收仍待反馈；结构性签发来源校验不代表原生效果栅栏。见 [可行性表、兼容计划与六步体验](docs/desktop-provider-p8-b.md)。

## LIVE-01 Hidden Workspace Chrome

Hidden Workspace Chrome 的只读体验入口需显式加载安装配置：PowerShell 设置
`$env:AGENT_DESKTOP_ENVIRONMENT_CONFIG = (Resolve-Path config/desktop-environments.hidden-chrome.example.json).Path` 后运行 `npm run dashboard`。
在执行位置选择 **Hidden Workspace Chrome**，再选择 **只读打开 8102 接入权限页面（不创建 Key）**。
默认仅开放只读场景；另行取得一次新 Key 授权并在私有操作者配置中设置 `creationAuthorization` 后，可显式选择“一次创建 Key”固定场景。授权绑定一个 Task、新文件不覆盖旧 TXT、未知结果禁止重试；候选可查看，创建回放与通用 Task / Workflow 不开放。配置中的 Chrome 路径应与本机安装一致。
真实单 Key 结果、秘密边界与验证状态见 [LIVE-01 记录](docs/live-01-hidden-chrome.md)。
