# R1.10 / U9b：无 Checkpointer 暂停的安全终止

Refs #92。交付停点：AWAITING_INDEPENDENT_REVIEW。

## 基线和调用方调查

- main / base：`bc88a69e33ba525dfdce8ee7b09b9fd9a7defcf0`；fetch 后核对一致。
- 独立 managed worktree、分支 `codex/r1-10-u9b-no-checkpointer`。
- 红测试 commit：`bbcbb8d670a4759cba968671a3eabdf6de82e401`，Graph 和 U9a golden 尚未修改。
- 原始 U9a golden 完整源码仍保留在 base 和红测试 commit；最终 exact HEAD 见 PR / Issue 交付记录。

| 入口（base 源码） | Checkpointer / 暂停与恢复依据 |
| --- | --- |
| src/app/task-runner.ts runGeneric | :670 创建 SqliteSaver；:704、:752、:775 的三个 Graph 分支及 :785 的 runTaskAgent 分支均传该 saver。常规新任务、恢复、guest/explicit、阶段任务均不省略它。创建失败会在进入 Graph 前进入外层 catch。 |
| Task Controller.pause (:864) | 只给运行中的 generic route 写 pause request；Graph 在原边界读请求。 |
| Task Controller.continue (:880) | 必须 status=paused；setup/recovery 的 restart 与正常 continue 仍走既有路径。本修复的 failed 终态不能进入它。 |
| Graph createAgentLoop / runTaskAgent | checkpointer 是公开可选参数。无 saver 的直接 Fake 调用可复现；runTaskAgent 原样转交可选依赖。 |
| CLI/Fake demos | demo.ts、browser-demo.ts、desktop-demo.ts、task-a-demo.ts、netease-demo.ts 等直接省略 saver；通常不主动请求 pause，但不能因此假定预算/异常暂停永不可达。approval-demo 和实际 AI demo 则传 saver。本轮没有运行任何真实 demo。 |
| resume.ts continuePausedTask / resumeSavedTask | 先调用真正 graph.getState，核对任务身份、状态及 tasks，再 Command resume。Trace JSON 不参与构造 checkpoint 或授予继续权；本轮不改该文件。 |

Task Controller :793 外层 catch 会对一般异常写 task_error / failed，覆盖先前 paused（部分 restart/continue 特例仍写 paused）。当前 Controller 正常分支全部带 saver，未发现该缺陷在主线可达；没有生产、UI 浏览器或实机复现。不能把源码可能性写成生产事故。

Dashboard server.ts 读取 Trace 的 status / error / summary；public/app.js 仅 status=paused 显示继续，task-experience.js 对 failed 显示“任务未完成”和历史原因。这是静态调用分析。新增本地 HTTP fixture 实测 API failed、continue HTTP 400 和真实 Controller 拒绝，未运行浏览器。

## 选择与最小变更

选择“不可恢复的安全终止”，仅在 pause_interrupt 的 interrupt() 前加无 saver 分支：

1. Graph 保留各原暂停门的 paused 审计事件及具体原因。
2. 无 Checkpointer 时保存一个 pause_interrupt 终态事件，status=failed。
3. error 保留原 error 或 summary，并说明“未配置 Checkpointer，无法安全继续；任务已终止”；summary 明确不能继续此任务。
4. Command 直接 END，不进入 finish、complete、decide、dispatch、模型恢复或 Workflow 自动重试。
5. 有 saver 时逐行保留原 interrupt、continue patch、replay 对齐和重新观察路径。只增加节点声明的 END 出边。

只改生产 graph.ts 的该分支及 ends 声明；不改任何 gate、Controller、Resume、Verifier 或状态 schema。

为什么不入口一律拒绝：公开 API 允许无 saver 的普通一次性运行，已有 Fake/CLI 用法。本修复让不需要暂停的运行保持兼容。
为什么不直接返回 paused：它会让 Trace/API 看似有可恢复资格，却没有 LangGraph checkpoint。
为什么不从 Trace 重建：审计状态没有原生 interrupt tasks，不能成为 Command resume 的恢复依据。

failed 表示任务无法继续完成，不代表未知副作用已经失败或未发生。未知效果的 recoveryRequired / recoveryUncertain / verificationPending / lastResult / impact 历史完整保留；已派发一次也不会自动重发。必须先核对现场，任何新任务均需调用方显式新建。

## 入口与边界矩阵

| 合成场景 | 原 gate | pauseRequested 次数 | decide 次数 | 无 saver 最终状态 | 有 saver 最终状态 |
| --- | --- | ---: | ---: | --- | --- |
| 人为 observe 后暂停 | pause_check | 1 | 0 | failed，0 dispatch | paused，原生 interrupt task |
| 人为执行前暂停 | pause_before_execute | 2 | 1 | failed，0 dispatch | paused，原生 interrupt task |
| 人为阶段边界暂停 | stage_plan | 2 | 0 | failed，0 dispatch | paused，原生 interrupt task |
| 已耗尽预算进入任务 | pause_check | 0 | 0 | failed，0 dispatch | paused，预算优先短路 |
| decide 用尽预算后 | pause_before_execute | 1 | 1 | failed，0 dispatch | paused，第二次人工检查被短路 |
| decide 预算拒绝 | budget_pause | 1 | 1 | failed，0 dispatch | paused |
| stage_plan 预算拒绝 | budget_pause | 2 | 0 | failed，0 dispatch | paused |
| recoveryJournal unknown effect | execute | 原时序 | 1 | failed，1 dispatch，不重放 | paused；continue 后重新观察并人工核对，不重放 |

