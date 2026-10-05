# P2 Hyper-V compatibility adapter

设计依据：[P0 #2](https://github.com/zlpoot/agent-desktop/issues/2)；实施范围：[P2 #4](https://github.com/zlpoot/agent-desktop/issues/4)。P1 独立复审接受的本地基线为 `1ed0ccbe8910e058fe9838d82f876def8bfc10bc`。

本阶段将已登记 VM 与既有 DesktopControl/Guest runtime 包装成环境 Provider。没有改变 Guest HTTP/RPC 协议、Workflow schema、模型、预算、风险门、执行器选择或 VM 管理命令。没有真实 VM、Windows 输入、模型实验或应用验收。A5 `safety FAIL`、Windows `PAUSED`、整体 `INCOMPLETE` 保持不变。P2 checkpoint 供独立审查，不自行标为 ACCEPTED。

## 装配与兼容入口

`src/desktop-provider/hyperv-provider.ts` 实现新环境契约的 `DesktopProvider`，`id = hyper-v`、`kind = virtual-machine`。Root 的 `environmentProviders` / Cordis `desktopEnvironmentProviders` 提供公共契约列表；Session scope 将已创建的 DesktopControl 登记到装配专用 `hyperVCompatibility` 服务。Agent Core 没有新增 Hyper-V 分支。

旧管理面明确命名为 `LegacyDesktopProvider`，保留 deprecated `DesktopProvider` 类型别名供现有调用者使用。新旧模块没有共同 barrel 导出。legacy vmId、Worker endpoint、网页 transport、HyperVVmControl 的启动/状态/console 命令仍留在基础设施。Provider 不继承 `attach(server)`，open/close 不启动或关停 VM，也不会回退到 Physical / Local Workspace。

`discover()` 对已登记 VM 去重，不探测 Guest；持久记录可以出现在 discovery 中，但只有挂载了唯一 DesktopControl、完成鉴权与 readiness 握手的环境能 open。多个 legacy controller 指向同一 VM 时，新 open 拒绝，已有新 Session 在下一次检查时 stale。这里没有替旧路径重构多个 legacy controller 的历史行为。

Task 的默认 `VM:` 路由、网页选择和持久 Task binding 继续使用兼容路径；统一选择与显式绑定仍属于 P5。新环境入口已经可以 discover/open，装配专用 `taskControl(session)` 和 `connectRuntime(session, artifactDir)` 可沿现有 InputControl / WorkerClient 完整运行 Guest 路径。这两个入口不属于公共 Provider 接口，操作仍由 runtime 承担。没有将它们接成通用能力准入的新执行器，也没有将 P1 FakeInputControl 放进生产控制链。

## 身份与后端检查

- environmentId 从 legacy vmId 稳定映射；sessionId 每次 open 新建，与 legacy scope id 分离。
- instanceId 从已验证 vmId 与 Guest recovery_epoch 派生，Session 对象不可变。inputResourceId 从实际 VM 身份派生，多个新 Session 共用它，endpoint 变化不会产生第二份输入资源。
- open 同时检查鉴权 `/state`、完整 RPC flags、两种 readiness，以及 DesktopControl 的握手快照。跨 await 再检查 scope 注册与 legacy 映射，避免握手期间解绑或改端点。
- runtime 连接新增可选 expectedRecoveryEpoch 参数，在它自己的握手中再次检查；原工厂调用签名继续兼容，线上请求字段完全不变。
- 每次 runtime 操作重新检查 Session、endpoint、Worker instance、readiness 和当前 Agent epoch。后端返回 instance changed 时立即标记旧 Session stale。
- Guest 原有 lock 内 recoveryEpoch → readiness → controlEpoch 检查、单窗口 owner、执行器 allowlist、actionId journal 保持原代码。Host 提前检查不能替代这些门。

Worker/endpoint/scope 身份变化后，旧 Session 永久失效并启动 drain；不会修改其 instanceId。旧 runtime、窗口绑定和 observations 不能用于新 Session；新 runtime 必须 attach + observe。Observation 仅按适配器实际产生的对象登记，调用者复制字段不能让旧 observation 获得新 Session 身份。旧队列在派发前的检查或 Guest 身份门处拒绝；已经发出的操作等待 settle，不宣称可以撤销已发生的效果。

## 控制权与收尾

适配器复用同一个 DesktopControl 和 Guest input gate。Viewer 的 owner、lease、revision 和 Agent epoch 仍由这条控制链产生。新 Session 的资源占用记录只关联 Task 与该控制链，不创建第二套 Viewer authority。旧 Task 已占用控制时，新 Session 准入失败不能撤销旧 Task。

Task finish 和 lifecycle cleanup 共用同一撤权 Promise：先停止接受 runtime 请求，等待待连接/准入操作与全部 runtime 的在途 RPC、释放窗口，再调用原 finishTask 撤权。只在 Worker ready、控制状态 paused/stopped 且没有未确认错误时释放资源占用；finishTask 的 boolean 是旧协议的 stopped 标记，不能单独当作撤权 ACK。

关闭观察 Session 不撤销其他 Session 的 Agent。关闭拥有输入的 Session、scope unregister 和 Root dispose 都 drain 后撤权；scope 卸载无论适配器收尾是否成功仍执行原 DesktopControl.close。Root 按原顺序等待 Task/Session 收尾，最终关闭适配器和 legacy manager。

所有 runtime drain 都尝试执行，再汇总错误。撤权或 setup 失败后的资源占用不会因第二次 acquire、重复 finish、Session close 或重新 open 自动清除。该 compatibility adapter 暂无清除 blocked 的管理 API；失败后需要明确确认 Guest 撤权并重建整个 Host Provider/控制作用域，仅重新挂载一个 Session 不会解锁，不能把重新 open 当作恢复 ACK。原 legacy 重连/暂停恢复路径仍保留；这不是新的自动恢复策略。

## Capability 与 readiness

仅对实现已经保证的协议机制声明 supported：Guest pixels 与 legacy-control 的 takeover/resume/lease。Evidence 引用现有 Host/Guest 实现，并注明不是 live VM 或应用验收。未验证的 accessibility、semantic/targeted/raw input 和 OS/desktop isolation 保持 not-proven，Host global fallback 为 forbidden。

Runtime readiness 独立表达：已验证机制随 Guest readiness 变化；未证输入与隔离能力即使 Worker 在线仍为 unknown。Worker RPC flags 不生成应用级 capability evidence。P1 的三层准入规则不变，这些未证输入声明不能获得通用准入。既有 compatibility executor 继续受现有 ActionResolution、风险门、绑定窗口与 Guest 后端授权约束，其原有支持范围没有扩大。

## 离线验证

新增 `tests/hyperv-provider.test.ts` 自动纳入 offline runner。使用临时目录、合成 SQLite 状态、localhost 协议替身与无调用模型；不读取用户的 VM 数据库或快照。

覆盖环境/身份映射、保守能力声明、错误 VM/未就绪/不兼容 Worker、双 Session 竞争、多 Viewer 租约、旧 Agent epoch、bind + observe、旧 observation 拒绝、endpoint 替换、Worker 实例替换、Host 检查后的 backend 拒绝、runtime 握手竞态、在途 RPC drain、撤权失败永久阻断、scope 卸载及装配入口、关闭与连接/准入并发、旧 runtime 工厂兼容。

要求检查：`npm run check`、`npm run test:offline`、`npm run test:python`。未改网页，未运行 browser suite。离线验证仅证明兼容装配和协议边界；真实 adapter 的运行验收仍需另行授权。

2026-10-05 最终本地验证：

- `npm run check`：通过。
- 新增 Hyper-V compatibility 专项：20/20，通过。
- `npm run test:offline`：466 PASS，0 failed / cancelled / skipped。
- `npm run test:python`：11 个契约文件通过，failed 列表为空。
- `git diff --check`：通过。日志与导出 patch 保留在 ignored `.artifacts`，不提交生成资产。

状态：IMPLEMENTATION COMPLETE / READY FOR INDEPENDENT REVIEW。审查范围为 P1 基线到本地 P2 checkpoint；没有 push、修改 GitHub Issue 状态或开始 P3/P4。
