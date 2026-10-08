# P8-B 第二个 Host 切片：原签发来源到 Task Session 的私有交接

基线：`main@7ab25a9ae4c986556fa97d2adc307c6a93390661`（PR #34）。本项只实现 Host 内的原签发来源交接与失效闭包，待独立 Review。它没有原生 resolver、进程/窗口生命期监控、WorkerClient、认证 ACK、最终 Registry revoke 或持久 revoked 墓碑。真实桥接继续 unavailable，不能声明 `appTrustFence`。A5 safety FAIL / Windows PAUSED / overall INCOMPLETE 不变，#29/#27/#16 保持 OPEN，P8-C 不启动。

## 实现和审查重点

`ControlledAppLauncher` 的私有来源记录现在保存发放启动许可的确切 Registry 对象，以及内部 reservation generation。新 reservation 调用之前同步废弃既有来源记录，包括新 open 失败或 ACK 未知的情况；不淘汰历史、不重置消费状态。迟到的旧 outcome 仍返回原 P7 历史验证，但只建立废弃记录；相同 token 的任何重复 outcome 都废弃新旧来源，不能用迟到结果补造新凭据。

`handoffIssuedTarget` 要求同 issuer 的原来源记录、原 Registry 对象和准确 profile/target；绑定确切 Task Session 对象及冻结的 provider/environment/session/instance/input resource 元组。返回对象没有可序列化字段，只有原 issuer 的私有 WeakMap 能解析它。不同 issuer、复制对象、另一已安装 gate 的 Registry facade、相同字符串的另一个 Session 均不能替代原来源。这里仅记录指定接收者，**没有证明 P7 reservation 和 Task Session 对应同一原生目标**，不把两个 Session ID 相等当证据。

交接在第一次 await 前单次消费，避免两个并发连接领取同一来源。status await 后重新检查原 Session、Registry 的 current/verified/available、精确 profile/安装/启动定义和持久拒绝 gate。失败、未知 status 或已观察身份丢失不会重新启用交接；恢复旧字段也不能复活已经失效的 handle。后续私有解析每次重新检查同样的来源和 Host gate；这仍不是 producer 的效果时间检查。

Onboarding 和 composition 关闭时，在任何异步 drain/backend close 前同步永久关闭 issuer；已有 handle、直接调用的许可和迟到 outcome 都不再可用。backend 安装域漂移使来源废弃并隔离 issuer。此失效仅关闭 Host 交接，不报告原生撤销成功，不终止用户进程。

`UnavailableAppTaskBridge` 使用上述交接，再检查原 trust predicate，随后继续返回明确 unavailable。没有将适配器注册到生产 Task executor，没有 generic runtime 回退，没有新的原生请求或输入租约。既有 Registry、启动接口、Task/Provider 核心契约、Host/Guest v1、Workflow schema、guest/prompts/testbench 布局保持不变。

## 当前原生阻塞

| 原链路 | 此项的有限交付 | 仍需证明 |
| --- | --- | --- |
| 原 launcher → Host 记录 | 同 issuer、原 Registry、单次来源、reservation 换代/关闭失效 | release 后保留原进程句柄和无缺口的窗口 incarnation；无法从历史 receipt 推断仍存活 |
| Host 记录 → Task Session | 私有对象绑定、不可替代元组、await 后 gate | 原 P7 native target 到 Provider/Task 生命周期的可信映射；本项没有此映射 |
| Task → 原效果端 | 继续 unavailable | 原 Worker/Job/Desktop/目标汇合；每个 focus/restore/输入效果的 Registry/InputAuthority 串行边界 |
| 撤销 → ACK → 最终 Registry | 沿用 PR #34 的 denied-pending 拒绝，不添加完成 API | 认证原端点、逐效果序列、真实排空 ACK、最终 revoke 与持久墓碑 |

当前 P7 helper release 会释放保留的 process/Job handles，后续 reserve_context 清空 targets；D0 Provider 另建自己的目标。这些实现不足以开放原目标或效果端绑定。不能依据本项合成测试声称原生生命期、远程串行或 `registry-at-effect` 已通过。准确 Workspace 配置、网易云音乐 3.1.40.205461 安装版本及原目标继续 selection/target UAT PENDING。

## 无副作用审阅与验证

1. 查看本项 diff，确认没有新的原生 RPC、Worker、输入或自动启动入口。
2. 查看 `handoffIssuedTarget`，确认来源消费、原对象绑定和 await 后拒绝都在同一 issuer 内。
3. 查看 reservation 换代、迟到 outcome 和关闭顺序，确认历史来源不复活。
4. 运行 `node --import tsx --test tests/app-target-handoff.test.ts tests/app-task-bridge.test.ts tests/app-durable-admission.test.ts tests/environment-app-launch.test.ts`；所有目标、Session、backend、动作均为合成端口，SQLite 仅测试临时文件。
5. 查看当前不可用边界，独立审查后再决定下一项原生生命周期接入；无需重复已经反馈通过的 Dashboard 预览。本项不请求、也不执行实机测试。

规定检查为 `npm run check`、`npm run test:offline`、`npm run test:python`。网页未变，不追加 Browser 矩阵。检查结果由交付记录报告；本项作者执行的合成验证不是独立 Review 或远端 CI。日志只在忽略的 `.validation/` 中，不提交生成资产或私有数据。

作者本轮源码验证（2026-10-08，代码提交 `e04b9becce7122f419e66c4daf85c68182060489`）：TypeScript PASS；上述定向测试 57/57 PASS；完整 offline 732/732 PASS（0 skipped）；Python 15/15 契约文件 PASS。实现期间的失败已修正后重跑，以上只报告该源码结果。独立 Review 待完成，远端 CI 未报告；未进行 Browser 或真实应用测试。用户随后明确授权 push 供 review，因此推送工作分支并提供独立 PR；本次后续提交只更新此交付说明，不更改已验证代码。不合并、不关闭 Issue、不更改仓库可见性，也不启动实机测试。
