# R1.7 / B5a / P1：rebind 完成判决融合证据

日期：2026-10-14（Asia/Shanghai）。Refs #86。

状态：**AWAITING_INDEPENDENT_REVIEW**。Owner 授权独立实现与定向测试；本文不构成独立评审、验收或合并授权。

## 基线与范围

- `git -c http.proxy= -c https.proxy= fetch origin main`，exit 0；随后 `git rev-parse origin/main` 为 `aea46de4a10853835c805784b4628512b185c051`，与 Owner 指定起点一致。
- 独立分支 `codex/b5a-p1-rebind-fusion`；worktree：`E:/projects/agent-desktop/.worktrees/b5a-p1-rebind-fusion`。主 checkout 和其他工作树保持原状。
- 先红测试提交：`28da0f9c772f1f8d6d5ff4006cb50f9ab3f868fc`。最终精确 HEAD 记录在 Draft PR 与 Issue #86 交付评论中，避免在本提交中自引用。
- 唯一生产修改位于 `src/graph/graph.ts` 的 `complete()` rebind 分支。其他修改为一份 Graph 合成测试和本文。
- 未修改 rebind helper 的目标定位、Host/Guest 协议、Workflow/API/Schema、Provider/Native、依赖、Graph 路由、预算或输入控制。

## 修复前：Graph 可达假阳性

测试使用 FakeModel、继承 FakeRuntime 的合成运行时、临时新建 SqliteTrace 和真实 `createAgentLoop`；没有注入预先成功的 rebindState。动作依次是输入 NEW、CTRL+S、ESC、CTRL+O、声明 done，只有前四项被派发。

Trace 的观察链：

```json
{
  "baseline": {"sequence": 1, "runtimeId": "[7,1]", "value": "13900000001"},
  "editedSequence": 2,
  "committedSequence": 3,
  "absentSequence": 4,
  "rebound": {"sequence": 5, "runtimeId": "[7,2]", "value": "13977770002"}
}
```

冻结条件是 `windowTitleIncludes: 客户资料` 加手机号 `persistedAfter: rebind`。两条负例均实际可达：

1. 动作后观察的窗口标题正确，但完成再观察的标题变为“其他窗口”。旧代码先用旧观察计算 original，再仅根据新观察的 rb PASS 放行。
2. R1 观察与完成再观察的标题均为“其他窗口”。测试先确认 `verifyGoal(criteria, beforeComplete.observation).ok === false`，旧代码随后仍覆盖该结果。

第 2 条的修复前原始 Trace 摘录：

```json
{
  "decide.observation.windowTitle": "其他窗口",
  "result.status": "done",
  "result.goalVerification.ok": true,
  "acceptance_task.acceptanceReport.verdict": "pass",
  "acceptance_task.acceptanceReport.checks": [
    {"criterion": "structuredStates:0", "verdict": "pass", "captureSequence": 6}
  ]
}
```

窗口标题条件没有进入 checks。这是合成 Graph 的实际复现，不是 Windows 实机复现。

初始红例命令（生产代码仍为基线）：

```powershell
$env:B5A_EVIDENCE_DIR='.artifacts/b5a/red'
node --import tsx --test tests/rebind-completion-graph.test.ts
```

exit **1**，2 tests / 0 pass / 2 fail：负例得到 PASS，正例的报告缺少窗口标题条件。先红提交可重跑这两条测试。

补证第 2 条时，仅在本独立 worktree 临时使用 `git show aea46de4a10853835c805784b4628512b185c051:src/graph/graph.ts` 的原始生产文件，测试源码使用本次新增直接负例；执行后在 `finally` 中恢复修复文件。命令：

```powershell
$env:B5A_EVIDENCE_DIR='.artifacts/b5a/red-original'
node --import tsx --test --test-name-pattern='original verifyGoal FAIL' tests/rebind-completion-graph.test.ts
```

exit **1**，1 test / 0 pass / 1 fail；直接断言在 `done !== waiting_user` 失败。完整 Trace 留存在 `red-original/trace-0.json`。

## 修复后的判据

对所有混合条件取得**同一次完成再观察**，要求已有对象/epoch 保持一致且 capture sequence 前进；读取抛错、缺边界、旧序号或对象/epoch 漂移不复用旧观察。没有新增全局时效窗口。

