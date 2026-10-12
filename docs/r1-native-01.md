# R1-NATIVE-01：原生无输入诊断

## TestBench 初始化：Low 构建产物标签，已做最小修复

2026-10-12，Owner 后续授权无输入定位 `0x8007045A`。原因已通过同 SHA 原生对照确认：
沙箱生成的 EXE 文件带 Low mandatory label（RID4096、policy=NO_WRITE_UP），
普通 Medium 调用者启动它后，实际子进程仍为 Low；此前 sameUser/非提升检查不能证明完整性级别相同。
独立 `GetTokenInformation(TokenIntegrityLevel)` 实测父8192/子4096，非 restricted、非 AppContainer，同用户/session/认证会话。
普通用户构建会话实测8192，沙箱构建会话实测4096。

原进程原生首错为 `win32u.dll!NtGdiInit2` 返回 FALSE，beforeError=0、即时 error=5。
随后清理的 `EtwEventUnregister` 将 error 从5变为6，`user32.dll` 的 DLL_PROCESS_ATTACH 返回 FALSE，
最终 CLR 启动以 `0x8007045A` 退出，未进入 Main，也未生成原 HWND；不能把后来的6当作首错。
扩大自有 Desktop HANDLE 到0xF01FF仍失败，说明此初始化问题与下文外部线程 GetThreadDesktop 的 HANDLE 对照不同。
[Windows MIC 的进程创建及访问规则](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control)。

关键反事实只改变受控副本文件的 mandatory label，EXE 字节、SHA、原 launcher、0xC3 Desktop、Job、启动参数均相同：
`4468a49fbfffe1a1667c01d47311838c3ef847fa71720a627e12d16a748684c0`。

| 同一普通用户会话，顺序启动 | 文件标签 / 实际子进程 RID | 原生结果 |
|---|---|---|
| 原 Low 产物（最终反例复验） | 4096 / 4096 | 无 HWND，退出0x8007045A |
| 同 SHA 受控 Medium 副本，第1轮 | 8192 / 8192 | 原 WPF HWND、PID/Job/session/Desktop 身份全部通过 |
| 同 SHA 受控 Medium 副本，第2轮 | 8192 / 未另采样 | 原 HWND guard、rect/class 查询通过 |
| 修复脚本重建产物，第1轮 | 8192 / 未另采样 | 原 HWND guard、rect/class 查询通过 |
| 修复脚本重建产物，第2轮 | 8192 / 8192 | 原 WPF HWND 身份全部通过 |

这五轮每轮均先确认 Default 恢复、Input Desktop=Default、原进程退出、Job排空、
process/Job/Desktop HANDLE关闭、OpenDesktopW NULL/error=2，再开始下一轮。
任务通道三项环境清空，不创建或连接 Task/Oracle pipe，模型/动作命令/输入均0。
先前一次外置继承句柄探针自身递归失败、未取得子进程，原清理NACK保留；
已停止重复，驱动退出后确认专属Desktop无残留，再进行后续实验，不能把后验恢复改写为该轮清理PASS。

最小修复只改 `testbench/build.ps1`：编译前拒绝 Low/未知完整性会话；编译成功后，
仅对刚从仓库源码生成的 EXE 设置 Medium 标签，设置失败则报错，不返回可用产物路径。
不递归重标记目录、不重置DACL、不修改 Desktop/Job 权限或运行时令牌。
Low 沙箱定向构建验证：明确拒绝且输出不存在；普通非提升 Medium 构建验证：实际文件标签8192/policy1，
重建 SHA `d2e8a37134b1cc31dc5f4b3407eb57dc65bd8d100b0e6af74ca14b11d0e209a3`，上述两轮被动启动通过。
[icacls 文件完整性标签命令](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls)。

本轮检查：check PASS；普通会话 `test:offline` 788/788 PASS（exit=0），
`test:python` 21个契约文件全部PASS，共享D0合成56/56 PASS。
首次沙箱检查保留：Python9个文件失败、D0有16个错误，包含本地socket WinError10013/文件替换WinError5；
沙箱offline出现等待超时后主动停止（非完成结果），确认运行器无残留后才在普通会话重跑。
本轮普通会话通过不改写此前784/788及4项超时的历史记录；未修改断言，也未跑浏览器或远端CI。

