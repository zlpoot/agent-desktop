# D0-D Closure / Capability Boundary

2026-10-05。按用户提供的 D0-D 要求，本轮仅收口已有能力，不新增应用、输入动作、UIA 功能、WGC、RAW input 或 Provider 接口。原 D0-A/B/C 记录作为历史证据保留。

当前结论：**D0 LOCAL WORKSPACE — ACCEPTED / CLOSED_CAPABILITY_SCOPED**。D1 同一次网易云真实 Viewer 的 Agent→Human→Resume→Agent 有运行记录及人工确认；D2 故意操作 Default Desktop 的专项由本次参与者报告通过。D3 能力矩阵及 D4 Final Review 完成。结论仅覆盖已验证的有限能力，不代表任意 Windows 应用或完整虚拟电脑。

## 执行门

- D1：指定歌曲播放后 Take Control，暂停再播放，实际点击 Resume。新代次确认前输入禁用；Resume 后使用已有 UIA/标题读取，记录匹配歌曲和当前播放状态。固定输入任务若已完成，仅重新核验状态并沿用原预算清理，不重放任务或增加下一输入动作。
- D2：可与 D1 同次运行。在固定脚本执行时，参与者刻意在 Default 连续输入合成数字、切换已有窗口、移动鼠标、滚动网页，再回来接管。逐项报告是否串输入、抢焦点、鼠标跳动、接管异常；只读监控计数不能代替这些判断。
- D3：形成 [Capability Matrix](capability-matrix.md)，明确有限 TARGETED_WINDOW_INPUT、SEMANTIC_INPUT 已证，RAW_ISOLATED_INPUT 未证，GLOBAL_INPUT 等禁止。
- D4：结合实际运行、人工报告、归属/代次/租约/预算/清理及限制做 Final Review。只有前两门完成才关闭 D0 的有限能力验证；不写“完整桌面全部通过”。

## 最小观察记录

仅在已有网易云控制权 ACK 中增加脱敏代次历史，ACK 后单独做 Resume 的只读重新观察；Viewer 显示该观察。没有新增输入 API、修改核心/Guest 协议、改变 Workflow schema、升级依赖或提高预算。历史上脚本完成后的 Resume 只有控制权 ACK，不执行 `step()` 的读取，所以需补这项证据，不能把旧日志当作重新观察。

`control_history` 最多保留 16 项，只含 owner、epoch、阶段进度、已应用人类动作数和单调时间；`resume_observation` 不含 HWND、标题、控件名或搜索文字。实际帧/配置/账号 UI/路径/令牌均继续私有忽略。60 秒到期仍自动清理；参与者若未完成 Resume 和重新观察，应重 Run，不延长预算。

## 验证与保存

本轮实际结果：noEmit 类型检查 PASS；TypeScript 离线 422 PASS、0 FAIL/0 SKIP；Python 11 个契约文件 81 PASS（包括 Spike 51 项），0 FAIL；localhost 浏览器 50 PASS、0 FAIL/0 SKIP；Fake Viewer 1 PASS。只有 Windows 10.0.26200 x64、Node 24.21.0、npm 11.19.0、Python 3.11.5、PowerShell 7.6.5、Chromium 153.0.8010.12 环境验证，其他版本不宣称通过。

复用网易云 3.1.40.205461 的既有真实自动用例也通过：查询后的进度 1 接管，恢复继续原任务；播放完成后再次接管暂停/播放，再 Resume，新代次 5 的重新观察匹配指定歌曲、播放中、进度 4/4；人类模式断连清理 PASS。该结果是测试客户端操作，不替代两道人工作业 Gate。前台事件 6、光标变化 1057、3907 个样本是只读计数，与用户活动并存，不能归因或直接判定 D2。

第一次复验把重新观察放在 ACK 之前，等待 Resume ACK 超时；保留为 BLOCKED，清理 PASS。记录读取拖延了交接，应与原 ACK 分开，修正后串行复验通过。新读取不提高租约或运行预算；采集/Worker 看门狗及未知输入效果 fail closed 保留。该失败不能写成通过。

## 同次人工运行与报告

参与者在本次 D0-D 检查请求后报告：“我确认了，没问题”。请求涵盖连续合成输入、Alt+Tab、移动鼠标、滚动网页期间的双向串输入、抢焦点、鼠标跳动，以及接管和 Resume。这是总体确认，没有逐项描述、输入内容或编辑器名称；D2 记为 `PASS_USER_REPORTED`，不把只读监控计数解释为体验证明，也不复用 D0-C 报告。

同一次运行记录 `Agent epoch 1 → Human epoch 2 → Agent epoch 3`，应用了 2 次人类协议动作。Resume ACK 后约 1157 ms，新观察记录 epoch 3、指定歌曲匹配、播放中、进度 4/4、任务完成且无待观察项，支持 D1 通过。此次接管时固定输入已结束，Resume 只重新读取状态；不能宣称本次人工运行恢复了未完成的输入。未完成脚本的恢复证据仍来自先前真实自动用例和 D0-B 合成夹具，分别保留。

运行约 60.05 秒后因 `duration_budget_exhausted` 自动结束，不记成人工 Stop。清理 PASS：Job 活跃进程 0、Desktop 对象消失。预算撤销后 Worker 的 `control_lease_expired` 是停机结果。Viewer 服务随后停止，相关实验 Python 与网易云进程归零。该次只读监控为前台事件 3、光标变化 1312、样本 5332，首尾前台相同、首尾光标不同；计数不能归因于 Agent。原监控字段 `human_parallel_input=NOT_RUN` 保留，人工结果单独记录。

## Final Review

D1 PASS；D2 PASS_USER_REPORTED；D3 PASS；D4 PASS_CAPABILITY_SCOPED。按用户本轮收口要求，打包版 Notepad 和 RAW input 是兼容性/后续研究案例，不作为有限 D0 收口阻塞项；原 D0-A 未通过及 Notepad `UNSUPPORTED` 历史结果不改写。

已证范围为本机此次版本/会话的合成 Win32 夹具和网易云、有限目标窗口消息/语义输入、Viewer 接管、当前代次恢复与清理。RAW_ISOLATED_INPUT、其他应用、完整桌面能力未证；账户、文件、网络、剪贴板和声音隔离未证。GLOBAL_INPUT、Default 输入回退及 SwitchDesktop 仍禁止。核心接口、Host/Guest 协议、Workflow schema、依赖和预算均未改变。历史 A5 `safety FAIL`、Windows `PAUSED`、整体 `INCOMPLETE` 保持不变。

公开结构化摘要见 [validation-d0d-results.json](validation-d0d-results.json)，逐文件去向见 [manifest-d0d.csv](manifest-d0d.csv)，能力边界见 [Capability Matrix](capability-matrix.md)。原始帧、账号界面、路径、访问令牌、人工报告和日志均保留于忽略的 `.artifacts/d0d-closure*/`。

原工程保持原地，本轮只维护候选工作区；不 push，不更改仓库可见性，不增加许可证。P0 LocalWorkspaceProvider Design 是收口后的独立下一步，本轮不实现其接口。
