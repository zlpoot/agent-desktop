# P7-A：环境应用 Registry、身份与状态机

日期：2026-10-07。基线：`main` `5ab1e55`（P6-C / #15）。范围：#17，父计划 #16。

状态：**P7-A PRE-REVIEW PASS，本地实现候选，待 PR materialization 与独立审查；尚未 ACCEPT，B–E 未开始。** P7 按 A → B → C → D → E 实施；P7-D 同时交付 Task 触发 onboarding 和可用的最小候选确认/未找到处理界面，不等 P7-E 的完整应用管理页。

## 身份与持久化

`EnvironmentAppScope` 固定 `providerId + environmentId + installationScopeId`。最后一项必须由可信基础设施提供，表达实际机器/VM 实体及用户安装域，不能用环境名称或 Worker 进程 nonce 代替。Physical 与 Local Workspace 可共享安装域，但各自绑定独立的 Registry、确认和启动验证。

SQLite 保存环境内 opaque `appBindingId`、安装实例 `installationId`、全局匹配用 `applicationId`、名称/别名、结构化 launchSpec、可选安装身份、来源、确认和验证历史。名称不是唯一键，同名多安装不合并；候选别名经确认后才用于名称匹配。名称解析返回 not-found / unique / ambiguous，unique 也不保证配置可复用。

`revision` 对每次状态写入做 CAS；`profileRevision` 只在候选配置变化/重新发现 stale 配置时递增。SHA-256 摘要包含精确环境/安装域、安装实例、应用身份/版本/fingerprint、展示名称/别名和 launchSpec，不包括采集时间。确认核对服务器当前 revision 和摘要，记录操作员与时间；重复或旧确认拒绝，不触发启动。

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

重新装配到不同安装域时，旧环境内非 revoked 配置一律 stale，旧 scoped Registry 句柄失效。安装域代次持久化并单调递增，即使旧域 ID 再出现，旧句柄也不会复活；旧确认同样不能自动复用。新域中的相同安装 ID 会得到不同 binding。历史快照保留每次 revision；撤销和安装域更换不删除历史 Task 或修改 Task 存储。

## 端口与装配

`EnvironmentAppDiscovery` 只读扫描/inspection，扫描结果区分 complete / incomplete / unavailable；`EnvironmentAppRegistry` 是可信操作员的配置写入端口；`EnvironmentAppLauncher` 是单独的有副作用启动验证端口，要求绑定 scope、profileRevision、摘要和 opaque permit 的许可。P7-A 没有扫描器、真实 launcher 或 permit issuer，Fake 测试也不发起进程启动。

composition 根据显式 `RootAssemblyOptions.environmentApps` 按精确环境装配端口，先核验 scope、拒绝重复环境和错配的 discovery/launcher。缺失环境或未配置环境均拒绝，无 Host fallback；Core 不按具体 Provider 分支。默认生产端口列表为空，不能把 discoverable environment 当成应用发现/启动可用。Root 拥有 `environment-apps.sqlite` 并在销毁/初始化失败时关闭；检查面板只输出服务名，不输出 Registry 内容。

公共 DesktopProvider、Executor/InputControl/Capability 分工、Guest 协议、Task/Workflow schema、预算和风险门未改变。Task 尚未消费新端口，launch-verified 不产生任何 capability evidence，也不开放 Physical generic 或任意 Local Workspace Task。

## 旧配置迁移

`importLegacyApps(rootDir, source, scopedRegistry)` 仅接受显式的 `apps.local.json` 或 `config/agent-desktop-apps.json` 来源，目标环境由可信装配绑定。不会自动导入、扫描路径或加入 Host built-in Notepad。只读取旧文件，不写回，也不复制 windowTitle/windowClass 成目标身份。导入结果为 discovered，无 identity、确认或验证成功记录；必须经过后续 inspection、确认和启动验证。

旧清单消费者继续使用原路径；P7-A 不切换执行消费者。未来迁移消费者后 Registry 才成为该环境唯一可写事实源，旧文件保留只读兼容，不双写。相同来源与旧配置 ID 的显式再导入保持绑定；路径/参数变化使新 profile stale。撤销后再导入拒绝，不复活信任。

## 验证与未覆盖项

定向 `environment-app-registry.test.ts`：15/15 PASS；包含 Host/两台 VM 隔离、Physical/Local 共享安装域但独立信任、多安装歧义、首次/重复确认、精确验证反例、路径/参数/版本/身份漂移、unavailable/stale/revoked、重启/安装域更换、双 SQLite 连接 CAS、运行态字段拒绝、结构化 launchSpec、模型字段投影、显式导入以及 Root 清理。

最终源码必需矩阵：`npm run check` PASS，`npm run test:offline` **615/615 PASS**（0 fail / skipped），`npm run test:python` **13/13 契约文件 PASS**，`git diff --check` PASS。最终运行日志为本机 ignored `.artifacts-p7-a-offline-release.log`、`.artifacts-p7-a-python-release.log`，定向结果为 `.artifacts-p7-a-targeted.log`。源码检查后仅更新此验证记录与提交元数据。无 UI/HTTP 修改，按 #16/#17 不额外运行 Browser。

全部新样本均为合成数据；未扫描实机、启动应用、发送桌面输入、控制 VM、访问第三方站点或调用真实模型。真实安装域身份采集、shortcut 安全解析、许可签发、启动适配器和 Task/UI 分别留在 B/C/D/E。自动化合同通过不等于产品实机可用；历史 A5 safety FAIL、Windows PAUSED、overall INCOMPLETE 不变。
