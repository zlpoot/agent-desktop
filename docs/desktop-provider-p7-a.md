# P7-A：环境应用 Registry、身份与状态机

日期：2026-10-07。基线：`main` `5ab1e55`（P6-C / #15）。范围：#17，父计划 #16。

状态：**P7-A REVIEW FIX / READY FOR INDEPENDENT RE-REVIEW。** PR #22 / Issue #17 的修复候选基于原 head `7eef2b8c33111448532bbb94eeee033c630e4759`，待独立复核；尚未 ACCEPTED / MERGED / P7-A COMPLETE，B–E 未开始。P7 按 A → B → C → D → E 实施；P7-D 同时交付 Task 触发 onboarding 和可用的最小候选确认/未找到处理界面，不等 P7-E 的完整应用管理页。

## 身份与持久化

`EnvironmentAppScope` 固定 `providerId + environmentId + installationScopeId`。最后一项必须由可信基础设施提供，表达实际机器/VM 实体及用户安装域，不能用环境名称或 Worker 进程 nonce 代替。Physical 与 Local Workspace 可共享安装域，但各自绑定独立的 Registry、确认和启动验证。

SQLite 保存环境内 opaque `appBindingId`、安装实例 `installationId`、全局匹配用 `applicationId`、名称/别名、结构化 launchSpec、可选安装身份、来源、确认和验证历史。名称不是唯一键，同名多安装不合并；候选别名经确认后才用于名称匹配。名称解析返回 not-found / unique / ambiguous，unique 也不保证配置可复用。

`revision` 对每次状态写入做 CAS；`profileRevision` 只在候选配置变化/重新发现当前代次的 stale 配置时递增。新配置的 SHA-256 摘要包含精确环境/安装域及其持久代次、安装实例、应用身份/版本/fingerprint、展示名称/别名和 launchSpec，不包括采集时间。确认核对服务器当前 revision 和摘要，记录操作员与时间；重复或旧确认拒绝，不触发启动。

launchSpec 分为 EXE、已解析本地快捷方式和包应用。参数数组及 workingDirectory 独立保存；不接受 shell 字符串。包类型只保留信息，P7-A 不实现包启动适配器。路径、身份 fingerprint 和验证 evidence 仅存在私有 Registry。`modelAppView()` 使用字段白名单，不返回这些内容，也不返回运行态。

运行态 sessionId、instanceId、PID/HWND、TargetBinding、observation 和 authority 不进入 Registry；候选、启动配置、安装身份及验证记录的额外字段会拒绝。配置跨普通重启保留，但不形成当前运行的许可。每次实际运行仍须重新核对环境、目标和身份，再经过既有 P6 capability/input 门。

## 状态转换

| 操作/事实 | 信任进度 | 配置有效性 | 可用性 |
|---|---|---|---|
| 新候选/显式旧清单导入 | discovered | current | available |
| 操作员确认当前摘要 | confirmed | current | available |
| 可信适配器记录精确身份及进程/窗口归属成功 | verified | current | available |
| 身份、版本、参数、路径或展示内容改变 | discovered | stale，需重新确认新候选 | available |
| 启动结果身份/归属不符 | 保留原进度与历史 | stale | available |
| 离线/权限不足 | 保留原进度与历史 | 保留 | unavailable，记录原因 |
| 临时可用性恢复 | 保留 | 不清除 stale/revoked | available |
| 撤销 | 保留审计 | revoked，后续写入/复用拒绝 | 保留 |

`requireLaunchProfile()` 只返回已确认、current、available 且 CAS 一致的配置。它不授予启动许可、输入权或业务能力。记录 verified 必须匹配确认后的 profileRevision/摘要/安装域以及实际 productId/version/fingerprint，进程和窗口归属两项均为 true；文件存在、windowTitle 或历史验证均不能替代这一结果。记录时间不得早于本次确认。

`installationScopeId` 本身不是 incarnation identity。私有数据库使用 `scope_revision` 表达持久安装域 generation，同时存入 `app_environments` 与 `environment_apps`。绑定唯一性/发现查找为 `provider_id + environment_id + installation_scope_id + scope_revision + installation_id`，代次既保护 Registry 句柄，也属于持久 binding 身份。字段不加入公共 contract、候选或模型视图，由 Store 从当前数据库身份确定。

安装域 ID 改变时，代次单调递增，只把刚离开的代次的非 revoked 配置标为 stale；普通进程重启或相同域重新 bind 不增加代次。A1 → B2 → A3 后，同一 installationId 必须生成新 `appBindingId`，不继承旧确认或验证。旧 binding 永久属于旧 generation，只保留作历史/审计；所有写入和 `requireLaunchProfile()` 都核对行上的 generation，即使 ID 相同也拒绝把旧 binding 重新 confirmed/current/reusable。原代次中的 revoked 仍拒绝再登记，但不封禁新代次中的同一 installationId。新代次的摘要也不同，旧启动验证记录不能提交为新代次的验证。

