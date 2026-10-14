# R1.9 / U9a Graph 前置守卫等价提取

Refs #90。状态：AWAITING_INDEPENDENT_REVIEW。

## 基线和范围

- main / base：`62c95ab37d7ec3ecda662b550c8366e1f37c6a33`（fetch 后核对，无漂移）。
- 独立分支：`codex/r1-9-u9a-graph-guards`；独立 managed worktree。
- 先提交 golden：`9f7ab54`，此时 Graph 仍是原始实现。
- 最终 exact HEAD 由 PR 正文与 Issue 交付记录提供，避免自引用 commit。
- 只改 Graph 的纯判断调用，新增 56 行 guards 模块及合成测试；没有暂停 helper 提取。暂停条件过小，且预算查询会写 SQLite，保留原节点更容易保证调用次数、短路和时序。

## 真实调用关系与所有权

| 边界 | 原行为与此次保留内容 |
| --- | --- |
| observe / ground / resolve_action | 观察失败和定位失败用 focusLost 路由 focus_recover / recover；恢复动作、恢复次数、重新观察都仍由 Graph 执行。 |
| decide | failed 先返回；其次整任务动作上限；再次 Stage 上限；之后才调用模型。预算异常仍在原 catch 保存 budget_pause。 |
| pause_check | observe / verify 后的边界：先调用 currentBudgetStopReason，再短路调用 pauseRequested(taskId)。摘要“已在安全边界暂停”。无暂停不写 Trace。 |
| ground → resolve_action → pause_before_execute | 定位、提供者解析后，在 risk_check / execute 前再次检查预算和人为暂停。摘要“动作尚未发出，已暂停”。此节点及路由未动。 |
| risk_check | 判决输入是原始 lastAction，不是 groundedAction。顺序：impact 指纹 → 最近 impact → 不同且验证成功的历史 reset → duplicate → 批准三条件 → duplicate 未批准 → 批准风险/重复动作 → 高风险 → 普通动作。 |
| human_interrupt | Graph 保存 waiting_user、发起 interrupt；批准记录 action 指纹和 resumePendingAction，然后重新 observe / ground / resolve_action / pause_before_execute / risk_check。拒绝到 failed / finish，不能 dispatch。 |
| execute | Graph 继续对 groundedAction 再调用 assertReadonlyBrowserAction，冻结验证基线，写 dispatch_pending、dispatch、尝试证据与 Trace。impact 指纹仍取 lastAction。只有 effect=none 可换 provider，未知效果不换 provider；recoveryJournal 保留暂停与人工核对。 |
| verify / complete / stage_check / finish | B5a/B5b、Readonly、File、Domain、Manual 验收、终态保存和强证据绑定未修改。 |

guards.ts 机械迁移 actionIsRisky、impactFingerprint、observationSignature、focusLost，并聚合 riskDecision。返回 duplicate / approved / risky / allow 只代表原来的四个分支，不是新权限。
Graph 保留原来的所有 save、字段赋值、错误字符串和节点顺序。尤其 duplicate 分支原本不清理旧 approvedActionFingerprint / resumePendingAction，仍保持；approved 与 risky 分支的清理也保持。

## 等价证据

`tests/graph-guards-golden.test.ts`：

- 在原 Graph 上先跑 36 项 golden，exit 0（其中 35 个场景 + 1 个完整 Trace 摘要断言）。
- 新纯函数模块接线前跑 60 项，exit 0；Graph 仍使用原 predicate。
- 接线后相同 60 项通过；所有场景完整持久化事件 node / state 的聚合 SHA-256 保持
  `1936f41e6e820f37553572941301ef57cb7a46b250f59dd263180bc0ac68bb15`。
  只规范化 shadowContract.frozenAt 墙钟字段；不比较事件 createdAt / 性能计时。状态字段不筛选。
- 另有可读断言覆盖 status、error、approval 指纹 / URL / Signature、resumePendingAction、impact 历史、原始输入和实际 dispatch 数量。
- 覆盖 link 例外、button / checkbox / drag 风险、Enter / Return 与其他 keypress、重复优先级、验证后的 reset、旧授权 / URL / 签名漂移、批准 / 拒绝、failed / Task / Stage 上限、两个暂停边界有无 checkpointer、预算优先短路、unknown-effect 暂停和恢复不重放。
- 纯 predicate 直接测试无状态变更；焦点和观察签名保留原正则与字段选择。

