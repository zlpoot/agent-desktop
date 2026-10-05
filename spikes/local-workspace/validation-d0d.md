# D0-D Closure / Capability Boundary

2026-10-05。按用户提供的 D0-D 要求，本轮仅收口已有能力，不新增应用、输入动作、UIA 功能、WGC、RAW input 或 Provider 接口。原 D0-A/B/C 记录作为历史证据保留。

当前结论：**OPEN_PENDING_D0D**。D1 同一次网易云真实 Viewer 的 Agent→Human→Resume→Agent 和 D2 故意操作 Default Desktop 的专项均待人工运行及报告；不复用 D0-C 的总体报告直接填成通过。

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

D0-D 人工结论暂未填写。公开结构化摘要见 validation-d0d-results.json；原始帧、账号界面、路径、访问令牌及日志均保留于忽略的 `.artifacts/d0d-closure*/`。

原工程保持原地，本轮只维护候选工作区；不 push，不更改仓库可见性，不增加许可证。P0 LocalWorkspaceProvider Design 是收口后的独立下一步，本轮不实现其接口。
