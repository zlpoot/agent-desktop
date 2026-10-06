# P3 Physical Desktop compatibility adapter

设计依据：[冻结 P0 #2](https://github.com/zlpoot/agent-desktop/issues/2)；实施范围：[P3 #5](https://github.com/zlpoot/agent-desktop/issues/5)。P2 基线为 `d334026f0d1b6042d0d3f07223fccaa253099595`，已按用户授权推到 `codex/d0-closure`，并在 [#4 ACCEPTED checkpoint](https://github.com/zlpoot/agent-desktop/issues/4#issuecomment-5995038872) 记录并关闭为 completed。

本阶段将当前交互式 Windows 桌面及既有 DesktopRuntime 包装为 Physical Provider。没有新增自动化执行器、修改 Guest HTTP/RPC 协议、Workflow schema、Agent Core 分支、模型、预算或风险门。真实 Windows/VM、应用与模型实验均未运行；A5 `safety FAIL`、Windows `PAUSED`、整体 `INCOMPLETE` 保持不变。P3 本地 checkpoint 供独立代码审查，不自行标为 ACCEPTED，不 push P3，也不进入 P4。

## 装配与兼容入口

`PhysicalDesktopProvider` 实现公共环境契约，`id = physical`、`kind = physical`，唯一 environmentId 为 `current-interactive-desktop`。Root 的公共 `environmentProviders` / Cordis `desktopEnvironmentProviders` 列表包含 Hyper-V 与 Physical。`physicalCompatibility` 是装配专用的 runtime 工厂，Agent Core 和 Task runner 不依赖具体 Provider。

发现及默认 Root 装配不启动 Python Worker；非 Windows 默认不可 discover/open。首次 open 才启动一个 managed DesktopRuntime Worker，多个新 Session 共用它。测试可注入 PhysicalBackendFactory，因此合成装配回归不创建真实 Windows Worker。

可信基础设施的调用顺序为 discover/open → InputControl.acquire(agent) → physicalCompatibility.connectRuntime(session, authority, artifactDir) → runtime.attach(window identity) → observe → 既有 ground/resolve/execute。运行时方法继续由 DesktopRuntime 和原 worker.py 实现。实例替换、输入权转移或新 runtime 后必须重新 bind + observe；只复制旧 Observation 的字段不能取得 restore 准入。

旧 DesktopRuntime.attach/listWindows、原 Task 选择/路由及 Viewer UI 不改走新入口；统一选择、持久显式 Task binding 仍属于 P5。managed local Worker 协议是 opt-in 的 physical_hello/grant/revoke 扩展；未发送 hello 的 legacy Worker 继续原 dispatch，包括 Guest 使用的旧本地进程路径。没有修改 Guest recovery/control epoch gate。

## Policy、能力与前台边界

默认 policy 为 `{ windowManagement: false, executors: [] }`。bind/restore/focus 可能恢复或移动窗口，必须显式启用 windowManagement；该开关不授权任何输入执行器。execute 的既有执行器也必须逐项列入 executors，resolution 必须明确选择一个 available provider。Host 只传该 selected provider，Python 再要求单个已授权执行器；缺失 resolution、多个后端授权、未授权 fallback 均拒绝。window management、execute 都要求完整 Agent authority。

policy 是可信装配构造时固定的权限配置，不能由 action request、重复 hello、Session 或 Viewer 临时扩大。它不是应用级 capability evidence。兼容 runtime 保留原 controlled_foreground、目标身份与权限检查、ActionResolution 和上层风险门，不新增自动前台回退。Python 默认 FAILSAFE 保持开启。

Capabilities 有 scope 与 implementation evidence，readiness 独立表达：pixels 为 local-window；managed-client 范围内的 takeover/resume/lease supported；共享用户会话 supported；separateDesktop、separateOs 和 rawIsolated unsupported。accessibility、semantic/targeted input 保持 not-proven；globalInput 在默认空执行器 policy 下 forbidden，即使显式允许也只是 not-proven，不能凭 policy 获得 P1 的通用 capability admission。未证能力的 readiness 保持 unknown，Worker 在线不构成应用或并行人工使用验收。

Physical 对象就是用户当前桌面。broker 的 human owner 代表接管并暂停受管 Agent，P3 不提供新的 Human 输入执行器，也没有接入网页 Viewer。物理键盘鼠标、其他软件和别的 Host 进程不受这个 broker 控制；安全并行使用人工输入未证明，不声明隔离或并发安全。需要一个可信 Host 管理该桌面，所有别名/Session 必须注入同一个 ResourceInputControl；没有跨 Host 进程的全局锁，也不能把另建 Root 当作第二个可并行 owner。

## 身份、readiness 与执行端门

physical_context.py 只读取机器/Windows session/window station/thread desktop，派生实际 inputResourceId；不同 Worker nonce 不会给同一 OS 桌面产生不同资源 ID。instanceId 为 managed Worker 进程 nonce。它用 DESKTOP_READOBJECTS 打开当前 input desktop 并关闭句柄，确认 WinSta0 和当前桌面匹配；锁屏/不可读 input desktop 使 readiness 拒绝，不发送 OS 输入。此模块没有导入时 OS 调用。

open 完成后 Session 的 sessionId、instanceId、inputResourceId 不可变。每次 runtime 调用前重新握手；DesktopRuntime 自己也保存首次握手的身份，防止 Provider 检查与新握手之间改写身份。Worker 进程或资源身份变化、身份/传输无法确认都会使全部已建立 Sessions 永久 stale，立即停止接受旧队列并启动撤权 drain。普通 not-ready 可以恢复，但不会更新 instanceId。Python PhysicalGate 固定首次 OS 身份，检测实际身份变化后永久拒绝旧管理与输入请求；即使原资源回来也不能复活旧 grant。伪造请求身份只拒绝该请求，不使真实 backend 被错误改写。

Host 仲裁检查 `grantId + immutable session identity + owner + epoch + inputResourceId`。Python dispatch 在现有 Worker stdin 串行执行流中独立重新检查当前 OS 身份、readiness、完整已安装 grant、policy 和单一 executor，再进入原执行逻辑。不能只靠 Host 提前检查。Worker grant 的 TTL 使用单调时钟，最多三秒且不超过 Host 剩余 lease；安装后修改墙上时间不能延长授权，没有自动续租。lease 到期后旧输入请求拒绝，生命周期撤权不要求 lease 仍有效。

## 仲裁与 cleanup

P1 已验证的资源仲裁实现提取为 `ResourceInputControl`，FakeInputControl 保留为测试 facade；Physical 生产链不依赖 Fake Backend。原 resource 粒度互斥、全量 drain、旧 epoch 拒绝、无凭证 Viewer view、forced Session revoke 算法保持。新增 remainingLease 仅供可信管理握手计算期限，action 不能延长租约。

Physical 全部 runtime RPC 共用一个串行队列，一个 Worker 同时只绑定一个受管 runtime。transfer/release、owner Session close、terminal stale 与 Root dispose 都停止旧 runtime，取消尚未派发的工作，等待已发 RPC settle，再向 Python 发 revoke。Python ACK 前清除 grant 和窗口绑定，Host 才能产生新 owner/epoch；不宣称能撤销已经发生的效果。观察 Session close 不撤其他 Session 的 owner。

grant 在发送前登记为待撤权，避免丢失 grant ACK 后误判未安装。managed RPC 有 30 秒上限，未确认时终止本地进程并让后续撤权失败保持 blocked；不会把超时当作 ACK。runtime/Provider close 幂等。所有资源 drain 都尝试执行，任一撤权无法确认则 permanent blocked，lease 到期、重复 acquire、Session close 不会自动释放。无 blocked 清除管理 API；必须明确确认 backend 终止/撤权并重建整个可信 Provider/仲裁作用域，单独重新 open 不构成恢复证明。

Root 保留先关闭 Task/Session 的生命周期顺序，再关闭 Hyper-V、Physical 和 legacy desktop manager；一个适配器收尾失败仍尝试后续关闭。

## 离线验证

TypeScript 使用合成 PhysicalBackend、Fake model 与临时状态目录；Python 只运行纯 PhysicalGate、mock Windows context 和 AST 提取的实际 Worker dispatch loop，未加载真实 Windows 自动化模块、未启动 native Worker。

Physical 专项覆盖默认 policy、window-management 与 executor 权限分离、selected-only fallback、前台/权限拒绝、双 Session/Provider alias 竞争、observer close、Agent→managed Human→Agent、新 runtime bind/observe、旧 grant/observation、Host 与 backend 各自身份拒绝、原身份恢复不能复活、暂时 readiness、新 open 时身份异常、queued/in-flight drain、过期与撤权失败 blocked、惰性 Root 装配与幂等 shutdown。Python 专项覆盖完整凭证、immutable policy、单调期限、resource drift terminal、mock input desktop 只读与句柄释放、legacy dispatch、managed grant→execute→revoke→旧 authority 拒绝。

要求检查为 `npm run check`、`npm run test:offline`、`npm run test:python`、`git diff --check`。未改网页，不运行 browser suite。日志和导出 patch 留在 ignored `.artifacts`，不提交生成资产。离线验证不等于真实 Physical 桌面/应用验收。

2026-10-05 最终本地验证：

- `npm run check`：通过。
- Physical compatibility 专项：18/18，通过。
- `npm run test:offline`：486 PASS，0 failed / cancelled / skipped。
- `npm run test:python`：12 个契约文件通过，failed 列表为空；其中 Physical Python 专项 13/13。
- `git diff --check` / staged diff check：通过。日志保留为 `.artifacts/P3-check.log`、`.artifacts/P3-offline-final.log`、`.artifacts/P3-python.log`。

状态：IMPLEMENTATION COMPLETE / READY FOR INDEPENDENT REVIEW。审查范围为 `d334026` 到独立本地 P3 checkpoint，12 个文件；完整 patch 放在 ignored `.artifacts`。P2 已推送并由用户接受，P3 未 push，#5 保持 OPEN，未进入 P4。