运行时原 HWND/PID/Job/session/Default 身份检查、Registry/InputControl/lease/预算全部保留。
**TestBench 原生初始化专项 PASS；R1 自主业务验收仍 BLOCKED**，第三次历史首错来源仍不能回填。
没有第四次完整Task、模型调用、其他应用扩展、合并/发布/Issue关闭；A5 safety FAIL / Windows PAUSED / overall INCOMPLETE保持。
原始探针、失败记录和生成资产仅留忽略的 `.artifacts/r1-init/`，不提交。

## 同一普通会话的历史 exact HEAD / 当前版对照

Owner 后续明确授权对照历史可用 HEAD `c189ff466d00759e86309584398e9adacdc62b3a`
（D0-D 收口）和修复 HEAD `563e5caaff33440819a290480cb628997d502d2e`。
两棵源码均未修改，复用各自的 Host → 原 Hidden Desktop/Job → netease_worker → 原网易云实例启动链；
外置只读追踪捕获原 API 返回值并保留即时 last-error，当前版另测原外部线程查询，不改变身份判定。
同一个普通、非提升、非 restricted-token Windows 会话内顺序完成9次启动，9次均 ready/isolation PASS，
commandsSent/modelCalls/agent_progress/human_actions均0，input=NOT_RUN，Default目标窗口数0。
每轮 process/Job/Desktop 实际关闭 ACK=true/error=0、Job active=0、原 Desktop OpenDesktopW NULL/error=2、
调用线程/Input Desktop=Default 确认后才开始下一轮；最终网易云进程数0。

**差异已经定位到调用进程对原 Desktop 持有的 HANDLE 访问条件，未出现旧代码到新代码的启动回归。**
旧 Worker/capture 现在仍能取得外部窗口线程的 Desktop，而同一原窗口由 Host 查询，在旧、新两版均失败5。
Windows 在 Hidden Desktop 启动进程时打开 MAXIMUM_ALLOWED；原 Host 创建/临时绑定的 HANDLE 仅0xC3。
只读 `NtQueryObject(ObjectBasicInformation)` 成功返回56字节，实测前者 GrantedAccess=0xF01FF，后者0xC3。

对同一个原 HWND/TID 的最后一对 helper 实验，旧、新 exact HEAD 结果完全相同。
helper 均加入原 Job，顺序启动、退出码0、关闭原 process HANDLE 后才继续；不创建窗口或发送输入。

| 固定来源与阶段 | 调用进程持有/线程绑定条件 | GetThreadDesktop 即时结果 |
|---|---|---|
| hidden-start / initial | 启动时关联原 Desktop，自动取得0xF01FF | 非NULL/error=0，实际名称匹配原 Desktop |
| hidden-start / thread-bound-default | 临时绑定Default的0xC3，仍持有原启动 Desktop HANDLE | 非NULL/error=0，返回原 Desktop的0xF01FF HANDLE |
| default-start / initial | 从Default启动，也属于原Job | NULL/error=5 |
| default-start / thread-bound-owned | 打开并绑定原Desktop的0xC3 | NULL/error=5；自线程查询正常 |
| default-start / maximum-handle-open-thread-still-limited | 仅额外打开原Desktop的MAXIMUM_ALLOWED，线程仍绑定0xC3 | 非NULL/error=0；返回值与额外打开的0xF01FF HANDLE相同 |
| default-start / maximum-closed-thread-limited | 确认关闭额外HANDLE，线程保留原0xC3绑定 | 再次NULL/error=5 |

