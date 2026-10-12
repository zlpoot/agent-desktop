# R1 TestBench：第二次真实尝试与原 Desktop 查询修复

状态：R1_BLOCKED / INCREMENTAL_REVIEW_PENDING。已使用 2/3 次真实尝试，剩余 1 次。
本次依据 [Owner 最新授权](https://github.com/zlpoot/agent-desktop/issues/51#issuecomment-6116560079)、
[5d95e0f 增量独立 Review PASS](https://github.com/zlpoot/agent-desktop/pull/68#pullrequestreview-5486140516) 运行。

## 真实运行事实

- 运行源码 HEAD：`5d95e0ffb18bd402341e3a28e6ee2d3bf4eb793b`，运行前工作区干净。
- 从该 HEAD 重建 EXE，SHA-256：
  `0b8f2708de9edf2f4e5785ca98d3f7ea77e359110c3907b4da32ba32b531f99a`。
  本轮 operator 配置固定本次路径/hash，没有更改其他 Provider。
- 标准 start.ts、既有隔离 Dashboard cwd 与本地私有 DeepSeek 配置；
  正式 GET /api/settings/model 确认 ready=true、deepseek-flash。辅助模型与 Oracle 未启用。
- 正常 Dashboard/P7 提交原定张三订单只读目标；
  Task ID：`52d3c749-7599-420a-b114-fb93acd357aa`。
  原 Session/instance 已预约，P7 显示实际固定 EXE 与 --task-channel，操作员确认启动。
- Task 预算快照：DeepSeek 32 calls 请求前限制 / 100000 Token 软阈值。
  实际 calls/tokens/unreportedCalls=0/0/0，费用0；JEV/辅助0；输入0。
- 未进入原实例 handoff / Agent Loop / 业务独立 Verifier；
  订单三字段未读取验证，Candidate0。完整真实 Trace 已回读，6个事件。
- 服务已停止；Trace 保持 waiting_user / new_task_required，未手工改写为 failed/done。
  事后未发现本次 TestBench/Worker 进程，自有 TestBench Desktop数0。
  本次 Registry 原因没有再次包含 cleanup-unconfirmed；不把后验无残留当作业务 PASS。

## 第一处可信失败

原生 helper 的第一条诊断：

```json
{"method":"start","chain":[{"type":"Blocked","site":{"file":"policy.py","function":"validate_target","line":57}}]}
```

受审查 policy.py 第57行是 `target_exited` 拒绝：
Api.identity 返回的窗口存活判断为 false。诊断出现于 NativeBench.start 的初始
producer UIA capture 后、current 的原窗口 guard；不是根据清理错误猜测根因。
Dashboard 后续显示 stale-desktop-binding；
权威 Registry 记录 launch-result-unknown:app-launch-result-unknown。
这些后续错误与第一处窗口身份失败分开保留。

## 代码判断与最小修复

NativeBench 留在 Default Thread Desktop，却对 hidden Desktop 的原 HWND 调用
Api.guard / GetWindowRect / GetClassName。既有 D0 worker 明确在目标 Desktop 上查询。
这提供了与本次窗口判定失败相符的实现缺口；该修复是否解决真实启动，仍须最后一次 UAT 确认。

增加 window_desktop 只读范围：仅使用已保留、名称匹配的原 Desktop HANDLE，
校验 helper 起始线程仍为 Default，用 SetThreadDesktop 临时关联该 helper 线程，
再次确认原 Desktop 名称和用户 input Desktop=Default，finally 恢复并确认 Default。
窗口 guard、rect/class 查询在此范围内进行。
不是 SwitchDesktop，不切换用户输入桌面，不新增焦点/全局输入；
原进程 HANDLE、同用户权限、PID/Job/Windows session/Desktop/窗口 guard 全部保留。
绑定、身份或恢复失败仍拒绝，不重新选窗口或 fallback。
[SetThreadDesktop 官方契约](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setthreaddesktop)。

有限脱敏诊断同时沿显式 cause 和未被 suppress 的隐式 context 保留首错；
最多3层，不输出异常 message、请求、完整路径、secret 或 Key。

没有修改 Graph、模型、Verifier、Workflow schema、输入 allowlist、预算或 Registry 栅栏。
修改后的受信代码未执行真实 TestBench Task。

## 定向验证与后续

npm run check PASS；testbench_workspace_test.py 22/22 PASS。
新增8个合成用例覆盖原 Desktop 查询/恢复、rect/class 范围、窗口/用户/进程身份拒绝、
锁屏/其他Desktop拒绝、绑定/恢复失败以及隐式首错脱敏与 suppression。
没有机械重复全量 CI；C#源码未变，本次真实构建来自已审查5d95e0f。
这些是合成回归，不是修复后的真实启动 PASS。

本地证据：受审查 worktree 的 .artifacts/r1-attempt-2/
中的 configuration-evidence.json、native-failure-and-shutdown.json、
run-before-stop.json、full-trace.json、trace-summary.json、post-stop-desktops.json。
配置/二进制/完整证据留本地，不提交私有Key、旧数据库或生成资产。

交原 Draft PR #68 的新 HEAD 供 ChatGPT 增量 Review。
通过后沿用剩余1次授权，不需Owner逐项重批；成功立即停止。
不合并、发布、关闭Issue或晋级Workflow verified。
历史 A5 safety FAIL / Windows PAUSED / overall INCOMPLETE 不变。