三种人为暂停的有 saver 正例均用原生 continuePausedTask 恢复并再次观察，不发送被冻结动作。通用任务新观察证明完成时 done；阶段正例仍因原冻结完成条件缺少强证据保持 waiting_user，不修改 TaskContract 也不弱化验收。

负例覆盖无 saver 的 continue/resume 拒绝，以及“新建带空 MemorySaver 的 Graph + 已有 Trace JSON”仍不能继续。真实 DesktopTaskController 也拒绝 failed 任务，且合成 HTTP API 返回 400。

## 红绿证据和原件

修复前，在 base Graph 上运行：

`node --import tsx --test tests/no-checkpointer-pause.test.ts`

结果：20 tests / 12 PASS / 8 FAIL，exit **1**。七个暂停矩阵无 saver 用例和一个 unknown-effect 无 saver 用例抛 MISSING_CHECKPOINTER。其余十二个原生 saver/普通运行正例通过。

保留的本机原始日志：
`C:\Users\zlpoot\AppData\Local\Temp\agent-desktop-u9b-red-final.log`，
SHA-256：
`BAAA3CC0B1C9D193107D1039BEAD72ABA4056D9B8887000ECC6460BCC434B9B7`。
不将生成日志/数据库/截图提交仓库。以下是原日志数据的完整字段摘录：

```json
{"kind":"human-execute","checkpoint":false,"error":"GraphValueError: No checkpointer set\n\nTroubleshooting URL: https://docs.langchain.com/oss/javascript/langgraph/MISSING_CHECKPOINTER/\n","code":"MISSING_CHECKPOINTER","finalTraceStatus":"paused","nodes":["observe","decide","ground","resolve_action","pause_before_execute"],"dispatch":0}
```

原 U9a golden 基线单独跑 60/60 PASS，exit 0。修复生产分支后、未更新旧 golden 时组合测试 77 PASS / 3 FAIL，exit 1：两个旧 assert.rejects 不再抛异常，导致摘要场景计数只有 33。这明确暴露目标行为变化，并未把非目标失败改成预期。

U9a golden 的原 SHA-256 **不重写**：
`1936f41e6e820f37553572941301ef57cb7a46b250f59dd263180bc0ac68bb15`。
只在摘要中移除两处无 saver 暂停刻意新增的末尾 pause_interrupt 事件；其准确 node 顺序和完整终态与原 gate state 的差异由独立断言比较。原 paused 前缀、其余所有场景及所有有 saver 状态/Trace 仍满足旧摘要，墙钟 frozenAt 的原规范化不变。

夹具修正记录：初次红测试把 Graph 返回的 __interrupt__ 元数据当作持久化 ComputerState、Stage 恢复误期待弱证据自动 done，已按真实原生行为修正后再固定 12/8 红结果。首次 check 发现 FakeModel.decide 是无参签名，修正测试签名后 check 通过；均未变更生产语义。

## 验证命令与退出码

- `npm run check`：exit **0**（含新增 Controller/API 测试）。
- `node --import tsx --test tests/no-checkpointer-pause.test.ts tests/graph-guards-golden.test.ts`：
  修复后 **80/80 PASS**，exit **0**。
- `node --import tsx --test tests/no-checkpointer-control.test.ts tests/task-controls.test.ts`：
  **2/2 PASS**，exit **0**。本地 HTTP fixture 在沙箱外获准运行，仅临时数据，无模型实例创建。
- `node --import tsx --test --test-name-pattern="阶段验收模型超时|执行前请求暂停|动作执行中请求暂停|暂停后画面偏离|uncertain dispatch after crash|Worker execute|达到任务内调用上限后|阶段边界" tests/stage-navigation.test.ts tests/desktop-recovery.test.ts tests/model-budget.test.ts tests/workflow-recovery.test.ts`：
  **9/9 PASS**，exit **0**。
- `git diff --check`：exit **0**。

最终 exact HEAD 上的 check / golden 命令及退出码另见 PR 与 Issue 交付记录。没有宣称独立 Review 已完成。

## NOTRUN / 不变量

full offline/python/browser、大型 CI、真实 Windows/VM/APP、外站、真实/付费模型、B5a/B5b 真实全场景验收均 **NOTRUN**。
A5 safety **FAIL**、Windows **PAUSED**、overall **INCOMPLETE** 不变。

B5a/B5b、Verification/Verifier、Provider、Native、Guest、APP/HTML 主线、Workflow Schema、权限/lease/epoch、预算限制均未改；PR #68 未触碰。未自行合并、关闭 Issue、Release、部署或进入 U10/U11。停在 AWAITING_INDEPENDENT_REVIEW。