`list()` / `resolveName()` 只包含当前代次；通过明确 binding ID 的 `get()` / `history()` 仍可读取同环境的旧审计。旧句柄在安装域变化后永久失效，ID 再出现也不能复活。历史 binding/快照不删除，Task 存储不修改。

旧 P7-A schema 通过事务重建绑定表的唯一键并保留所有记录及 history。若环境仍是从未离开过的 generation 1，旧配置保留原 binding、确认和摘要；若环境已有代次变化而旧行无法证明所属 incarnation，则隔离到不参与当前查找的 generation 0，current 行追加 stale 审计，原因 `installation-generation-unproven`。旧 revoked 行保持 revoked；当前代次可重新生成新的 discovered binding。0 仅表示旧数据代次无法证明，永不作为活动环境代次。这是 schema 升级对不确定旧信任的处理，不是普通重启时重建安装域。

## 端口与装配

`EnvironmentAppDiscovery` 只读扫描/inspection，扫描结果区分 complete / incomplete / unavailable；`EnvironmentAppRegistry` 是可信操作员的配置写入端口；`EnvironmentAppLauncher` 是单独的有副作用启动验证端口，要求绑定 scope、profileRevision、摘要和 opaque permit 的许可。P7-A 没有扫描器、真实 launcher 或 permit issuer，Fake 测试也不发起进程启动。

composition 根据显式 `RootAssemblyOptions.environmentApps` 按精确环境装配端口，先核验 scope、拒绝重复环境和错配的 discovery/launcher。缺失环境或未配置环境均拒绝，无 Host fallback；Core 不按具体 Provider 分支。默认生产端口列表为空，不能把 discoverable environment 当成应用发现/启动可用。Root 拥有 `environment-apps.sqlite` 并在销毁/初始化失败时关闭；检查面板只输出服务名，不输出 Registry 内容。

公共 DesktopProvider、Executor/InputControl/Capability 分工、Guest 协议、Task/Workflow schema、预算和风险门未改变。Task 尚未消费新端口，launch-verified 不产生任何 capability evidence，也不开放 Physical generic 或任意 Local Workspace Task。

## 旧配置迁移

`importLegacyApps(rootDir, source, scopedRegistry)` 仅接受显式的 `apps.local.json` 或 `config/agent-desktop-apps.json` 来源，目标环境由可信装配绑定。不会自动导入、扫描路径或加入 Host built-in Notepad。只读取旧文件，不写回，也不复制 windowTitle/windowClass 成目标身份。导入结果为 discovered，无 identity、确认或验证成功记录；必须经过后续 inspection、确认和启动验证。

旧清单消费者继续使用原路径；P7-A 不切换执行消费者。未来迁移消费者后 Registry 才成为该环境唯一可写事实源，旧文件保留只读兼容，不双写。相同代次内，相同来源与旧配置 ID 的显式再导入保持绑定；路径/参数变化使新 profile stale。当前代次撤销后再导入拒绝；新代次重新导入产生新 binding，不继承旧代次的撤销或确认。

## 验证与未覆盖项

原实现定向 `environment-app-registry.test.ts`：15/15 PASS；包含 Host/两台 VM 隔离、Physical/Local 共享安装域但独立信任、多安装歧义、首次/重复确认、精确验证反例、路径/参数/版本/身份漂移、unavailable/stale/revoked、重启/安装域更换、双 SQLite 连接 CAS、运行态字段拒绝、结构化 launchSpec、模型字段投影、显式导入以及 Root 清理。

旧 head `7eef2b8` 的历史矩阵：typecheck PASS、offline 615/615、Python 13/13 契约文件 PASS。该矩阵没有覆盖 reincarnation 缺口，不能作为修复版的通过记录。

上一轮先新增最小红例，在旧实现上得到 **0/2 PASS**：正常 A → B → A 复用旧 binding ID；revoked 分支抛 `app-revoked`。日志为 ignored `.artifacts-p7-a-review-red.log`。修复后定向 Registry 合同 **18/18 PASS**，保留原有合同并新增：正常 reincarnation 隔离（含旧回执拒绝、持久行 generation 1/3、重启不增代次）、revoked reincarnation 允许新登记、旧 schema 的已知首代保留/不确定代次隔离及重开幂等。日志 `.artifacts-p7-a-review-targeted.log`。

上一轮必要矩阵只尝试一次：typecheck PASS，`git diff --check` PASS；offline 出现下列 3 个失败后按用户预先明确的停止条件中断，未完成全量，不给通过总数。Python 13 个契约文件中 7 个失败（6 个通过），退出码 1。没有认定为基线，也没有重跑或调整断言。停止后只记录证据和阻断状态，未提交或推送该轮修复。

