# P7-C：首次确认、受控启动验证与配置复用

日期：2026-10-07。范围：#19 / Parent #16。基线：P7-B merge `2cafd7668386e2e59e0184c433169eacc9253139`。

状态：**PR #24 / CHANGES REQUESTED；R1 作者修复候选，待窄范围独立复审。** 初始本地候选 `432c846cc88e1413cf30daf9394cd9c87fa2abe6` 经另行授权已非强制 push 并交付 [PR #24](https://github.com/zlpoot/agent-desktop/pull/24)。没有 ACCEPTED / MERGED 或实机可用结论。Task onboarding、等待/恢复及最小确认界面留在 P7-D，完整管理页留在 P7-E。

## 可信确认

显式 composition 的 `launchBackend` 将同 scope 的 Registry、ReadonlyAppDiscovery、ManagedAppLaunchBackend 组成 `EnvironmentAppService.onboarding`。默认仍无应用启动环境。Core 没有 Provider 分支；公共 DesktopProvider、Task/Workflow schema、预算与 action/control/recovery/epoch 不变，Guest 仅增加单独协商的应用管理面。

`prepare({candidateId,candidateRevision})` 只读检查实际安装与服务器 P7-B 快照的 content fingerprint/version 一致，再登记 discovered。候选文件替换必须重扫，不能在原展示下默默接受新 binary。私有 discovery 快照新增 contentFingerprint，模型投影仍排除该字段。

返回展示包含名称、精确环境/安装域、来源、结构化 EXE/shortcut 路径/参数/cwd、版本、发布者和 `confirm-and-verify-launch` 副作用。未知元数据为 `unknown`。确认摘要覆盖展示内容、candidate ID/revision/digest 及当前 Registry revision/profileRevision/profileDigest。确认请求仅接受 confirmationId/digest；operatorId 来自可信调用会话。没有公共 Dashboard 写入路由，模型不取得管理端口；`confirmed:true`、路径替换、验证成功布尔值及额外字段不能授信。

等待确认不打开运行环境、不启动应用、不持有 Agent 输入租约。挑战有效期五分钟；最多保留 128 个挑战、512 个复用操作，超限拒绝。同 ID 的并发/重发复用同一 Promise，不新增确认或启动；候选/环境/摘要/操作员/CAS/安装域 generation 变化、过期、取消、撤销均拒绝。SQLite 保留配置与确认/验证，临时挑战和运行目标不持久化。

## 受控启动

`ControlledAppLauncher.authorize()` 从精确 scope 的 Registry 重读已确认配置，签发 issuer-local、单次消费的对象许可。复制或序列化 permitId 不授予权限。许可绑定 profile、CAS、取消信号与服务守卫；启动前后核验实际安装身份及启动定义。

Managed backend 使用独立窗口管理 reservation，可信装配必须注入既有资源/窗口策略守卫；不取得 Agent 输入 grant、不替代 Provider/InputControl。先检查已经运行的实例，要求唯一且有实际 image path/argv/cwd、安装身份、进程与窗口归属、执行用户、Windows Session、Desktop、运行 incarnation 证据。非唯一、另一 Desktop/Session、权限不兼容或归属未知时不猜窗口、不启动第二副本。

成功只保存当前 profile 修订的 launch verification；另外返回新的管理 Session/incarnation、opaque targetToken 和安装身份。没有 HWND/PID、observation、authority 写入 Registry。该目标不能直接充当 P6 TargetBinding/InputAuthority；后续 Task 仍须取得 Provider Session、重新 attach/observe，并经过目标/版本/角色 capability、readiness、风险、预算和输入门。launch-verified 不提升任何业务能力，Physical generic 和任意 Local Workspace 输入仍保持原限制。

## 环境适配和真实范围

