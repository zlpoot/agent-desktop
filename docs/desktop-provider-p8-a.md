# P8-A / #28：A1 环境预检交付

基线：`63e8f33faf0d8d6affd09c335d5706c7045d421a`。[Parent #27](https://github.com/zlpoot/agent-desktop/issues/27) 要求先交付 A1 并等待人工反馈，已按此停点执行。2026-10-08 操作者对本手册明确反馈“我已经验证完成，没有问题”，记录 **操作者报告 A1 人工体验通过**，对应候选 `6468ea491213a0193380aed5f5d225c4a4589122`。反馈范围为本机环境选择及未配置工作区诊断，不包含实际配置工作区、原生能力、启动或业务验证；实现方的合成检查和独立代码审查不替代这份人工反馈，也未独立重复体验。独立审查已提出仅文档修正要求，修正后的简短复审仍待完成；#28、#16 和整体项目仍未完成。后续 A2 的另一次人工体验见 [A2 只读扫描手册](desktop-provider-p8-a2.md)。

## 现在如何体验（Windows PowerShell）

在你的仓库工作目录打开 PowerShell，先确认使用 PR #31 的候选分支。最终交付 exact SHA 在本轮交付消息及私有 `.validation/p8-a-handoff.md` 中记录；不要在旧 P4 目录运行。本机工作目录只保留在私有交接记录中。

在该目录打开终端，运行这一条命令（复用已安装依赖，无需安装、编辑应用 JSON、寻找 PID/HWND/window class）：

```powershell
npm run dashboard:preflight -- --config config/desktop-environments.example.json
```

浏览器地址：[http://127.0.0.1:4173/#/apps](http://127.0.0.1:4173/#/apps)。端口冲突时在同一命令后追加 `--port 4174`，并访问该端口。本轮由操作者亲自运行、打开与反馈；Codex 的合成 Browser 结果不替代 Human UAT。

显式 `--config` 加载已有可信配置解析器。所附配置关闭 Physical 输入，没有 Local Workspace 应用设置。可将 `--config` 指向操作者已维护的私有环境配置文件；它不会从环境变量、Task 参数、旧 app JSON、数据库、浏览器或系统应用目录自动导入。文件不存在/格式无效则退出，不回退配置。即使该文件声明输入 policy，A1 也不装配执行器或使用该许可。

### 五步体验与预期

1. 打开上述地址，核对“主机”和“配置：已显式加载操作员文件”。环境下拉保持“请选择执行环境”，扫描与指定路径按钮禁用，候选/注册清单为空。
2. 展开环境下拉，明确选择“本机交互桌面”。核对“环境提供方：本机交互桌面”和“执行环境：当前登录的系统桌面”。原始 `physical` / `current-interactive-desktop` 标识保留在折叠的技术详情中；这是配置枚举，不表示应用已就绪。
3. 查看“应用发现：暂不可用”“安装来源：暂不可用”和“受控启动：暂不可用”。原因明确说明尚未接入收集器、不表示未安装，实际运行状态未知、能力就绪情况尚未验证。能力表用中文逐项说明“已声明支持”“尚未验证”“不支持”“禁止使用”的含义和适用范围；已声明支持不代表当前机器或应用已就绪。
4. 选择回“请选择执行环境”，确认旧环境诊断清空。若你已有可信 Local Workspace 配置，可切换到它，核对不同 Provider/environment 身份；缺少该配置时页面明确说明 Local Workspace 不可用，不自动选择夹具、本机或 VM。
5. 再选择环境，点“刷新配置”，然后浏览器重载。刷新会关闭旧页面会话并重新读取所选环境；重载恢复未选环境，仍然没有扫描、启动或候选。记录身份/用词/切换流程中不清楚的地方。

请反馈：目标环境、本轮点击路径、期望/实际显示和严重程度（阻塞/体验/建议）。特别确认所需环境是否能选择。真实主机名称、路径或截图仅放私有证据目录；公开 issue 只描述去标识化的体验问题。

### 禁止操作、停止与撤回

A1 禁止扫描/路径检查、确认/启动/重验/撤销、发送或恢复 Task、模型调用、桌面输入、Viewer、VM 控制与 Windows A5 实验。UI 不提供任务和桌面控制；服务器独立拒绝相关 API，查询参数不能开启它们。

在启动终端按 `Ctrl+C`，等待进程退出，关闭浏览器页面。端口随服务释放；A1 Registry 仅内存，不创建或导入应用数据库、启动配置、Task 或用户进程，无需清理用户应用。回到原仓库目录即可继续原工作；本候选未修改原 P4 checkout 或更改仓库可见性。操作者已授权通过工作分支和 PR 交付，推送不代表独立审查或合并通过。

### 已知限制 / UX blocker

- 默认配置只提供本机 Physical 的配置身份；没有探测登录 Session、Worker、窗口或任何安装目录，不能把“可选”当成“连接就绪”。
- Local Workspace 的现有 Provider discovery 仍依赖已配置的有限应用。未配置时会明确显示不可用；**如果你的首次目标是 Local Workspace 且没有现成可信配置，本轮无法完成该工作区选择，记为 UX blocker，不能宣布该工作区的人工体验通过。** 已收到的本机环境及未配置工作区诊断反馈不证明实际配置工作区可用。A1 不要求新用户手写应用 JSON、寻找路径或原生句柄来绕过这一限制；后续按实际反馈处理。
- 未挂载 Guest/VM discovery，明确显示未接入；不查询 Host 安装清单替代 Guest。不装配未配置的 Synthetic fixture。
- Registry 是新建的临时空清单，不表示没有安装软件，不继承 P7 历史确认；A2 才连接可信只读安装收集器，并由操作者点击扫描。
- A1 没有真实安装扫描、native session readiness 或业务 bridge；人工体验通过只覆盖本手册的环境选择和诊断。A5 safety FAIL / Windows PAUSED / overall INCOMPLETE 保持不变。

## 实现及验证范围

专用 `dashboard:preflight` 入口复用原 Dashboard 静态样式、环境选择和应用管理 UI、`AppManagement`、`TaskDesktopSessions`、`composeEnvironmentApps` 及 P7 SQLite Registry 契约。它只构造惰性的已有 Physical/Local Workspace Provider，枚举配置身份，不调用 `open`，不构造原 Task Controller、模型、Worker、Session scope、VM 控制或恢复任务。临时 Registry 采用 `:memory:`，所有应用端口为空。

Dashboard 的私有 composition 参数限制 A1 HTTP 路由，校验 localhost Host、Origin 和 fetch-site；应用管理仍使用原 P7 私有 POST、4096 字节限制与字段白名单。Controller 另限制 open/list/close/cancel，扫描和所有效果动作即使绕过 UI 也被拒绝。原 Dashboard 默认行为、Provider/Guest 协议、Workflow schema、预算与安全门不变。

新增合成验证：HTTP/直接 Controller 禁止效果、跨环境会话及 Guest 安装域隔离、错误 Host/Origin、零 Session、零磁盘状态；独立 CLI 从合成配置实际监听 localhost；真实 localhost Browser 的未选环境、缺收集器说明、切换、晚到响应、刷新、重载与移动端布局。所有数据和基础设施端口为合成；没有应用扫描、启动、真实模型、VM 或实机输入。检查矩阵日志保留于私有 `.validation/p8-a-{check,offline,python,browser}.log`，生成日志/截图/资产不提交。

状态：**A1 已实现；操作者报告人工体验通过；文档修正后的独立复审待完成**。A1 最终检查：类型、离线 685/685、Python 15 文件通过；Browser 58/59，仅既有下载取消失败（基线复现），受影响 A1/P7 Browser 重验 4/4 通过。私有日志保留完整结果；这些实现方合成检查不独立验证真实操作，也不替代已收到的操作者反馈。A2 的实现和体验状态单独记录，不能由 A1 通过推断。

## A1 体验反馈修订

禁用按钮使用灰色和禁用光标；预检阶段路径框隐藏。能力名称、状态、环境诊断及安全结论改用中文。能力表逐条保留声明状态与应用、版本、操作和机制限制；同一能力的不同范围分别列出，不合并成通用支持。原始标识与声明保留在折叠的“技术标识”中，不改变 Provider 契约、能力判定或授权。新增合成 Browser 验证覆盖全部十二项能力、不同版本声明、不可信文本的安全显示、切换清空与移动端布局。
