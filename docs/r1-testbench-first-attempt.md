# R1 TestBench：第一次真实尝试与清理/诊断增量

状态：R1_BLOCKED / INCREMENTAL_REVIEW_PENDING，未证明真实自主 UAT PASS。

Owner 最新授权：[Issue #51](https://github.com/zlpoot/agent-desktop/issues/51#issuecomment-6116560079)。
本次真实尝试使用受审查 HEAD `6ad302913415955258538c1598dd17adc9b57ba5`。
允许最多三次同一只读目标；本次计为第一次，剩余两次未执行。

## 实际模型与入口

标准 `src/app/start.ts` 从本轮隔离 Dashboard cwd 启动，没有 FakeModel/FakeRuntime 注入。
当前已授权 `DEEPSEEK_API_KEY` 环境来源迁入该 cwd 的私有 `config/model.local.json`；
Key 未打印或提交。官方兼容地址为 `https://api.deepseek.com`，
账户 `GET /models` 返回 `deepseek-flash` 可用；正式
`GET /api/settings/model` 回读 `ready=true`、来源 private-file。
仅作配置可用性核对，没有额外 Chat Completion 探测任务。

正常 Dashboard 选择 `windows-local-workspace / local-workspace:testbench`，
单次 DeepSeek 设置为 32 calls / 100000 Token 软限制。
JEV/辅助模型没有配置或启用，实际调用 0。
旧 JEV 预算快照保留未启用的默认值，不能将该数值解释为辅助调用授权。
独立 Graph Verifier 未关闭或替换。Token 硬限制缺口没有修复或改称硬限制。

## 真实结果

- Task ID：`0808691e-c040-47bc-aedb-ff363c99cf84`。
- 目标：使用 WindowsAgentTestBench 查询张三订单编号、当前状态、配送方式，不修改或保存。
- 构建 SHA-256：`a3084b729d7e58f14b6b25381496491efd476e6f0a97130a58ee47793d10e864`。
- 正式 POST /api/tasks → 原 Session 预约 → P7 候选 → 本地操作员确认固定 EXE 与
  `--task-channel` → 启动验证失败。
- Dashboard 显示 `testbench-workspace-unavailable`；权威 Registry 留下
  `launch-result-unknown:app-launch-cleanup-unconfirmed`。
  启动根因被通用错误掩盖，尚未可靠确定。原实例 handoff 和 Agent Loop 未进入。
- 实际 DeepSeek calls/tokens/unreportedCalls = 0/0/0，费用 0；
  JEV/辅助调用 0，输入动作 0。不是“零成本自主通过”。
- 订单三字段与业务独立验证 NOTRUN；真实 Trace 已回读（7 个事件），Candidate 0。
- Dashboard 中取消该失败 Task 后状态为 stopped。关闭 Dashboard 返回 cleanup AggregateError，
  不宣称原 producer cleanup ACK 成功。
- 事后只读核查：本次 TestBench/Worker 进程未发现残留，自有 TestBench Desktop 数为 0。
  事后无残留不改写历史 cleanup-unconfirmed。

## 最小受信增量

`testbench_worker.py` 的 close 不再因 drain、进程等待或 Desktop 检查失败而跳过
其他自有句柄与 Registry 释放。进程退出与 Desktop rundown 做有界确认；
仍存在或发生错误时 NACK，Host 继续阻止新资源，不伪造清理成功。

Python 私有 RPC 与 C# producer 增加脱敏诊断：有限异常类型、数值 OS 错误、
受控源码位置、常量 producer 原因。Host 只记录这份诊断，不记录异常消息、
请求内容、完整路径、窗口文本、secret 或模型 Key。
没有修改输入 allowlist、Registry/lease/实例身份、预算、Agent Loop、Verifier 或 Workflow schema。
Named Pipe 原来已使用 buffering=0，本增量没有改动该设置，也不把它作为已证实根因。

## 必要验证与停点

- `npm run check` PASS。
- 定向 TS：`tests/testbench-workspace.test.ts` 13/13 PASS。
- 定向 Python：`testbench_workspace_test.py` 14/14 PASS，
  包括延迟/永久 Desktop rundown、drain/关闭失败排空、进程退出不确定、Desktop 访问/探测失败不能当作缺席、诊断脱敏。
- 修改后的 C# 编译 PASS；Review 构建 SHA-256：
  `f75d9f0012d1707f5de27d006dc814518b6693d76fa37edc8f423774d0af817d`，未启动。
- 没有重复全量 CI，合成通过不等于原生启动或真实自主任务通过。

本地新证据在受审查 worktree 的 `.artifacts/r1-single-20261012/`：
`dashboard-model-ready.json`、`task-1-full-trace.json`、`task-1-run.json`、
`native-state-after-stop.json`、`dashboard-run/` 新任务/预算/Registry 数据库。
模型私有配置和生成证据不提交 GitHub。

提交到原 Draft PR #68，等待 ChatGPT 对新 HEAD 增量独立 Review。
通过后沿用剩余两次 R1 授权，构建/固定新的 EXE hash 后继续；
不在 Review 前运行修改后的受信代码，不合并、关闭 Issue、发布或晋级 Workflow verified。
历史 A5 safety FAIL / Windows PAUSED / overall INCOMPLETE 不变。
