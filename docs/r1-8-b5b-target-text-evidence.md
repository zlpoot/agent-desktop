# R1.8 / B5b / P2：rebind target.text 定位证据

日期：2026-10-14（Asia/Shanghai）。Refs #88。状态：**AWAITING_INDEPENDENT_REVIEW**，作者执行不等于独立评审通过。

## 基线和范围

- 实际 `git -c http.proxy= -c https.proxy= -c http.version=HTTP/1.1 fetch origin main` exit **0**；`git rev-parse origin/main` 为 **bcba3992afc97f489baa89e3e87ca419e04d639d**，没有基线漂移。
- 独立 worktree：`E:/projects/agent-desktop/.worktrees/b5b-p2-target-text`；分支：`codex/b5b-p2-target-text`。
- 先红提交：`acc109393824f59250eb923baea78d092851cc81`。最终精确 HEAD 由 Draft PR 和 Issue #88 交付评论记录，避免文档在自己的 commit 中自引用。
- 唯一生产变更：`src/verification/structured-rebind.ts`。另有新定向测试和本文；Graph、统一 Verifier、Observation/Workflow/Guest/API schema、UI、Provider、输入能力、模型、预算和依赖没有修改。

## 真红例：已通过完整因果链，但绑定的是错误目标

冻结 target 的 role 为 Edit、text 为“目标 A”。DOM 条目的真实 text 为“目标 B”；UIA 的 raw name 为“目标 B”（同时提供一个不能作为可信来源的 JSON text:“目标 A”）。字段值和保存后回填值均正确，不能替代目标身份。

三条 helper 用例和两条 FakeModel/FakeRuntime/SqliteTrace + createAgentLoop Graph 用例，从空 rebindState 实际走过：

```json
{
  "baseline": {"sequence": 1, "runtimeId": "r0", "value": "before"},
  "editedSequence": 2,
  "committedSequence": 3,
  "absentSequence": 4,
  "rebound": {"sequence": 5, "runtimeId": "r1", "value": "after"},
  "terminalSequence": 6
}
```

UIA runtimeId 仍按原规则 JSON.stringify，示例 r0/r1 在其状态里带 JSON 字符串引号；身份规则没有调整。Graph 四次输入仅为合成 type、CTRL+S、ESC、CTRL+O；随后模型声明 done。没有预置成功链，没有启动真实桌面/浏览器。

旧实现丢弃 text，只按 role/name 定位：helper 得到 **PASS**，两条 Graph 均 **done / goalVerification.ok=true / acceptanceReport=pass**。这是合成复现，不是 Windows 实机复现。

```powershell
$env:B5B_EVIDENCE_DIR='.artifacts/b5b/red'
node --import tsx --test tests/rebind-target-text.test.ts
```

