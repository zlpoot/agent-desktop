# P8-B 原生 issuer 第一个生命期切片：保留原进程查询句柄

基线：PR #35 合并 `main@a60f3ce32220c27330adbf44e1002acf4f21bc0e`。本项推进 P7 native issuer 的**原进程记录**，不开放 Task bridge。窗口 incarnation、实际 effect Producer、InputAuthority/Registry 逐效果栅栏和认证 revoke/drain ACK 仍未实现。#29/#27/#16 OPEN，#30/P8-C 不启动；A5 safety FAIL / Windows PAUSED / overall INCOMPLETE 不变。

## 生产代码边界

`guest/app_launch.py` 的 `WindowsProcessPin` 在已枚举候选 PID 上打开独立、不可继承的 `PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE` 查询句柄；不申请终止、写内存、注入或输入权限。读取原 handle 的 PID、精确 FILETIME 创建时间和映像路径，在查询前后用零超时 wait 核对该原内核进程仍存活。原 handle 退出/不可读就拒绝，不用该 PID 再打开另一个进程补映射。[OpenProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocess)、[WaitForSingleObject](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject)、[GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes)、[QueryFullProcessImageNameW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew) 为此处查询语义的官方依据；没有把文档或 mock 当成本机运行证明。

`OriginalProcessRecords` 持有原 pin 和原 profile/context/进程及窗口一致性事实。`instances` 在原 handle 检查之间重新读取安装版本/内容指纹、argv、实际 cwd、user/integrity、Windows Session/Desktop、窗口归属；实际 cwd 即使未指定也冻结在私有记录中，不增加到原 v1 receipt。同 reservation 的重复观察使用旧 token 和旧 pin，关闭新的重复查询 pin。`resolve_original_process` 只查询该 issuer 原记录及其 retained handle，不枚举、不重新按 PID/path/title 查找目标。返回事实的独立副本不是授权或可执行句柄。

成功的管理 release 保留独立查询 pin；原 owned launch 的 process/Job 释放算法不变。保留 pin 不让 user-owned process 变成 owned process，不保留 kill-on-close Job 或输入租约。不保留目标的 release、guard 漂移、release/cleanup 失败、新 reservation（包括 context 查询失败）、issuer close 关闭这些查询 pin，并永久废弃记录。状态未知的 CloseHandle 不重试：数值句柄可能已被复用；整个 pool 隔离，后续枚举/新 pin/启动准入被拒绝。

记录和废弃历史最多 128 个，不淘汰旧记录，不自动重新启用。已经观察到退出/身份变化/查询失败的记录永久失效；恢复旧字段不能复活。后续枚举或捕获失败也保守废弃全部旧记录，不能利用观察失败的间隔恢复旧来源。记录读取与 retirement 使用同一个 RLock，避免查询中关闭原 pin。**这是句柄资源同步，不是应用 revoke 与效果提交的串行栅栏。** 没有后台线程、自动监控或新的 native management RPC。

`resolve_original_target` 在原进程检查后始终返回 `app-original-window-lifetime-and-producer-unavailable`。即使 HWND、thread、title、desktop 和 owner 都相同，现有查询也不能排除两次检查之间的窗口销毁和同 HWND 重建；没有连续、无缺口的可信窗口 incarnation 观察。没有将原 handle 交给 Task Worker，没有打开 D0 的第二个目标补映射，没有声明 `appTrustFence`。

## 明确剩余边界

- 当前保留的是原进程内核对象及读时一致性快照；不证明映像加载字节未被修改、窗口连续生命期或真实效果原子性。原安装内容/mtime 检查的局限仍存在。
- 此私有 resolver 没有 transport、能力协商或认证 endpoint，也没有完成 Host handoff 到 native 原记录的跨进程汇合；原 v1 operation allowlist、Host/Guest v1、D0、Workflow schema 和 TS 核心接口不变。
- 对 Window/Event 观察与实际 Producer 的绑定必须另行源代码审查；在原生效果边界验证 Registry、exact original identity、InputAuthority/lease/epoch，认证排空 ACK、最后效果序列、最终 Registry revoke 和持久 revoked 墓碑仍待后续。
- 新 Windows API 路径只由合成端口验证，未对本机进程调用。真实 Local Workspace 配置、网易云音乐 3.1.40.205461 和原目标仍 NOT HUMAN VERIFIED / selection/target UAT PENDING。实机核验和运行都需分别明确授权。

## 无副作用 review 路径

1. 查看 `WindowsProcessPin`：句柄不可继承、只读查询权限、前后存活检查和原 FILETIME；退出后不重新 OpenProcess。
2. 查看 `instances` → `enroll` → `resolve_original_process`：原 profile/context 和原 pin 保留，解析不再次 process_iter；返回副本不能变更原记录。
3. 查看 release/new reservation/close/error 路径：关闭查询 pin，保持 user process 和原 Job 清理语义，未知 close 后不重试/重开。
4. 运行 `python tests/app-original-process.test.py -v` 和 `python tests/guest-app-launch.test.py -v`。全部 Win32、process、window、scanner 和输入端为合成模块/Fake pin，不初始化实机输入。
5. 查看 `resolve_original_target` 的固定 unavailable、v1 allowlist 不变，以及 Host `UnavailableAppTaskBridge` 未被提升；据此评审下一个窗口 incarnation/Producer 切片，而不执行真实应用。

规定矩阵：`npm run check`、`npm run test:offline`、`npm run test:python`。本项无网页变更，Browser 不运行。最终作者结果将在 PR 中按源码 head 报告；独立 Review 和远端 CI 不由作者合成结果代替。日志留在忽略的 `.validation/`，不提交生成资产、私有快照、数据库或凭证。

作者最终源码验证（2026-10-08）：TypeScript PASS；原进程定向 17/17、既有启动管理 16/16 PASS（合计 33/33）；offline 732/732 PASS，0 skipped；Python 16/16 契约文件 PASS。首次定向发现的隔离前置问题已修正并重跑；这些结果不证明 Windows 原生运行、窗口生命期或效果串行。独立 Review 待完成，远端 CI 未报告；不合并、不关闭 #29、不进入 P8-C。