这个5→0→5序列在两版均重现，证明单纯SetThreadDesktop与旧Worker启动条件不等价；
不是同用户/session、Job归属、模型、歌曲动作或Python ABI差异。
本次仅在自有临时 Desktop 的诊断 helper 打开额外权限，未改ACL、令牌或生产访问掩码。
生产最小修复继续使用0xC3与原生窗口成员证明，不改成MAXIMUM_ALLOWED。
未逐位穷举权限，也没有内核追踪；不把0xF01FF写成文档规定的最小权限，不推断内部访问检查算法。
[Windows启动关联Desktop时的MAXIMUM_ALLOWED规则](https://learn.microsoft.com/en-us/windows/win32/winstation/thread-connection-to-a-desktop)；
[GrantedAccess查询结构](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntqueryobject)。

保留探针局限：首轮当前版的额外Host identity读取曾失败，后续重复成功，没有推断其未记录的失败阶段。
初次helper在Default读取隐藏HWND的owner TID得到0，产生NULL/error=0，不能算实际原线程的证据；
同时NtQueryObject的64字节尝试返回长度不符。该轮保留，未计入上述有效对照；
修正为在原Desktop确认原TID、使用文档结构的56字节后才取得上述结果。
旧版成功的GetThreadDesktop调用有残留error=122（previousError同为122），因返回非NULL且随后名称读取成功，
不将其误报为失败；显式清零的独立helper对照返回error=0。

新证据仅覆盖网易云原窗口与共享身份路径，仍不能回填第三次R1的缺失来源。
TestBench的0x8007045A初始化阻塞、历史A5 safety FAIL / Windows PAUSED / overall INCOMPLETE及offline4项超时保持。
本轮仅更新证据页，生产代码仍为563e5ca；不重复与文档无关的全量CI。
原始运行和外置探针仅留忽略的 `.artifacts/r1-exact-ab/`；无P7/正式Task、第四次完整Task或模型调用。

## 后续授权：网易云 error 5 的原生证据与最小修复

2026-10-12，Owner 在本聊天明确授权结合网易云主窗口查清 error 5、保留身份/安全检查做最小修复并重验 Hidden Desktop 启动。
失败来源已确认：共享 `Api.identity` 把 `GetThreadDesktop(另一个进程的窗口线程)` 当作必经身份条件；
当前 Windows 在原窗口确实属于自有 Desktop/Job 时拒绝该获取，导致误拒。
原生首错为 `source=window-owner-thread, operation=GetThreadDesktop, phase=handle-lookup, winerror=5, handlePresent=false`，未进入名称/长度查询。
这份新证据来自网易云，不回填第三次 R1 的缺失字段。

同一个实际主窗口的对照：窗口进程就是原 launcher，实际窗口进程同用户、双方非提升、同 session、IsProcessInJob=true；
OpenProcess 的 limited-query/query/duplicate-handle 与 OpenThread 的 limited-query/query 均成功；
原 Desktop 的 READOBJECTS、既有 0xC3、GENERIC_READ、READ_CONTROL 查询均成功。
Python 原封装、重新加载 user32（Default/bound 两种上下文）及独立 C# P/Invoke 都对该外部线程返回 NULL/error=5，
而 C# 自线程查询成功/error=0。排除封装、基本查询权限、线程归属、同用户/session 和 helper 未绑定解释。
初轮只能确认当前现场的跨进程获取被 Windows 拒绝；后续同会话exact HEAD对照已将差异定位到上文的原Desktop HANDLE访问条件。
不推断 UIPI、ACL、保护进程或系统版本变化，生产不提升或修改 ACL。

最小修复只换 Desktop 身份证明的原生路径：调用线程实际 Desktop HANDLE/name →
`GetAncestor(GA_ROOT)` 的父链根窗口 → 同一 HANDLE 的 `EnumDesktopWindows` 成员证明。
它不使用预期配置名称代替身份，也不先失败再 fallback；根改变、部分枚举、FALSE/error=0、超出1024窗口上限均拒绝。
查询期间持有原进程/Job HANDLE，随后重查 HWND 存活、PID/TID 及 Job 成员，session 与 Default 禁止仍由原 guard 校验。
不属于本次 Job 的系统窗口不再进入外部线程 Desktop 查询，返回未获证 Desktop/in_job=false，无法通过 guard。
新诊断只增加固定 `window-query-thread/window-membership` 来源与 root/membership 阶段。
[EnumDesktopWindows 的真实 Desktop 成员契约](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enumdesktopwindows)；
[GA_ROOT 的父链语义](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getancestor)。

真实复验（全部只启动/查询）：

- 既有 D0 Controller/worker 的网易云启动 `ready=true, isolation=PASS`，连续5秒检查期间帧推进，Default 目标窗口数0；
  commandsSent=0、agent_progress=0、human_actions=0、input=NOT_RUN。停止后 Job 排空/Desktop 消失，cleanup=PASS。
- 同一原主 HWND 与原生 child guard PASS；错误 PID/session/Desktop 和 Default 线程查询隐藏目标均实际拒绝。
  外部线程 GetThreadDesktop **仍返回5**，说明成功来自新的原生身份证明，不是暗中加权限。
  helper/用户输入 Desktop 均恢复或保持 Default，OpenDesktopW NULL/error=2 严格确认清理。
  最终原 process/Job HANDLE 查询均 INVALID_HANDLE，原 CloseDesktop 实际 ACK=true/error=0；
  额外的关闭后旧数值句柄查询曾无法确认 INVALID_HANDLE，单独保留该探针失败，不将其当作原资源仍存或关闭 ACK。
- 诊断过程中曾有两次等待期内未取得音乐主窗口，保留失败；其中一次原进程 STILL_ACTIVE=259、Job进程数2，清理确认后才继续。
  首次反例探针因 Host 未绑定自有 Job view 而提前拒绝，不能算 guard PASS；修正探针后完整正反例通过。
- TestBench 同一固定EXE的被动复验仍在 HWND 前退出 `0x8007045A`，完整原资源清理通过；其初始化失败原因没有被本补丁解决。
  所以 **网易云启动/身份专项 PASS；TestBench/R1 自主业务验收仍 BLOCKED**。

检查：check、TestBench TS13/13、共享D0合成56/56 PASS；`npm run test:python` 的21个合成契约文件全部PASS
（含新增15项窗口归属正反例、TestBench31项及旧探针6项）。
`npm run test:offline` 已运行：784/788 PASS，4项 timeout/cancelled，exit=1，保留全套失败，不改为全绿。
未修改的失败项为 app-management 的 HTTP revoke（20秒）及 crash-dispatch 的3项子进程用例（15秒）；
exact baseline `66a49d5` 与补丁工作树的同文件同模式定向对照均5/5 PASS；没有在定向运行中重现，
不据此把初次全套写成通过或断言已查清这些超时原因；未重复全量套件或改断言。
未修改输入 allowlist、Registry fence、lease、60秒预算、模型/辅助开关、Host/Guest协议或 Workflow schema。
无网页改动，未运行 browser/远端CI或其他真实场景；未创建第四次完整Task，模型调用0、动作命令0，未保存业务数据。
完整新生成证据只留 `.artifacts/r1-error5/`，不提交 EXE、截图、UIA、原始窗口数据或私有路径。
新 exact HEAD 交 PR #68 等待 ChatGPT 增量独立 Review；不合并/发布/关闭Issue，历史安全/暂停/未完成结论保持。

以下为 `66a49d5` 的初次诊断历史记录，保留当时的 NOT_REPRODUCED/BLOCKED 结果。

2026-10-12；Owner [专项授权](https://github.com/zlpoot/agent-desktop/issues/51#issuecomment-6117732537)，
生产源码基线 `68501414c73f67ea53903761926f6f1e640ea7a0`。
结果 **NOT_REPRODUCED / BLOCKED**：未重现第三次 R1 的 `desktop_name_unavailable`，未确认其真实 HANDLE 来源，未做推测性生产修复。

独立 `scripts/probe-testbench-native.py` 复用 `Api` 和 `NativeBench.window_desktop/token_facts`，
不实例化 Registry、不连接任何 Named Pipe、不创建 Dashboard/P7 Task、不授予输入。
必须显式 `--real`；可选二进制必须在本工作区 `.artifacts` 下、文件名固定并匹配给定 SHA-256。
输出只含固定阶段/API/source、数值错误/requiredBytes、handlePresent、计数及布尔关系；无原始 HANDLE/PID/TID/名称、业务文字或异常消息。

## Desktop 查询的真实结果

普通、非提升、非 restricted-token 用户进程；Window Station=WinSta0（只保留布尔判断），
用户 Input Desktop 始终 Default。四次普通用户 Desktop-only 探针通过，包括最终版本的显式 Default 打开/关闭。
最初沙箱中的 `Api.desktop` 调用返回数值错误 5；退出沙箱后同一普通用户的 Desktop 创建成功。
这只能证明执行上下文差异，不能回填第三次 R1 的错误来源。

| 固定 source / 查询对象 | API / 阶段 | 即时 error / requiredBytes / handlePresent | 实际结果 |
|---|---|---|---|
| controller-before-bind / 显式 Default 与当前线程 | GetThreadDesktop / handle-lookup；GetUserObjectInformationW / size-probe、name-read | 线程正常获取 0；长度 122 / 16 / true；读取 0 / 16 / true | PASS，名称均匹配 Default；显式打开的 HANDLE 关闭 |
| input-desktop | GetUserObjectInformationW / size-probe、name-read | 122 / 16 / true；0 / 16 / true | PASS，用户输入桌面保持 Default |
| original-retained / CreateDesktop 原持有 HANDLE | GetUserObjectInformationW / size-probe、name-read | 122 / 96 / true；0 / 96 / true | PASS，匹配本次 owned Desktop |
| controller-bound | GetThreadDesktop / handle-lookup；GetUserObjectInformationW / size-probe、name-read | 0 / 不适用 / true；122 / 96 / true；0 / 96 / true | PASS，SetThreadDesktop 后匹配原 Desktop |
| controller-restored | 同上 | 0 / 不适用 / true；122 / 16 / true；0 / 16 / true | PASS，finally 恢复并重新确认 Default |
| window-owner-thread | 尚未到达 | NOT_RUN | 无 HWND，不能将其写成已排除 |

零缓冲区的 FALSE / 122 且合法 requiredBytes 是正常长度探测，随后真实 name-read 成功。
`Api.desktop` 内部未清除前次 OpenDesktopW 的错误，其成功的直接 GetThreadDesktop 后曾读到残留 error=2；
返回非 NULL，因此不能按该残留码认定获取失败。显式 `Api.thread_desktop` 会先清零，获取后为 0。
[长度探测契约](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getuserobjectinformationw)；
[GetThreadDesktop 的返回/借用 HANDLE 契约](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getthreaddesktop)。

## 被动 TestBench 启动阻塞与清理

从上述已审查源码以仓库 `testbench/build.ps1` 重建，EXE SHA-256：
`4468a49fbfffe1a1667c01d47311838c3ef847fa71720a627e12d16a748684c0`。
六次顺序被动启动，每次独立创建一个 Hidden Desktop/Job，通过现有 `Api.launch` 挂 Job 后 Resume。
任务通道环境三项在启动期间清空；`--task-channel` 仅满足入口启动条件，producer 构造因缺少配置直接返回，不创建 Task/Oracle pipe。

原进程同用户、双方非提升、权限兼容、同 Windows session 均为 true；helper 原 HANDLE 查询、绑定和恢复均成功。
最终 `IsProcessInJob` 明确返回本次原进程属于本次 Job；Job 终止、排空成功。
枚举未发现任何该 PID 的窗口，未取得原 HWND，窗口所属线程 Desktop、窗口 guard、rect/class **NOT_RUN**。
其中四次记录了 `GetExitCodeProcess=2147943514 (0x8007045A)`；最终版本在发现退出后停止轮询，枚举 2 次，ownedWindows=0。
该数值低位 1114 对应 [ERROR_DLL_INIT_FAILED](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--1000-1299-)，
但没有取得具体 DLL/初始化失败来源，不能据此认定 Desktop 权限、heap、WPF 或第三次 R1 的根因。
早先探针在启动前测试过 helper 绑定；按 `NativeBench.start` 顺序先启动再绑定后结果仍相同，排除该探针顺序差异。

每次创建的新资源均确认：调用线程恢复 Default、Input Desktop=Default；
Job active processes=0、原进程退出、process/Job HANDLE 关闭、原 Desktop HANDLE 关闭，
再用 OpenDesktopW 返回 NULL / error=2 确认名称消失。无清理 NACK，无并存的新临时资源。
探针清理各项独立尝试，任一失败保留 NACK，即使后续名称消失也不改写失败。

## 已排除、剩余差异与验证

本轮排除的是上述环境中本地/原持有 Desktop 名称查询、正常长度探测、线程绑定/恢复、
WinSta0/restricted-token/同用户/session 差异。尚未排除窗口所属线程的 GetThreadDesktop/name 查询。
与第三次 R1 的差异：本次新构建路径/hash、无生产通道/Registry/pipe 环境、被动启动在 HWND 前退出；
历史第三次已有 producer capture，不能把两次失败等同。下一项有价值的原生证据是本次自有 EXE 的具体初始化失败来源，
随后才可到达原 HWND 所属线程查询；当前证据不足以修复生产 Win32 包装。

定向验证：`npm run check` PASS；新增探针合成清理/错误脱敏 6/6、原 TestBench Python 31/31、
TestBench TS 13/13、共享 D0 合成 56/56 PASS。初次沙箱 TS 为 12/13（localhost EACCES），
D0 为 40/56（WinError 10013 / 临时文件替换 WinError 5）；普通用户下重跑相同定向套件通过，未修改断言。
按本轮禁止无关大规模 CI 的要求未重复全量 offline/Python/browser；无网页改动。

完整新生成记录仅留本机忽略目录 `.artifacts/r1-native-01/`；不提交二进制、私有配置或原始生成资产。
本增量只有独立探针、合成测试和本页证据，生产 Win32/TestBench/安全与预算代码未改。
等待 PR #68 新 exact HEAD 的 ChatGPT 增量独立 Review；完整 Task 仍 3/3 已耗尽，模型/输入/P7/正式 Task 均 0。
不合并、发布、关闭 Issue 或晋级 Workflow；历史 A5 safety FAIL / Windows PAUSED / overall INCOMPLETE 保持。