| Offline exact failure | 位置 | 错误 |
|---|---|---|
| #18 模型适配器读取模型列表，并把目标和页面观察转换为单步动作 | `tests/chat-completions-model.test.ts:7` | `TypeError: fetch failed` |
| #26 在途接管完成后卸载必须向 Guest 撤权，再关闭本地数据库 | `tests/composition-root.test.ts:209` | `Worker control request not received`，断言栈 `:248` |
| #29 活跃 Session 随 Root 一起释放：轮询停止、控制关闭、无残留请求 | `tests/composition-root.test.ts:357` | `等待条件超时`，断言栈 `:55` / `:377` |

Python 失败文件：`guest-control-epoch.test.py`、`guest-recovery.test.py`、`guest-startup.test.py`、`guest-worker.test.py`、`local_workspace_test.py`、`test_file_evidence.py`、`test_local_workspace_provider.py`（均在 `tests/`）。日志记录了本地 HTTP 连接的 `PermissionError: [WinError 10013]`，以及测试临时目录中 `os.replace()` 的 `PermissionError: [WinError 5]`；这些是实际观测到的权限错误，不据此宣称 Registry 修复已全面通过。完整日志为 ignored `.artifacts-p7-a-review-offline.log` 与 `.artifacts-p7-a-review-python.log`。

Diagnostic & Recovery 由用户另行明确授权。先核验原 HEAD、dirty 文件与 ignored 证据，保留原修复 patch，不 reset/clean/覆盖重做。已有日志足够，因此没有为恢复失败输出而重跑。精确首个观测失败命令为 `npm run test:offline`，退出码 1（发现失败后中断，矩阵未完成）；首个失败为 #18 `tests/chat-completions-model.test.ts:7`，`TypeError: fetch failed` / `ERR_TEST_FAILURE`。该测试只连接自身创建的 `127.0.0.1` mock；旧 TAP 未记录 fetch 的嵌套原因。Python 首个失败为 `tests/guest-control-epoch.test.py:84` 的 `test_old_agent_cannot_input_after_human_handoff_and_new_agent_gate`，`urllib.error.URLError` 包装 `WinError 10013`，该命令退出码 1。

分类为 **D：环境/测试基础设施**。本轮最小处理是让合成合同测试在正常权限环境执行，解除 localhost 连接与沙箱临时目录文件替换限制；未改产品逻辑、测试 runner、断言门槛或 Guest/Host 协议。保留上一轮 Registry 修复，只给 generation 3 的普通 close/reopen 回归补强两项完整 confirmed snapshot 断言：`requireLaunchProfile()` 可复用，未变化的重新发现保持配置、确认、revision 与摘要；数据库 generation 仍为 3。既有 generation 1 重启回归和 migration 重开幂等检查也保留。

先运行 Registry 定向测试，通过后顺序运行一次必要矩阵。本轮最终结果（各命令退出码均为 0）：

| 命令 | 实际结果 | ignored 本地日志 |
|---|---|---|
| `node --import tsx --test --test-reporter=tap tests/environment-app-registry.test.ts` | 18/18 PASS，0 fail / skipped | `.artifacts/p7-a-recovery-targeted.log` |
| `npm run check` | PASS | `.artifacts/p7-a-recovery-check.log` |
| `npm run test:offline` | 618/618 PASS，0 fail / skipped | `.artifacts/p7-a-recovery-offline.log` |
| `npm run test:python` | 13/13 契约文件 PASS，failed: [] | `.artifacts/p7-a-recovery-python.log` |
| `git diff --check` | PASS | `.artifacts/p7-a-recovery-diff-check.log` |

正常权限下，上一轮 offline #18/#26/#29 和全部 Python 权限失败均消失，支持环境分类。本轮没有新失败，也没有重跑矩阵掩盖失败。无 UI/HTTP 修改，没有运行 Browser；没有追加实机验证。候选只请求 independent re-review，不代表产品实机可用或验收完成。原阻断评论仍保留作历史：[PR #22](https://github.com/zlpoot/agent-desktop/pull/22#issuecomment-6032549220)、[Issue #17](https://github.com/zlpoot/agent-desktop/issues/17#issuecomment-6032570473)。

全部新样本均为合成数据；未扫描实机、启动应用、发送桌面输入、控制 VM、访问第三方站点或调用真实模型。真实安装域身份采集、shortcut 安全解析、许可签发、启动适配器和 Task/UI 分别留在 B/C/D/E。自动化合同通过不等于产品实机可用；历史 A5 safety FAIL、Windows PAUSED、overall INCOMPLETE 不变。