原始完整 verificationContract 必须仍匹配 Goal、全部 successConditions 和当前 criteria；按其 evidenceSources 核对来源，不构造子合同。缺合同的旧 rebind Task 保持 UNKNOWN；普通非 rebind 旧 Task 保持原有通路。来源未配置、失配或字段采集不完整保持 UNKNOWN。Domain 不使用标量来源替代 FACET 信封，仍由原 DomainEvaluator/注册表核对 contributor、版本、对象、当次 capture 和 evidence refs。

先对完整 criteria 调用现有 `deterministicChecks`，只用专用链替换对应 `persistedAfter: rebind` 的占位 check。普通 structured 项保持原有来源/缺失/歧义判据与 evidence；未知键保留明确 UNKNOWN check；原有已存在结果横幅的 stale 规则仍生效。

可信条件任一 FAIL → 完整任务 FAIL；无 FAIL 但缺证/歧义/来源问题 → UNKNOWN；全部 check PASS 才 PASS。冻结合同不一致时证据无法归属于原任务，全部 check 降为 UNKNOWN，并增加 frozen_contract check。布尔 false 不被转换为“明确反证”。

原始文件硬 Gate 仍先执行；R1 的持久值矛盾仍 terminal failed，不重发保存。非 rebind 标量或 Domain 的 FAIL 按原路由等待用户；普通 structured FAIL 的原有终态路由也没有修改。

修复后的直接负例 Trace 摘录：

```json
{
  "result.status": "waiting_user",
  "result.goalVerification.ok": false,
  "acceptance_task.observation.capture.sequence": 6,
  "acceptance_task.acceptanceReport.verdict": "fail",
  "acceptance_task.acceptanceReport.checks": [
    {"criterion": "windowTitleIncludes", "verdict": "fail"},
    {"criterion": "structuredStates:0", "verdict": "pass", "captureSequence": 6}
  ]
}
```

`acceptance_task` 原始事件保存这次终态观察、链和完整报告；测试核对其报告与 Graph 输出的 JSON 序列化一致。成功时 goalVerification 的来源元数据也来自这次新观察。

## 定向验收矩阵

新增 Graph 测试共 **42** 个，均核对实际状态和报告。完整链用例还核对 R0/编辑/提交/缺席/R1 的序号、四次派发无重放、原始 Trace、Manual 不可提升 FAIL/UNKNOWN、没有 auxiliary 或 finalReviewPending 自动放行。

| 条件/场景 | 结果 |
| --- | --- |
| rebind PASS + 旧/新终态 windowTitle 可信错值 | FAIL，waiting_user，goalVerification false |
| windowTitle 缺失/来源不符 | UNKNOWN，waiting_user |
| DOM/UIA/pageText 缺证、来源不符、不完整 | UNKNOWN；DOM 条件不会借 UIA rebind PASS |
| UIA/pageText 当前完整且来源一致 | PASS，done |
| Goal/criteria/source 漂移、缺合同/来源、额外 source | UNKNOWN，禁止子合同/辅助回退 |
| 完成读失败、旧序号、epoch/object 漂移、枚举不完整 | UNKNOWN，不复用已闭合链的旧 PASS |
| 普通 structured 正确/错值/目标缺失/多个目标 | PASS / FAIL / UNKNOWN / UNKNOWN；保留 reason 和 captureSequence |
| Domain contributor 未登记/终态撤销/无可信 refs | UNKNOWN；Domain audit 仍进入原始 Trace |
| 当次绑定 Domain PASS/FAIL | 完整任务 PASS/FAIL，audit captureId 为 fixture-e:6 |
| 未识别键、预先存在的保存横幅 | UNKNOWN，完整 checks 保留原因 |
| 一项可信 FAIL + 另一项 UNKNOWN | FAIL |
| R1 值错而其余字段正确 | terminal failed，无保存重放 |
| Stage/辅助验收声称 PASS，但 rebind 缺证 | UNKNOWN；final Stage/auxiliary 调用计数为 0 |
| 单一正确 R1 快照，无保存/离开链 | UNKNOWN，0 次动作，Manual 不准入 |
| 完整链 + 所有剩余冻结条件真实 PASS | PASS，done |

