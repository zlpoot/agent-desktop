# P8-B B4：原 issuer 的只读 producer 预绑定候选

依据 [#29 最新 B4 安排](https://github.com/zlpoot/agent-desktop/issues/29#issuecomment-6057899476)。
基线：`6b0e63ae06055674b6bb45f1e085f30e13ffa01e`（PR #36）。

本次提供实际运行时代码与合成负例，交由用户独立 Review。**B4 的同目标原生闭包仍 BLOCKED**，本候选不代表 B4 trusted binding 验收，不进入 B5。
`A5 safety FAIL / Windows PAUSED / overall INCOMPLETE` 保持。
Workspace 配置、NetEase 3.1.40.205461 及原实例均未 HUMAN VERIFIED。

## 当前拓扑的源码依据

| 路径 | 实际语义 | 无法推出的身份关系 |
| --- | --- | --- |
| `guest/app_launch.py` | P7 `WindowsNativeLauncher` 保留原进程 query-only handle；context 固定 Windows Session/Desktop/helper incarnation；管理 v1 的 reserve/stage/start/observe/release 不变 | 保留进程对象不证明原窗口 create/destroy 连续性，也未保留可移交 D0 的原 Job/producer |
| `src/desktop-provider/local-workspace-provider.ts` | `openWorkspace()` 调用 `backend.start(config)`；D0 子进程在握手后产生新的 Task Session 和 `instanceId` | Host handoff、Session 字符串相同或路径相同不能将独立 D0 run 变为 P7 原实例 |
| `spikes/local-workspace/provider_worker.py` | `start()` 自建 real Controller 并调用 `Controller.start()`；`current_target_id()` 对 `target.json` 的 PID/HWND/desktop/session 做哈希 | 文件和哈希没有同 issuer 证明；这个 bridge 不是实际 OS 输入线程 |
| `spikes/local-workspace/host.py` | `Controller.start()` 创建 `AgentD0_<run>` Desktop、Job，启动新的 `worker.py` 或 `netease_worker.py` | 无法接收 Physical helper 的原 Desktop/Job/window；不能用一次新的 launch 代替原 target |
| `spikes/local-workspace/worker.py` / `netease_worker.py` | OS worker 加入 D0 Job/Desktop，随后再次 `api.launch()` 应用；NetEase 还按 Job/window class 枚举 target | 这里持有的是 D0 自己启动/观察的对象，并未消费 P7 原 issuer 的保留对象 |
| `spikes/local-workspace/input_engine.py` / `netease_input.py` / `win32.py` / `uia.py` | 真实 worker 上 `type_text`、`SendMessageTimeoutW`、UIA 等提交效果 | 本次 bridge 只读记录不在这些提交点，不能充当 effect fence、producer drain ACK 或输入授权 |

Standalone P7 helper 的实际 Physical context 与 D0 新建 Desktop 尤其不兼容。既有窗口不能靠更改 worker 的 thread Desktop、匹配 HWND/PID 或第二次 attach 来变成另一个 Desktop 的原窗口。
`src/environment-apps/task-bridge.ts` 保留 `app-task-native-issuer-resolution-and-revoke-fence-unavailable`。

## 本次代码边界

`OriginalProcessRecords` 为每个原进程记录增加有界的 `windowGeneration` 和最多一个 opaque prebinding。
沿用最多 128 条原记录及终止墓碑，不驱逐、不复活；返回的空 `object()` handle 只在该 issuer 的 live pool 内按对象身份解析。

`WindowsNativeLauncher.prepare_original_prebinding()` / `read_original_prebinding()` 是 **Python 进程内私有只读 API**：

1. 使用既有原 token/profile/context 解析保留进程，绝不枚举或 reopen 替代进程。
2. 读取 admission 之前不建立候选；只有明确 `True` 才继续诊断，False/异常/模糊值会终止原记录。
3. 候选固定确切 Task port、producer port 和 admission port 对象及其快照，反复读取并在每个读边界检查原进程/窗口一致性。
4. Task 快照严格采用既有五字段 `DesktopSessionIdentity`：providerId/environmentId/sessionId/instanceId/inputResourceId，没有新增 Core 字段。
5. producer 报告只包含桥接 incarnation/run/backend/session/target 的诊断数据；Controller 对象发生已观察替换后永久拒绝，恢复旧对象不能 rearm。
6. 端口替换、已观察事实漂移、已提交拒绝、读失败、后续 reservation、窗口负面通知、close 均失效。原进程 close 未确认会封锁整个 pool，绝不重复关闭可能复用的数值句柄。

版本为 `p8-b-original-prebinding-v1`。返回快照是副本，无 handle、grant、执行方法或 WorkerClient。
任何正常读结果 **固定** `status: unavailable`，附带三项 blocker：

- `window-lifetime-unavailable`
- `same-issuer-producer-unavailable`
- `authenticated-admission-channel-unavailable`

即使端口声称 sameIssuer/continuity PASS，或字符串完全相同，读结果也没有升为 ready 的分支。
不存在 Host Session/admission 的已认证跨进程接线；测试中的端口仅为 Fake。callback `True` 不能替代来源证明或事务 fence。
这个 API 尚无生产调用方；它是下一次最小生命周期重构的只读、失败封闭接缝，不是 P7→D0 已连通的桥。

`ProviderWorker.original_issuer_prebinding_facts()` 是同样私有的 `p8-b-d0-topology-v1` 报告，明确 `independent-d0-launch / sameIssuer: False`。
只读取内存，不调用 start/stop/attach/identity_facts，不触碰 Win32、不读取 target 文件；不在 stdio dispatcher 中注册。
旧 Host/Guest v1、P7 同步 revoke、Workflow/Core、InputAuthority、预算与 generic fallback 均未改动。

## 窗口连续性：明确 unavailable

`windowGeneration` 只是 issuer 本地记录/墓碑身份，不是 Windows 原窗口寿命凭证。
没有安装 create/destroy hook，没有宣称初始订阅先于原窗口创建，也没有宣称 callback 排序、观测缺口或 Worker 重启已闭合。
`invalidate_window(token)` 只允许负面失效；测试用它模拟 destroy/reuse、gap、late subscription 后的不可恢复退休。
遗漏在两次轮询之间的 HWND 销毁/复用即使不可见，正常快照仍固定 unavailable。无 event/polling API 可以写入 PASS。

## 最窄后续重构（本 PR 不执行）

1. 把 D0 `Controller.start()` 的资源准备与应用 launch 分开：先创建固定 Desktop/Job/OS worker 生命周期，不启动另一个应用。
2. 将 P7 原 issuer 的 stage/permit/start/observe 放入该确切 OS worker 生命周期及正确 Desktop，首次且唯一 launch 保留原进程/Job，不能复用旧 Physical issuer 的窗口再搬运。
3. 在原窗口产生前建立可证明有序的 native create/destroy observer；固定 observer/worker/issuer incarnation，初始接线失败、迟到、缺口、销毁或重启均退休该 generation。若不能证明排序与缺口检测，继续 unavailable。
4. 用独立、版本化私有管理通道绑定确切 Host Registry/Task Session/denial generation 与 native issuer/producer，显式处理 incarnation 与 late reply；不能把本次 Fake callback 或现有 `target.json` 当可信通道。既有 v1 不扩字段。
5. 只读同目标闭包通过独立 Review 后才进入 B5 的真实效果提交 fence 与 durable denied-pending→authenticated drain ACK→Registry tombstone；本 PR 不提供执行注册或 ACK。

每一步需要另外的源码实现与评审。停止在当前只读候选，不能将这些计划计作已完成能力。

## 作者验证与独立 Review

仅合成数据、Fake pins/ports/Win32，不启动真实应用、VM、模型，不加载私有数据库/快照或浏览器状态。
`tests/app-original-prebinding.test.py` 覆盖 18 个定向用例，包含真实 SQLite **合成库** commit/reopen 后 denied-pending 优先于绑定，但不声称这就是 Host Registry 的跨进程 admission channel。
PR 记录 exact head、生产 diff、完整 check/offline/Python 结果及两个进程内故障注入的预期失败证据。
没有网页或 HTTP route 变动，不要求 Browser；旧 dispatcher 拒绝新的私有 API operation 有专门回归负例。

作者验证不等同独立 Review。#29 / #27 / #16 保持 OPEN；P8-C #30 planned/blocked。
