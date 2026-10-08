# P8-A / #28：A1 环境预检交付

基线：`63e8f33faf0d8d6affd09c335d5706c7045d421a`。本轮仅 A1；[Parent #27](https://github.com/zlpoot/agent-desktop/issues/27) 明确要求“First delivery must stop after A1 for user hands-on feedback”。A2 收集器接入与真实扫描等操作者体验反馈后继续。本候选待独立审查与 Human UAT，不关闭 #28 或 #16。

## 现在如何体验（Windows PowerShell）

代码目录：`E:\projects\agent-desktop\.worktrees\p8-a`。最终交付 exact SHA 在本轮交付消息及私有 `.validation/p8-a-handoff.md` 中记录。只使用本候选；不要在旧 P4 目录运行。

在该目录打开终端，运行这一条命令（复用已安装依赖，无需安装、编辑应用 JSON、寻找 PID/HWND/window class）：

```powershell
npm run dashboard:preflight -- --config config/desktop-environments.example.json
```

浏览器地址：[http://127.0.0.1:4173/#/apps](http://127.0.0.1:4173/#/apps)。端口冲突时在同一命令后追加 `--port 4174`，并访问该端口。本轮由操作者亲自运行、打开与反馈；Codex 的合成 Browser 结果不替代 Human UAT。

显式 `--config` 加载已有可信配置解析器。所附配置关闭 Physical 输入，没有 Local Workspace 应用设置。可将 `--config` 指向操作者已维护的私有环境配置文件；它不会从环境变量、Task 参数、旧 app JSON、数据库、浏览器或系统应用目录自动导入。文件不存在/格式无效则退出，不回退配置。即使该文件声明输入 policy，A1 也不装配执行器或使用该许可。

### 五步体验与预期

1. 打开上述地址，核对“主机”和“配置：已显式加载操作员文件”。环境下拉保持“请选择执行环境”，扫描与指定路径按钮禁用，候选/注册清单为空。
2. 展开环境下拉，明确选择“本机交互桌面”。核对 Provider `physical` 和环境 `current-interactive-desktop`；这是配置枚举，不表示 Worker 或应用已经就绪。
3. 查看“发现适配：unavailable”“安装来源：unavailable”和“受控启动：unavailable”。原因明确说明尚未接入收集器、不表示未安装，原生会话状态为 unknown / not-proven。Provider 的 supported 声明也不提升当前业务能力。
4. 选择回“请选择执行环境”，确认旧环境诊断清空。若你已有可信 Local Workspace 配置，可切换到它，核对不同 Provider/environment 身份；缺少该配置时页面明确说明 Local Workspace 不可用，不自动选择夹具、本机或 VM。
5. 再选择环境，点“刷新配置”，然后浏览器重载。刷新会关闭旧页面会话并重新读取所选环境；重载恢复未选环境，仍然没有扫描、启动或候选。记录身份/用词/切换流程中不清楚的地方。

请反馈：目标环境、本轮点击路径、期望/实际显示和严重程度（阻塞/体验/建议）。特别确认所需环境是否能选择。真实主机名称、路径或截图仅放私有证据目录；公开 issue 只描述去标识化的体验问题。

### 禁止操作、停止与撤回

A1 禁止扫描/路径检查、确认/启动/重验/撤销、发送或恢复 Task、模型调用、桌面输入、Viewer、VM 控制与 Windows A5 实验。UI 不提供任务和桌面控制；服务器独立拒绝相关 API，查询参数不能开启它们。

在启动终端按 `Ctrl+C`，等待进程退出，关闭浏览器页面。端口随服务释放；A1 Registry 仅内存，不创建或导入应用数据库、启动配置、Task 或用户进程，无需清理用户应用。回到原仓库目录即可继续原工作；本候选未修改原 P4 checkout、未 push 或更改仓库可见性。

### 已知限制 / UX blocker

- 默认配置只提供本机 Physical 的配置身份；没有探测登录 Session、Worker、窗口或任何安装目录，不能把“可选”当成“连接就绪”。
- Local Workspace 的现有 Provider discovery 仍依赖已配置的有限应用。未配置时会明确显示不可用；**如果你的首次目标是 Local Workspace 且没有现成可信配置，本轮无法完成该环境选择，记为 UX blocker，不能宣布 A1 Human UAT 通过。** A1 不要求新用户手写应用 JSON、寻找路径或原生句柄来绕过这一限制；后续按实际反馈处理。
- 未挂载 Guest/VM discovery，明确显示未接入；不查询 Host 安装清单替代 Guest。不装配未配置的 Synthetic fixture。
- Registry 是新建的临时空清单，不表示没有安装软件，不继承 P7 历史确认；A2 才连接可信只读安装收集器，并由操作者点击扫描。
- 本轮没有真实安装扫描、native session readiness、业务 bridge 或人工体验证据。A5 safety FAIL / Windows PAUSED / overall INCOMPLETE 保持不变。

## 实现及验证范围

专用 `dashboard:preflight` 入口复用原 Dashboard 静态样式、环境选择和应用管理 UI、`AppManagement`、`TaskDesktopSessions`、`composeEnvironmentApps` 及 P7 SQLite Registry 契约。它只构造惰性的已有 Physical/Local Workspace Provider，枚举配置身份，不调用 `open`，不构造原 Task Controller、模型、Worker、Session scope、VM 控制或恢复任务。临时 Registry 采用 `:memory:`，所有应用端口为空。

Dashboard 的私有 composition 参数限制 A1 HTTP 路由，校验 localhost Host、Origin 和 fetch-site；应用管理仍使用原 P7 私有 POST、4096 字节限制与字段白名单。Controller 另限制 open/list/close/cancel，扫描和所有效果动作即使绕过 UI 也被拒绝。原 Dashboard 默认行为、Provider/Guest 协议、Workflow schema、预算与安全门不变。

新增合成验证：HTTP/直接 Controller 禁止效果、跨环境会话及 Guest 安装域隔离、错误 Host/Origin、零 Session、零磁盘状态；独立 CLI 从合成配置实际监听 localhost；真实 localhost Browser 的未选环境、缺收集器说明、切换、晚到响应、刷新、重载与移动端布局。所有数据和基础设施端口为合成；没有应用扫描、启动、真实模型、VM 或实机输入。检查矩阵日志保留于私有 `.validation/p8-a-{check,offline,python,browser}.log`，生成日志/截图/资产不提交。

状态：**IMPLEMENTED A1 / pending required matrix and Independent Review / NOT HUMAN-VERIFIED**。合成通过不得作为 Human UAT 通过；A2 未实施。最终检查结果以交付 exact SHA 的日志及交付消息为准。
