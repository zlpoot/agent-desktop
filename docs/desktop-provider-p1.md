# P1 Provider contract + Fake Provider

设计依据：[P0 冻结稿 #2](https://github.com/zlpoot/agent-desktop/issues/2)，实施范围：[P1 #3](https://github.com/zlpoot/agent-desktop/issues/3)。

本阶段加入可由后续 adapter 使用的环境契约、能力准入检查和内存 Fake fixtures。现有 Hyper-V、Physical Desktop、Guest、Agent Loop、Workflow 和 D0 Spike 继续使用原路径。没有真实 Provider 集成、输入实验或通用应用兼容性声明。A5 `safety FAIL`、Windows `PAUSED`、整体 `INCOMPLETE` 保持不变。

## 契约与兼容边界

- `src/contracts/desktop-environment.ts`：Physical / Virtual Machine / Local Workspace 的统一 `DesktopProvider`、Session、身份、能力、readiness 和 opaque target/observation binding。
- `src/contracts/desktop-input-control.ts`：独立的资源级输入权契约；`DesktopInputControl` 面向持 authority 的客户端，`DesktopInputArbiter` 另提供可信 backend 注册和 lifecycle 强制撤权。Promise 完成表示相应仲裁与撤权 drain 已确认。
- `src/desktop-provider/admission.ts`：无环境实现分支、无 endpoint 的能力准入。
- `src/desktop-provider/fake-provider.ts`：Fake Provider / backend / runtime；Provider 只 discover/open，不承载操作算法。
- `src/desktop-provider/fake-input-control.ts`：共享内存资源仲裁器，模拟 epoch、租约、撤权、drain 与 ACK。

原 `src/contracts/desktop-provider.ts` 是当前 Hyper-V 管理契约，P1 不替换它，也不让新接口继承其 vmId / workerEndpoint / attach(server)。两个模块中的 `DesktopProvider` 按导入路径区分；新模块不加入生产装配。P2 再将旧管理器包入 compatibility adapter，保持 backend-side recoveryEpoch 门。P3/P4 分别接入 Physical / Local Workspace，P5 才迁移 Task 选择与持久绑定。

## 能力准入

每个能力可有多个 scoped declarations，从而表达同一应用中不同动作的能力差异。`supported` 要求非空 evidence，声明 scope 是已知维度的非空精确 allowlist：providerId、environmentKind、application、applicationVersion、targetRole、action、mechanism。省略维度代表该声明不约束此维度；空 scope、空列表及未知字段均不准入。P1 不解释版本区间或任意谓词，不能以通配字符串绕过版本校验。

当前实现采用保守合取：每个 executor requirement 都要求 Provider、Session、Target 三层存在匹配声明，且所有匹配声明明确 supported、有证据；任一缺失、unsupported、not-proven、forbidden、scope 不匹配或声明矛盾都拒绝。更具体 Target 不能扩大上层未证或禁止能力。Session 和 Target 的运行 readiness 分别检查；临时 not-ready / unknown / 缺失不改写 capability evidence。

Fake backend 配置持有 executor requirements 和真实 target facts，动作请求不能自行移除 requirement 或声称另一个应用版本。Host 准入与 backend dispatch 分别执行检查。能力检查只是总准入的一部分；backend 还核验 immutable Session/instance、有效 target、最新 observation 和资源输入权。

## 输入资源与实例替换

多个 Session、Provider 别名甚至 Fake backend 若指向同一 `inputResourceId`，必须注入同一个 `FakeInputControl`。只允许一个 grant；Viewer 只观察共享 owner/epoch 快照，快照不包含 grant credential。授权校验同时匹配完整 Session 身份、resource、owner、epoch 和 grantId，知道 epoch 不等于拥有输入权。

transfer/release 先禁用旧 grant、递增代次并清理旧队列，drain 完成后才允许新 grant；drain 未确认时双方都不能输入，失败保持 resource blocked。注入单调时钟和固定租约便于无定时器地验证到期拒绝。关闭 owner Session 模拟断连撤权，关闭 observer 不撤销其他 Session 的控制权。Fake 不实现真实 Viewer、认证握手或生产控制 adapter。

Fake backend 仅依赖 `DesktopInputArbiter` 接口。系统 `revokeSession(binding)` 不要求客户端提供有效 authority，因而能处理过期 grant、Session 关闭和实例替换。backend 身份验证与 drain participant 通过可信管理面注册，不向 Viewer 暴露。撤权尝试全部 drain；收集的任何失败都使整体 ACK reject，且不会因 acquire、租约到期或 Session close 清除 blocked。Fake 没有自动恢复 blocked 资源的路径。

`instanceId` 来自 Fake backend nonce 的握手，Session 永久绑定该值。`replaceInstance()` 立即将旧 Sessions 标为 stale、丢弃 targets/observations、拒绝 pending actions，并等待旧 authority 的撤权 ACK；新 open 创建新的 sessionId/instanceId。复制新身份到旧 target/observation 不能恢复句柄：必须显式 bind + observe。这里的 observation 是合成 token，没有真实 frame、HWND 或坐标；将来 adapter 必须将这些原生资源纳入同一失效边界。

Fake 执行仅记录一次合成 operation；没有用户内容、OS 调用或模型副作用。排队时复制请求，在 dispatch 时重新检查 readiness、身份、观察和输入权，不依赖早先准入结果。

## 验证

新增测试自动纳入原 `test:offline`，不修改 runner 或 browser 清单：

- `tests/desktop-provider-contract.test.ts`：三种环境、契约生命周期、三层能力拒绝、scope/evidence、动作范围、readiness 和多个 requirements。
- `tests/desktop-input-resource.test.ts`：双 Session/跨 Provider 竞争、多 Viewer、Agent→Human→Agent、drain ACK/失败、旧 grant、租约和独立资源关闭。
- `tests/desktop-provider-instance.test.ts`：后端实例替换、旧队列取消、直接 backend 拒绝、重新 bind/observe、派发时重新检查和 observation-only Session。

```powershell
npm run check
npm run test:offline
npm run test:python
```

这些测试证明内存契约和合成 orchestration 的行为，不能提升 D0 证据范围、宣称真实 adapter 已验收或覆盖新应用。

2026-10-05 本地验证结果：

- `npm run check`：通过。
- 新增三份测试文件的定向检查：22 项通过。首次运行发现授权对象误带 Session 方法、排队请求无法 structuredClone；改为只复制身份数据后复验通过。
- `npm run test:offline`：444 项通过，0 failed / cancelled / skipped。
- `npm run test:python`：11 个契约文件通过，failed 列表为空。

未涉及网页改动；没有运行 browser suite 或任何真实桌面、VM、模型实验。P1 代码尚未接入生产路径，真实 adapter 的验证仍属于后续阶段。

## P1 revision — independent review REQUEST CHANGES

独立审查针对 `c189ff4..c2ebf9c` 发现两项问题：lifecycle 强制撤权仅存在于 Fake 具体类，未进入公共契约；首个 drain participant 失败会跳过后续 participant。

本次修订将系统撤权和 backend 注册正式放入 `DesktopInputArbiter`，Fake backend 改为依赖该接口；身份比较 helper 移入共享准入模块，backend 不再导入 FakeInputControl 类或模块。撤权改为串行尝试全部 drain，再以 AggregateError 报告失败；失败后仍保持 blocked，不签发新 grant。

新增两个专项测试：

- failing drain 在 backend 注册前抛错：后续 backend 的队列仍取消、最后一个 participant 仍执行；租约到期、重复 close 和再次 acquire 均不能解锁。
- 仅暴露 arbiter 公共接口的替代对象：过期 authority 的正常 release 被拒绝，系统 close / instance replacement 仍可强制撤权，后续 Session 才能重新获权。

修订未扩大 capability vocabulary；应用 launch/bind 的后续建模仍留在 P3/P4 adapter 设计中。P1 等待本次固定版本的独立复审，不直接标为 ACCEPTED，也不进入 P2。

2026-10-05 修订验证结果（保留上面的原 checkpoint 记录）：

- `npm run check`：通过。
- 同三份专项测试文件：24 项通过，包含新增两个反例。
- `npm run test:offline`：446 项通过，0 failed / cancelled / skipped。
- `npm run test:python`：11 个契约文件通过，failed 列表为空。

修订仍只运行上述离线验证，没有 browser suite、真实 Windows/VM/模型实验。