- Physical：显式注入 `WindowsAppLaunchTransport` 后，固定 Python helper 以结构化 stdin、`shell:false/windowsHide:true` 运行。helper 派生实际机器/执行用户安装域，限定 `current-interactive-desktop`。R1 后原生启动必须有可信端侧 dispatch fence；当前 standalone Physical helper 没有窗口管理/revoke bridge，**新进程启动返回 `app-native-dispatch-fence-unavailable`，零 CreateProcess/ResumeThread**。只读检查与已有实例核验不因此启用输入；Host 的事前回调、stdin bool/staged permit 都不能替代端侧栅栏。默认 Root 不创建 helper、不扫描或启动应用。
- Guest：协商 `app_launch.protocolVersion=1 + scope`，使用独立 `/apps/launch` 管理面。必须显式配置 `AGENT_DESKTOP_ENABLE_APP_LAUNCH=1` 和至少 32 字符的 `AGENT_DESKTOP_APP_LAUNCH_KEY`；同时认证原 Bearer token 与独立管理 header。普通 Worker token 不足以登记/启动，管理凭据不注入模型/Viewer/网页。Host 从已确认 Registry staging，Guest 检查自己的安装并保存 stage/单次 permit；实际 start 仅接受服务器 ID，不接受 exe/shell。旧 Guest、错身份、未开启端口明确 unavailable，无 Host stat/fallback。原 lock 下要求 paused、无保留 owner、readiness 及相同 control revision/recovery epoch，不修改输入模式/租约。部署清单增加 helper，本轮未部署。
- Local Workspace：限制适配器仅接受可信 backend 与精确已有 NetEase 映射：`cloudmusic.exe`、空参数、未指定 cwd、已有限验收版本 `3.1.40.205461`。另外必须有独立 `OwnedWorkspaceAppLaunchBinding`，由可信 composition 从所选 Workspace 的实际 owned runtime records 查验；launch backend 自报上下文不能成为该绑定的来源。绑定须为既有 `WinSta0\AgentD0_*` Hidden Desktop、精确 scope/sessionId/instanceId/windowsSessionId，open 前后及实际实例/窗口证据、每次操作和移交均重查；缺失、Default、另一 Hidden Desktop/Session/instance 或 owner 更换明确不可用并 drain。拒绝 QQ音乐、未知应用、任意 EXE 和 package。D0 Python fixture 不属于本期 Win32 EXE profile，原有限场景仍由 P6 执行。本候选没有给 D0/P4 新增 native evidence bridge，也没有默认装配 Local launcher；缺少可信 managed backend 或 owned runtime binding 时明确不可用。合成后端只验证适配边界，不声称真实 hidden Desktop 新应用已能启动。

Win32 helper 复用 P7-B 安全 EXE/shortcut inspection；不走 shell、ShellExecute、提权、安装、任意 URI 或 Desktop fallback。binary identity 明确为内容摘要，不把路径或应用自报名称当产品证明；版本资源未知不伪造。运行进程核验实际路径、参数/cwd、创建时间、token 用户/Session/integrity 和窗口线程/Desktop/进程关系；进程早于磁盘 image 修改时间时拒绝旧版本证明。进程查询最多 4096 项/两秒、匹配实例最多 64；无法确定最终窗口归属的 launcher/多进程返回 unknown。

在可信端侧 dispatch fence 存在时，启动前以目标文件锁限制写入/删除共享，在当前明确 Desktop 创建 suspended process，先加入本次私有 kill-on-close Job，再 ResumeThread。栅栏从 effect 前进入，覆盖 CreateProcess 和 ResumeThread，yield 的当前 reservation check 在两个 effect 前重查；撤销必须使用同一锁，先赢得锁的撤销使零派发，已进入的有权派发结束后才 ACK 撤销。Guest 使用既有 native `RLock`（与 control/recovery 共用）并检查精确 reservation/control revision/recovery epoch；没有把 Agent grant 当 launch permit。窗口等待十秒，reservation 三十秒，单次传输三十一秒；没有循环 spawn。最终检查和 drain 成功后才显式移交进程、清除 kill-on-close，让已验证应用保留。失败/取消只清理本次 opaque owned token 对应 Job；不按名称/PID 批量 kill，不影响用户原实例。成功移交之后的取消不能倒退已完成的外部效果，旧目标仍不授权新动作。