## 验证命令与限制

`npm run check`：exit **0**。没有调整编译目标或依赖。开发中的测试源码曾使用 ES2023 findLast、不存在的 registry.unregister 和未规整的 undefined JSON 属性；均已在测试内修正，相关迭代日志保留，不能将这些中间失败写成成功。

核心定向回归：

```powershell
$env:B5A_EVIDENCE_DIR='.artifacts/b5a/core-green'
node --import tsx --test --test-concurrency=1 tests/rebind-completion-graph.test.ts tests/verification-structured-rebind.test.ts tests/structured-acceptance.test.ts tests/verification-file-graph.test.ts tests/readonly-browser-acceptance.test.ts tests/facet-contributor-matrix.test.ts
```

exit **0**，89 tests / 89 pass / 0 fail，记录见 `core-green.log`。其中新增 Graph 42 项。覆盖 rebind 专用链、普通结构化条件、纯文件 Gate、受限只读 Browser 的合成正负例和 FACET 信封，不访问外站。

人工/预算/恢复合成回归（沙箱外重跑，只用测试新建临时目录与 127.0.0.1 假服务）：

```powershell
node --import tsx --test --test-concurrency=1 --test-name-pattern='Host restart|restart uses|uncertain dispatch|Worker |动作关闭原窗口|人工结果验收|独立结果控件未被规划|任务状态、自动验收|Dashboard 人工验收|全局预算在提交时|规划解析失败|重新进入任务预算|预算设置 API|达到任务内调用上限' tests/desktop-recovery.test.ts tests/manual-review.test.ts tests/model-budget.test.ts
```

exit **0**，15 tests / 15 pass / 0 fail。包括合成恢复输入控制、unknown-effect 不盲目重试、预算耗尽在派发前暂停、人工确认保持自动原判决。两个最终成功批次共覆盖 104 个不同用例，不能把曾失败的 105 项批次写成成功。

先前把以上九份测试放进一个沙箱批次：exit **1**，105 tests / 98 pass / 7 fail。6 项受到回环 EACCES 或临时配置 rename EPERM 限制；白名单重跑已通过。另 1 项为既有预算网页用例：沙箱中配置准备失败，首次沙箱外重跑的负向过滤器未排除它，随后因本 worktree 缺少 Chromium 而启动失败。没有启动浏览器；其残留合成服务子进程按 PID、父 PID 和命令身份核对后清理。未安装依赖或更改该用例。两次失败批次均保留日志，预算网页用例是 **BLOCKED**，不是 PASS 或 NOTRUN。

NOTRUN：`npm run test:offline`、`npm run test:python`、`npm run test:browser`、完整/大型 CI、真实 APP/Windows/VM/外站/付费模型、U9/U10/U11、B5b。按 Issue #86 本次范围只执行上述定向合成测试。预算网页的既有阻塞不等于本轮修改涉及网页 UI。

## 原始证据与停点

忽略目录 `.artifacts/b5a/` 保留红/绿完整 Graph 输出、原始 SqliteTrace 事件的 JSON 导出、执行动作和命令日志。临时 SQLite 仅是测试新建数据；生成的 Trace/日志/manifest 不提交。

- `red/trace-0.json`、`red-original/trace-0.json`：两条假阳性。
- `core-green/trace-0.json`、`core-green/trace-1.json`：两条修复后直接负例；其他 trace 按同一测试文件顺序保存，单快照为 `trace-snapshot.json`。
- `core-green.log`、`check-final.log`、`synthetic-regression-whitelist.log`：最终命令输出。
- `.artifacts-red.log`、`red-original.log`、`graph-green.log`、`graph-green-v2.log`、`targeted-final.log`、`synthetic-regression-unsandboxed.log`：红例/开发迭代/环境阻塞记录。

Draft PR 使用 Refs #86；等待 ChatGPT Chat 对精确 HEAD 独立评审，Owner 决定合并。未 merge、关闭 Issue、修改 PR #68、release、部署或启动后续阶段。**A5 safety FAIL、Windows PAUSED、overall INCOMPLETE 保持。**