## 命令与结果

日期：2026-10-14。全部为合成数据、FakeModel / FakeRuntime 或现有合成适配器及临时 SqliteTrace；localhost HTTP fixture 不连接真实服务。

1. `npm run check`：exit 0。
2. `node --import tsx --test tests/graph-guards-golden.test.ts`：原 Graph 36 / 36；接线前加直接 predicate 后 60 / 60，exit 0。
3. `node --import tsx --test tests/graph-guards-golden.test.ts tests/agent-loop.test.ts tests/focus-recovery.test.ts tests/desktop-recovery.test.ts tests/readonly-browser-acceptance.test.ts`：
   87 PASS / 1 环境失败，exit 1；唯一失败为 Host restart 的 localhost 请求被沙箱 EACCES 拒绝。新 golden 60 / 60 PASS。
4. `node --import tsx --test --test-name-pattern="B5a Graph|B5a P2|B5b Graph|desktop|file|Domain|domain|人工|Manual|manual" tests/rebind-completion-graph.test.ts tests/rebind-target-text.test.ts tests/verification-file-graph.test.ts tests/manual-review.test.ts`：
   51 PASS / 1 环境失败，exit 1；唯一失败为 Dashboard 人工验收 fixture 创建忽略的 frontend 资产被沙箱 EPERM 拒绝。
5. 获准在沙箱外定向重跑上述两个环境失败及模型预算门：
   `node --import tsx --test --test-name-pattern="Host restart|Dashboard 人工验收|达到任务内调用上限后" tests/desktop-recovery.test.ts tests/manual-review.test.ts tests/model-budget.test.ts`：
   3 / 3 PASS，exit 0。
6. `node --import tsx --test --test-name-pattern="production stage action fence" tests/readonly-browser-planning.test.ts`：
   1 / 1 PASS，exit 0，验证实际执行前 readonly gate。
7. `node --import tsx --test tests/task-controls.test.ts`：1 / 1 PASS，exit 0。
8. `node --import tsx --test --test-name-pattern="B5a mixed scalar pageTextIncludes: (missing|pass)|B5a ordinary structured: (pass|wrong value|missing target)|Graph rejects" tests/rebind-completion-graph.test.ts tests/verification-file-graph.test.ts`：
   7 / 7 PASS，exit 0，覆盖 B5a 混合 PASS / FAIL / UNKNOWN 及 File 错误内容和缺失 capture。
9. `git diff --check`：exit 0。

最终 HEAD 上再运行的 check / golden 证据见 PR 交付记录。初次 golden 编写阶段，2 个无 checkpointer 用例假设可正常返回，失败后按原实现的 MISSING_CHECKPOINTER 异常固定预期；2 个直接批准 predicate 测试漏传 observation，补齐合成输入后通过，均没有修改生产行为。

## POTENTIAL_BUG（单独诊断，本轮未修复）

原 Graph 无 checkpointer 且 pauseRequested 为 true 时，pause_check / pause_before_execute 先持久化 paused，然后 pause_interrupt 调用 interrupt 抛出 `No checkpointer set` / `MISSING_CHECKPOINTER`。两个基线 golden 明确 assert.rejects，并核对原暂停摘要和 Trace。若要更改此行为，需要独立 Issue / Review，不能夹入结构提取。

## NOTRUN / 停止线

按 Issue #90 和本轮指令，不跑 full offline / python / browser、无关大型 CI、真实模型或付费请求、第三方网站、Windows / VM / APP 实机操作。B5a/B5b 的真实全场景验收仍 NOTRUN；A5 safety FAIL、Windows PAUSED、overall INCOMPLETE 不变。

未改 Workflow Schema、Guest、Native、APP / composition 主线、verification / verifier、依赖、权限、预算或输入控制；PR #68 未改未合并。仅 Draft PR 交付，等待 exact HEAD 独立评审。不 merge、close Issue、Release、部署或进入 U9b / U10 / U11。

