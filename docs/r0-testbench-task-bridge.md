# R0：WindowsAgentTestBench 的 Local Workspace 逐动作桥

状态：实现待独立 Review；没有真实 Windows 自主 UAT PASS。基线 main 为
`bfc066ba8912fddbaa22377cc0d565e43c9cefcb`，与用户给定基线一致；2026-10-12 恢复时重新 fetch，main 未变化。
本补丁落实 Issue #51 的 R0 最小缺口，沿用 #16 的任务/流程目标；
不是 #29 的完整可信执行桥，也不改写 #57/#66/D2 的固定场景验收。

## 能力与证据

| 能力 | 代码位置 | 当前实现 / 已验证范围 | 实际阻塞 / 本轮最小修复 |
|---|---|---|---|
| 正常 Dashboard 自然语言入口 | `src/app/task-runner.ts`、`src/app/public/task-experience.js` | 既有 POST /api/tasks、显式环境选择、P7 等待/确认；本轮走真实 HTTP 路由的合成测试 | 保留现有入口；配置限定 TestBench 后提供 executable 的 Local Workspace 选项 |
| 既有 Agent Loop / Workflow Search | `src/graph/graph.ts`、`src/agent/stage-workflow-model.ts`、`src/agent/task-agent.ts` | M6–M9 已有实现；本轮合成证明观察驱动 Explore、第二次 Task 的阶段 Replay | 不复制 Loop。Windows 正式入口本来使用同一 Graph 和 StageWorkflowModel；没有强制改路由来声称每次都调用 runTaskAgent |
| Local Workspace 固定场景 | `src/desktop-provider/local-workspace-task-executor.ts`、`local-workspace-provider.ts` | D0/D2 既有固定场景真实证据保持原范围 | 通用 connectRuntime 的拒绝保留；不复用 Viewer/NetEase 输入许可 |
| TestBench 逐动作后端 | `src/desktop-provider/testbench-workspace.ts`、`testbench_worker.py`、`testbench/TaskChannel.cs` | 新的薄 WorkerClient 适配；生产 C# 编译，TS/Python 合成验证；未启动真实应用 | 只支持原窗口的导航、客户查询、只读资料/客户订单入口及有界 wait；没有任意 App 输入 |
| P7→Task 原实例桥 | `src/composition/root.ts`、`testbench-workspace.ts`、既有 `ControlledAppLauncher` | Session 先保留空 Desktop/Job；P7 在同一资源启动；原 issuer 单次 handoff；合成替换拒绝 | 保留原进程 HANDLE、不可写/删除的可执行文件 HANDLE、同一 Windows session/Desktop/Job、原 Window HWND/对象 incarnation 和控件 incarnation |
| 应用撤销与动作提交 | `testbench/RegistryFence.cs`、既有 `SqliteEnvironmentAppStore` | 直接运行生产 C# 栅栏与全新合成 SQLite：撤销不得越过先提交动作，ACK 后拒绝新提交 | WPF 实际 UI 提交线程使用 Windows 内置 winsqlite3，BEGIN IMMEDIATE 覆盖权威 Registry 检查与同步 UI 提交；没有只靠 Host 预检查 |
| 独立验证 / Trace / Candidate | 既有 Verifier、Trace 和 Workflow Store | 合成任务完成且 Trace 回读；假 ACK 没有新证据不能完成/学习；撤销失败不能生成候选；第二次任务 Replay | 不新增 Verifier/学习协议；候选仍经过既有独立结果、动作验证与模型决策资格门 |

## 真实调用链

`npm run dashboard` 读取显式 operator 配置，Root 把同一 TestBenchWorkspace
装配为 Local Workspace provider、P7 launch backend 和 Task executor。

`POST /api/tasks` → `DesktopTaskController.submitGeneric/runGenericBody` →
`TaskDesktopSessions.acquire`（持久化不可变 Session/instance/input resource） →
`TaskAppOnboarding.beforeRun` → 既有发现/确认或已确认 profile 复用 →
`ControlledAppLauncher` → 当前 Session 的空 Desktop/Job 内唯一启动 →
issuer 私有 handoff → `connectAppRuntime` 只读核对原目标 →
`ResourceInputControl.acquire` → 既有 DesktopVisionRuntime / Graph /
StageWorkflowModel 的 Observe→Decide→Ground→Execute→Reobserve→Verify →
既有 Trace / Workflow Candidate / Dashboard 结果。

任务模型只看当前 UIA AutomationPeer 证据。专用通道与 EVAL Oracle 分离；
不启动 Oracle server，不返回内部 AppState、测试模式或验证真值。
TestBench 的 Routed Click 和 TextBox Value 提交是同步的；没有使用
IInvokeProvider.Invoke 的延迟 dispatcher 回调作为“已经提交”的证据。
查询按钮已提交之后的异步结果通过后续新观察验证。

## 显式配置

正常 Dashboard 使用既有 AGENT_DESKTOP_ENVIRONMENT_CONFIG 指向 operator 配置。
新增字段只有：

```json
{"testBenchWorkspace":{"path":"C:\\ReviewedBuild\\WindowsAgentTestBench.exe","sha256":"<reviewed-build-sha256>"}}
```

示例占位 digest 必须替换为实际构建 hash；本轮没有启用该配置或启动真实应用。
它与 localWorkspace/hiddenChrome 配置互斥，不允许 executable 参数覆盖。
安装 scope 绑定当前 Host/OS 用户域、路径和构建内容；Runtime 同用户和权限检查保留。

## 最小边界

