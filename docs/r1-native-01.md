# R1-NATIVE-01：原生无输入诊断

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