生产代码仍是旧 main：exit **1**，**5 tests / 0 pass / 5 fail / 0 cancelled**。该先红提交可以直接重跑。日志 `red.log` 和 red/*.json 保留所有原始观察、链状态和 Graph/SQLite/events/派发动作。

编写测试时曾将 Graph 用例误放入 helper 内，产生 3 fail / 6 cancelled；已纠正其位置，原始日志保留为 `red-iteration.log`，不把取消当作成功的 Graph 复现。

## 来源和最终匹配规则

核对了实际代码：`src/runtime/browser/dom-collector.ts` 生成本节点 text、identity 和 complete；Playwright/Raw CDP 观察对 structured 通道盖章。`src/runtime/desktop/worker.py` 提供 UIA JSON 的 raw name、runtimeId、nameComplete/valueComplete；`structured-state.ts` 的现有 UIA 兼容路径明确使用 `text:item.name`。

- **DOM**：仅保留 `structured.items[].text`，要求 DOM structured 来源/通道完整、节点 identity 存在、节点 complete=true。缺 text、缺完整性或显式 textComplete=false 保持不可验证。Host 不用 name、value、pageText 或 banner 补 text。
- **UIA**：text 从 raw name 映射，只有 nameComplete=true 才能证明此文本完整；独立 JSON text/value 不作为目标文本。仍要求 UIA dom 通道完整、enumerationComplete 及已有 runtimeId。没有修改 Worker/协议。
- **role/name/text 全部配置项是 AND**。role 沿用不区分大小写的原规则；name 沿用精确比较，未放宽 name-only；text 沿用普通结构化检查的空白规整后比较。
- 定位区分确定匹配、可信明确不匹配、属性无法读取。一个可能匹配但文本不可读的同角色候选同时阻断“唯一命中”和“缺席”；已知 name/role/text 的不匹配可排除该候选。多个确定匹配仍 target_ambiguous。
- baseline、编辑、提交、缺席、R1、最终回读使用同一个 raw matcher；不可读时不冻结基线、不推进该次阶段，特别是**不会写入 absentSequence**。只在可信完整枚举证明实际目标缺席时沿用原缺席逻辑。
- 最终 rebind 裁决使用调用方要求的证据 source；不再因观察自推断成另一独立来源而放行。

RawControl 的 text/textComplete 和 locateTarget 的 unavailable 是模块内解析/定位结果，不写入 rebindState；**持久化状态 schema 没有新增字段**。原 R0→编辑→已派发提交→缺席→不同身份 R1 的序号与身份规则不变。

历史 checkpoint 不因已有 R0/R1 序号和值直接 PASS：终态必须重新按完整 target、当前可信来源/完整性和同一 R1 身份定位。测试把 name-only 状态 JSON 序列化后回读：匹配当前完整 target 才可继续原验收；text 错误/不可读、来源失配、身份不符均 UNKNOWN；唯一可信 R1 的 value 明确错值仍 FAIL。本轮不伪造历史文本证明或为旧链重新冻结子合同。

## 定向矩阵与绿证据

新文件共 **60 项**，其中 6 项是真实 Fake Graph（DOM/UIA 各覆盖正确、错误 text、不可读离开），其余使用合成原始条目和真实 rebind 链函数：

| 场景 | 结果 |
| --- | --- |
| text-only / name+text 同时正确，完整链 | PASS；时序仍为 1→2→3→4→5，终态 6 |
| role/name 满足但 text 错、role/name 不符 | UNKNOWN，不冻结错误基线，不按正确 value 放行 |
| text/name 缺失、完整性缺失/false | UNKNOWN；不把缺证变为反证或缺席 |
| 提交后的同角色条目 text 不可读，随后出现 R1 | absentSequence/rebound 均未形成，UNKNOWN |
| 编辑/提交/R1 阶段 text 不可读 | 对应本次阶段不推进 |
| 同角色不同 text、仅靠 text 可唯一识别 | 正确绑定目标，PASS |
| 重复目标 / 不可读竞争者 | target_ambiguous / UNKNOWN |
| 确定 name 不符的无关候选 text 不可读 | 不妨碍真实唯一目标 |
| 历史 checkpoint + 当前匹配/错 text/缺 text/错来源/错身份/错值 | PASS / UNKNOWN / UNKNOWN / UNKNOWN / UNKNOWN / FAIL |
| 原 name-only 精确匹配、旧 R1 错值/未提交/未离开 | 保持原 PASS/FAIL/UNKNOWN |

两条 Graph 红例转绿为 waiting_user / goalVerification false / UNKNOWN；正确链仍 done/PASS；缺 text 的假离开不会生出持久链。Graph result、SQLite latest、acceptance_task 都保持终态 seq6，report.observationId 等于 normalizeEvidence(该观察)，四次输入无重放。

## 实际命令与结果

`npm run check`：exit **0**，`check.log`。

```powershell
$env:B5B_EVIDENCE_DIR='.artifacts/b5b/green'
$env:B5A_EVIDENCE_DIR='.artifacts/b5b/b5a-regression'
node --import tsx --test --test-concurrency=1 tests/rebind-target-text.test.ts tests/verification-structured-rebind.test.ts tests/rebind-completion-graph.test.ts tests/structured-acceptance.test.ts
```

exit **0**，**128/128 PASS**：B5b 60 + 原 rebind 8 + B5a Graph 49 + 普通 structured acceptance 11；`core-green.log`。包含 B5a 全冻结条件、Domain/FACET、来源、Manual、Stage、resume/checkpoint、终态 ID/同捕获及不重放证据。

```powershell
node --import tsx --test --test-name-pattern='dom rebind chain|same identity without navigation' tests/browser-form-rebind.test.ts
```

exit **0**，**4/4 PASS**；仅既有 DOM 合成条目，`dom-regression.log`。没有运行该文件中的浏览器启动用例。

```powershell
node --import tsx --test --test-concurrency=1 --test-name-pattern='Pinned file Workflow task gate: current file intact|Pinned file Workflow task gate: file modified|production graph closes a frozen readonly final stage|达到任务内调用上限' tests/verification-file-graph.test.ts tests/readonly-browser-acceptance.test.ts tests/model-budget.test.ts
```

exit **0**，**4/4 PASS**；`gates-regression.log`。只执行 File 正/反硬 Gate、Fake readonly 完成和预算派发前暂停，不启动浏览器、VM、APP 或 HTTP 模型。

最终三个成功批次共 **136 个不同用例**。开发中 `matrix-green.log` 为 54/54（扩充角色/名称/来源负例之前），不冒称该批次已跑 60 项。

NOTRUN：完整 `npm run test:offline`、`npm run test:python`、`npm run test:browser`、大型 CI、真实 Windows/APP/VM/浏览器输入、第三方站点/付费模型、U9/U10/U11。按 Issue #88 执行以上少量定向文件和明确白名单，不扩大实验范围。

## 交付与停点

忽略目录 `.artifacts/b5b/` 保存红/绿完整观察、链、Graph result、SQLite latest、events、派发动作、B5a checkpoint 及命令日志；SHA256 manifest 在交付时生成。没有导入私有快照/数据库/浏览器状态；SQLite 都是测试新建数据，生成资产不提交。

仅交付独立 Draft PR，使用 Refs #88。新精确 HEAD 等待 ChatGPT Chat 独立 Review；不自动 merge/close/release/部署，不修改 PR #68，不启动后续阶段。**AWAITING_INDEPENDENT_REVIEW；A5 safety FAIL / Windows PAUSED / overall INCOMPLETE 保持。**