- 环境：provider `windows-local-workspace` / `local-workspace:testbench`。
  不根据 Goal 选择其他桌面，不 fallback Physical、VM 或 Default Desktop。
- 唯一安装目标：operator 明确指定的、从已 Review 仓库源码构建的
  `WindowsAgentTestBench.exe` 和 SHA-256。空/错误 digest、其它 executable、
  任意启动参数覆盖、混合旧 Local Workspace/Hidden Chrome 配置均拒绝。
  固定 --task-channel 参数进入实际 launchSpec、P7 确认与实例核对，不隐藏实际 argv。
- Goal 须显式提到 WindowsAgentTestBench，复用既有 P7 名称识别；未命名任务拒绝输入并释放空 Session。
- 启动前只保留空资源；P7 确认不授予 Agent 输入。
  实际运行实例与 Task Session 完全相同，不重新独立启动 helper app。
- 语义动作：当前观察中唯一、enabled 且未替换的 Button/Edit。
  Button 名仅允许工作台、客户管理、订单管理、系统设置、查询客户、
  打开张三/李四资料、查看客户订单、查询订单及打开当前 1003/1004 订单；Edit 仅客户姓名或订单客户姓名，至多 80 字符且无控制字符。
  这是动作权限 allowlist，没有动作序列、进度脚本或固定成功状态。
- wait 只允许 0–2000ms，无输入效果，等待后复核原实例和 InputControl。
  不支持坐标、全局按键、剪贴板、附件、保存、提交、任意 UIA 控件、窗口焦点输入。
- 没有像素观察、Viewer 接管或检查点恢复能力声明；正式普通任务仍保留既有
  风险门、预算、独立验证和输入控制。辅助模型默认策略不变。
- 通道是原进程的私有当前用户 Named Pipe，校验原 Python issuer PID 和随机 secret。
  原进程 HANDLE 与原窗口对象/控件 GUID 不随 PID/HWND/语义名重用而替换。
- 实际 WPF producer 每次提交打开同一个权威 Registry：
  核对 denial schema、denied-pending、安装 scope generation、
  profile revision/digest、installation/application、identity、launch spec、
  current + available + verified + 当前 confirmation；持锁同步提交。
  revoke 使用既有同步 SQLite 写事务，与 producer 的 writer lock 串行化。
- 断开/超时没有自动重试或输入 fallback。Python 串行 grant/epoch/3 秒 lease；
  3000ms 原生截止时间在 WPF 提交处再次核对；RPC 失联清理只终止自有 Job。
  Task 结束、未取得 P7 绑定和桥失败都清理自有 Session；
  清理 NACK 拒绝新的资源，不包装为成功。
- 该合作式 AutomationPeer backend 只覆盖 TestBench，不宣称任意第三方
  UIA/自绘程序、跨 OS producer、通用 #29 异步撤销协议或 Windows 实测证明。

## 验证记录

全部使用全新合成数据、ReactiveFakeModel 和私有 Fake backend。
ReactiveFakeModel 依据当前 Observation 内容选择动作，不使用动作数组/索引。
native SQLite 测试执行生产 RegistryFence.cs 的无 UI console harness，
仅对临时合成数据库/标记文件测试，不创建 Desktop、窗口或输入。

- TypeScript 定向 13/13：正式 Dashboard API、P7→Task 原实例、观察驱动动作、
  独立成功验证、Trace 回读、候选资格、第二 Task Replay、有界异步等待、
  原实例替换、撤销、假成功、无绑定拒绝、清理 NACK、生产 Root 装配无输入、并发 open/close 排空、原生 EOF 与初始化失败清理 NACK。
- Python 定向 8/8：启动/动作信任门、denial/schema/generation、
  observation/lease/action-id、生产 C# SQLite fence 的提交/撤销串行化。
- `testbench/build.ps1` 编译通过；生成 exe 仅在忽略的 artifacts 中，
  未运行，不提交。
- 2026-10-12 最终 `npm run check` 通过；`npm run test:offline` 788/788、0 skipped；
  `npm run test:python` 19 个文件全部通过（包含上述原生 SQLite 合成测试）。
- 本分支完整 `npm run test:browser` 97/99，两个失败与 main 基线相同：
  `desktop-selection-ui.test.ts:186` 的 `download.createReadStream: canceled`，
  `workflow-library.test.ts:159` 的 `download.saveAs: canceled`。浏览器未全绿；
  不将下载取消或合成通过改写成真实 Windows UAT PASS。
- 提交只包含源码、合成测试及本文；生成 exe、临时数据库、验证日志均不提交。

## R1 停点与建议

结论为 `R0_REVIEW_PENDING`：交付限定补丁等待独立 Review。
A5 safety FAIL、Windows PAUSED、整体 INCOMPLETE 及历史固定场景状态保持原样。
没有实机 Task、真实模型/JEV 费用、第三方站点/账号、Tag/Release 或合并。

Review 后建议首次任务：
“使用 WindowsAgentTestBench 找到张三的客户订单，读取订单编号、当前状态
和配送方式；不要修改或保存。”
该目标没有预写完整动作脚本；模型须根据当前 UIA 观察选择路径。
预期证据为同一原窗口的新 UIA 订单编号、状态文本和配送 ComboBox 值，
既有 Verifier 独立确认，不参考 act ACK 或 Oracle。
需要单独授权：新建的受控 hidden Desktop/Job、源码 Review 后构建并固定
SHA-256 的 TestBench、只读导航及客户姓名查询输入、同一目标动作范围与
清理。建议 DeepSeek 上限 12 calls / 12000 tokens，JEV/辅助模型 0；
届时还须提供明确模型配置与授权，达到预算即停，不自动增加。