API 参考：[Microsoft Window Stations and Desktops](https://learn.microsoft.com/en-us/windows/win32/api/_winstation/)、[Process connection rules](https://learn.microsoft.com/en-us/windows/win32/winstation/process-connection-to-a-window-station)、[pywin32 源码](https://github.com/mhammond/pywin32)。原生调用链未经 live launch smoke 验收。

## 复用、失败与清理

`reuse({appBindingId,expectedRevision,operationId},operatorId)` 走轻量安装检查、已有实例/启动检查及实际目标验证，不全量扫描或新增确认。operationId 绑定原 app/revision/操作员，重复幂等、冲突拒绝。路径/定义、版本/fingerprint、实质权限变更按 mismatch/stale 处理；离线、锁屏和资源占用为 unavailable，保留确认。恢复可用性不清除 stale/revoked 或安装域 generation。

未知启动结果由当前 profile 的 verification 历史保留未解决边界。后续仅观察核对，不盲目启动；中间 offline 覆盖 lastError 也不清掉该边界。只有当前 profile 的新实际 verified 回执解除它；新配置仍须重新发现/确认，旧版本业务 capability 不自动复用。

owned cleanup 失败也必须尝试 close/drain。未确认清理在 launcher/backend 保持 blocked，重复 reopen/acquire 不是 ACK。Root 销毁先取消/等待管理操作，尝试所有 backend close，再关闭 SQLite；未确认清理仍报告错误。没有新增清除 blocked 或重放未知操作的后门。

## 验证

定向：新增 TypeScript 启动合同 20 项、Python Fake native/管理/Guest HTTP 13 项；连同受影响 P7-B 发现，30 项 TypeScript 和 13 项 Python PASS。反例覆盖环境隔离、首次/并发/重复确认、零确认复用、候选替换/过期/取消/撤销/CAS、已有实例零多余 spawn、另一 Session/Desktop/用户、伪造 permit/字段/凭据、版本漂移、offline 恢复、未知边界经 offline 后不重启、owned cleanup 与失败阻断、持久配置/新运行态、Guest 协商。

实现期首次 TypeScript 定向为 16/18 PASS：cleanup 抛错会跳过 close，已修复为始终尝试关闭；另一个 Fake Guest 测试记录 `fetch failed`，受沙箱 localhost 限制。随后用正常权限验证受影响合成测试通过。后续新增边界与反例也通过定向检查，没有修改 runner、降低断言或放宽控制门。

首次全量 offline 为 **647/648 PASS、1 fail**，退出码 1。失败 `tests/local-workspace-scenario-task.test.ts:319`（`uncertain dispatch and failed cleanup cannot materialize a completed Task`）期望 `acts=1`，实际 `0`，耗时 3210ms；原日志保留为 `.artifacts/p7-c-offline-initial.log`。原轮没有记录 Task error，不能确定那次的具体原因。只跑该反例并记录状态时通过，记录到了原本期望的 uncertain dispatch 与 cleanup failure。

诊断在未修改 P7-B 的同一反例中注入 2.05 秒持久化延迟，得到 **0/1 PASS**、相同 `0 !== 1`，并记录 `fresh-observation-or-single-run-required`，证明该测试依赖真实两秒观察窗口、会受持久化延迟干扰。该人工延迟复现不冒充原轮错误的直接证据。只为这个 dispatch/cleanup 合成合同固定 monotonic clock，并另加显式推进到 2001ms 的过期拒绝反例；原 production 2000ms observation deadline、3000ms input lease 和全部断言不变。修订后带相同真实延迟的两项定向测试 **2/2 PASS**，新观察可派发、旧观察零派发。没有给产品延长时间或放宽安全门。最终源码重新运行必要矩阵，原失败不删除或改写成通过。

初始候选 `432c846cc88e1413cf30daf9394cd9c87fa2abe6` 必需矩阵（HTTP 管理增量亦由 Fake Guest 合同覆盖）：

| 命令 | 结果 |
| --- | --- |
| `npm run check` | PASS，退出码 0 |
| `npm run test:offline` | 649/649 PASS，退出码 0 |
| `npm run test:python` | 15/15 contract files PASS，`failed: []`，退出码 0 |
| `npm run test:browser` | **53/54 PASS、1 fail**，退出码 1 |

Browser 首次运行因新工作树缺少浏览器缓存而中断，日志保留为 `.artifacts/p7-c-browser-initial.log`，不算通过。指定项目已安装的 `PLAYWRIGHT_BROWSERS_PATH` 后完整运行，日志为 `.artifacts/p7-c-browser-configured-initial.log`；没有下载/升级浏览器、改 runner 或跳过用例。唯一失败为 `tests/workflow-library.test.ts:159` 的 `download.saveAs: canceled`，最终候选定向重试同样 **0/1 PASS**。未修改的 P7-B 工作树 `39a7706a91b734b960255bc6fc0f4a2e88ef6733` 定向复现相同错误；相关测试与报告代码和 P7-C 基线一致。[P6-C 记录](desktop-provider-p6-c.md)亦保留了同一遗留失败。原因未确定，下载仍未修复，Browser **不全绿**；本候选没有改报告代码或削弱测试。

全部样本为合成数据/本地夹具，没有私有快照、真实账户浏览器状态、数据库、凭据或实机应用输入。历史 **A5 safety FAIL、Windows PAUSED、overall INCOMPLETE** 不变。

## R1：只修复独立评审两项 P1（2026-10-08）

正式行内评论：[Physical authorization TOCTOU](https://github.com/zlpoot/agent-desktop/pull/24#discussion_r4213392300)、[Local Workspace false VERIFIED](https://github.com/zlpoot/agent-desktop/pull/24#discussion_r4213392307)。

- P1-1：RPC start 在异步 staging 完成后重新检查窗口管理许可；原生 launcher 移除默认 no-op 派发守卫，要求有权撤销序列化的端侧 context-manager fence。当前 Physical standalone 缺桥接时明确拒绝新进程启动；不以随后 cleanup 代替 effect 前授权。Guest 栅栏复用原 lock 和精确 reservation，不改变 action/control/epoch。
- P1-2：Local 适配器与独立可信 owned Workspace 绑定逐项核验，backend context 与 instance 都指向 Default 也拒绝，不能仅因二者相同而 verified。缺失 owner binding 在 backend open 前拒绝；owner 漂移不移交目标，清理仍仅针对本次 owned token。

定向回归：TypeScript 27/27 PASS（新增 7 项）、Python 16/16 PASS（新增 3 项）。覆盖 staging 期间撤销零 start RPC、无 native fence 的 staged Physical permit 零进程派发、撤销先入栅栏零效果、栅栏覆盖 CreateProcess/ResumeThread 直至 revoke ACK、双 Default/另一 Hidden Desktop/另一 Session/另一 instance 的拒绝、缺绑定零 open、正确 owned Hidden Desktop 正例及观察时 owner 更换清理。未执行实机 smoke。

R1 验证结果：

| 命令 | 结果 |
| --- | --- |
| `npm run check` | PASS，退出码 0 |
| `npm run test:offline` | 656/656 PASS，0 fail/skip，退出码 0 |
| `npm run test:python` | 15/15 contract files PASS，`failed: []`，退出码 0；启动文件 16 项均通过 |
| `npm run test:browser` | **53/54 PASS、1 fail**，退出码 1；同一遗留 `download.saveAs: canceled` |

原始 R1 日志为 `.artifacts/p7-c-r1-*.log`。check/offline/Browser 对修复后的 TypeScript 源码各执行一次必要矩阵。最后将 Guest 管理口初始化移入同一原生锁，并补 HTTP 断言验证实际 lock wiring，避免并发初始化使 fence 绑定另一 manager；变化仅影响 Python，重新运行受影响的 Python 合同矩阵，前后均 15/15 PASS，上一轮保留为 `p7-c-r1-python-before-lock.log`。未重复无关矩阵。初次 check 暴露新增夹具对 readonly 字段赋值，已改为替换合成 owner 快照，不改运行契约；原 FAIL 日志保留为 `p7-c-r1-check-initial.log`。

Browser 没有新增失败；本次唯一失败仍在 `tests/workflow-library.test.ts:159`，错误特征与已有 P7-B/原候选原始对照一致，相关 test/server blob 仍相同。没有修改 Browser 下载实现、断言或 runner，不重跑已独立核对的旧基线、不堆叠额外 Review/Verify 全量门。未执行实机 smoke，Physical 缺端侧桥接时的新启动与 Local 缺可信 backend/owned binding 时的使用仍不可用；历史安全状态不变。修复交付后停在 Independent Review Gate，待两项 P1 窄复审；不 merge、不关闭 #19、不启动 P7-D，不自行 resolve 正式 Review thread。
