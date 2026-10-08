# P8-B / #29：可信启动到任务桥接审计与只读预览

基线：`4d727be358efdfd660d1251dd4a2aec0a7707e64`。P8-A 的独立审查和操作者报告已完成，但只覆盖本机预检/只读发现与未配置工作区诊断，不证明网易云音乐或工作区已经安装、配置或准入。

本候选交付 **签发来源校验的结构性适配器、明确不可用的原生桥接诊断，以及不会执行的测试预览**。没有真实 Worker 接入，没有声明 `appTrustFence`，没有修改 Host/Guest、Provider、Workflow 或启动契约。**原生桥接不可用；P8-B 五步只读页面体验已收到操作者通过反馈；结构性候选独立审查已接受并合并；实际目标核验仍待完成。** 操作者已选择已有证据的网易云音乐候选作预览，这不等于选择了真实目标或授权启动/输入。#29/#27/#16 保持 OPEN，P8-C 不启动。A5 safety FAIL / Windows PAUSED / overall INCOMPLETE 不变。

## B0：源码可行性表

下表只评价源码/契约，不是当前设备的能力或就绪检查。`supported` 指对应有限实现，`unavailable` 指缺少接入端口，`not-proven` 指证据不足，`forbidden` 指本阶段禁止调用。

| 环境 | 签发者私有原实例证据 | Provider Session/instance | 安装身份 | 模型可见字段 | 原生效果/撤销确认 | 结论和具体阻塞 |
| --- | --- | --- | --- | --- | --- | --- |
| Physical | P7 helper 内有以 PID、创建时间、HWND、helper instance 为键的 token；没有 Worker 原实例解析 RPC，也没有窗口销毁/重建的独立生命周期证明 | 现有 Physical Session 由另外的握手建立；不能把启动 reservation ID 当 Task Session | P7-B/P7-C 有安装域、版本和内容核验；不是当前运行窗口证明 | 沿用既有应用/窗口摘要；原生 token、路径/参数、Registry 和授权不新增到模型 | 独立启动 helper 没有可信 native dispatch fence；Worker 业务效果没有应用 Registry 撤销串行边界 | `unavailable`；通用输入 `not-proven`，本轮效果 `forbidden` |
| Guest | P7 管理 helper 有私有启动记录；当前 Guest Worker 协议没有同签发者目标解析 | VM/Session/instance 校验已有有限实现，但没有将启动原实例绑定到任务的私有映射 | Guest 安装域独立核验；不读取 Host 代替 Guest | 保留既有 Worker 面，不新增启动/绑定凭据 | Guest 启动的管理锁不是 Task Registry 撤销栅栏；没有应用撤销代次、业务提交序列与 ACK 协议 | `unavailable`；原实例/跨进程栅栏 `not-proven`，本轮效果 `forbidden` |
| Local Workspace | P7 `LocalWorkspaceAppLaunchBackend` 要求 composition 提供 owned binding；生产未提供同签发者 backend/resolver。D0 打开 Session 会创建自己的 Job/目标，不是 P7 启动 receipt 的同一目标证明 | D0 nonce、Job、隐藏桌面、run、Session、instance、authority/epoch 和观察 token 有有限证据；不能用路径/PID/HWND 巧合补映射 | 同 OS 的发现来源仅只读；当前配置与安装版本仍未证明 | P6 有限场景名/版本可展示；不新增私有目标记录 | D0 输入权撤销/队列栅栏有固定场景证据，但不检查 P7 Registry profile；`LocalWorkspaceTaskExecutor` 不提供 WorkerClient/`connectAppRuntime` | 已有固定场景 `supported`（限定版本/动作）；P7→Task 桥接 `unavailable`，本轮效果 `forbidden` |

关键源码：`src/environment-apps/{launcher,launch-adapters,onboarding}.ts`、`guest/app_launch.py`、`src/app/{task-app-onboarding,task-runner,task-desktop-sessions}.ts`、`src/desktop-provider/{local-workspace-provider,local-workspace-task-executor,physical-task-executor}.ts`、`src/composition/root.ts`。P4/D0/P6 的成功证据不升级为 P7 原目标或任意 EXE、Notepad、RAW、通用 Physical 输入的证明。

## B1：本次实现与拒绝边界

`ControlledAppLauncher` 在成功验证及 drain 后取出 outcome 时，保留有界、仅内存的签发来源记录（同一签发器生命周期最多 128 个不同 token，含已消费/重复签发的拒绝记录）。记录冻结 profile scope、binding/installation ID、profile revision/digest、安装 product/version/fingerprint、启动定义，以及 receipt 的 reservation session、instance、Windows session、desktop 和 token。`consumeIssuedTarget` 只接受同一 launcher 的精确记录，消费一次且保留拒绝记录；同一 token 再次成功验证不证明新的签发身份，因此新旧 receipt 均不可用于桥接，不覆盖/重新启用旧记录。历史启动验证仍按原契约返回，不代表桥接可用；复制 permit、伪造同路径窗口或其他签发者的 receipt 不成立。记录没有写入 Registry、Task 状态或 HTTP。

`createUnavailableAppTaskBridge` 仅接受实际 `ControlledAppLauncher`，使用它的私有来源记录和原 Registry。结构性适配器冻结输入快照，读取 Provider status 后再次检查 Registry current/verified/available、profile 和 Session 一致性，消费来源记录，随后明确返回 `app-task-native-issuer-resolution-and-revoke-fence-unavailable`。它不把来源记录当作当前进程/窗口生命期证明，不等同 reservation 与 Task Session，也不返回 Worker、获得输入权或打开/清理用户进程。Host 检查不是原生效果栅栏。

**适配器不声明 `appTrustFence: 'registry-at-effect'`，不注册进生产 Task executors。** 原有 Task 缺桥接/缺能力时的拒绝和零 generic `connectRuntime` fallback 保留。真实安装漂移、进程/窗口生命期、精确 Task/native 映射、producer authority 与 revoke ACK 均没有获得原生证明，不能因合成 fixture 成功而开放。来源记录不淘汰消费或重复签发历史；达到 128 个不同 token 后，后续新 token 的桥接来源证明也保持不可用，不能通过容量淘汰重新启用旧凭据。进程重启不继承旧来源记录；当前无法证明独立签发身份的重复 token 情况明确拒绝，不新增公共凭据字段或更改原生 token。

## B2：最小兼容计划（待独立审查，未实现/未协商）

1. 保留现有 v1 Host/Guest 和 D0 方法。本次不增加 RPC。后续必须另行审查一个独立版本的私有管理能力协商；老端点或缺失能力一律拒绝，不能把客户端 boolean 当证明。
2. 同一原生签发者在私有记录中解析 token，核验安装内容/版本/argv/cwd、保留的进程句柄及创建生命期、窗口销毁/重建生命期、Windows Session/Desktop 和原 helper incarnation；再经可信 ownership 映射到不可变 Provider/Task Session/instance。D0 自行启动的新目标不能补成同一实例。
3. 在实际 producer 端用同一串行边界处理固定动作、focus/restore 和应用撤销。所有 await/排队结束后、真实效果提交前重查完整 Registry profile 授权、目标生命期、InputAuthority/lease/epoch 和精确 action/role/mechanism；不得把 Host 预检与以后效果分离。
4. 后续兼容候选已具体化为 [原生管理面与 producer 参考决策](desktop-provider-p8-b-native-fence.md)：先停止 Host 新 admission，并在发送原生请求前持久提交 denied-pending 拒绝意图；新 Task、应用复用及输入授权每次都检查该记录，包括重启后与 Registry 仍为 current 时。producer 在实际效果边界拒绝并排空、返回关联 ACK 后，才持久化最终 Registry revoke；ACK 核对和最终写入都完成后才结束待决，并保留拒绝墓碑；不能先把 Registry 写成 revoked 却仍允许 ACK 前旧队列效果。当前 P7-C 同步 `revoke` 不变；独立异步管理面和所有失效写入的封闭方式必须先审查。该参考只在合成测试中存在，未接入生产或更换冻结契约。
5. ACK 丢失、超时、迟到或重排保持 blocked/unknown；不重放、不重启、不替换目标，不杀用户已有进程。保留撤销前已经提交的动作和 audit。需要确定性的 0/1 先前提交、阻塞→撤销 ACK→释放、丢失/晚 ACK、身份/版本/生命期漂移与 pause/abort 反例，才能声明原生 fence。

最窄备选仍是已有版本限定的 D0/P6 固定场景；它需要另行真实目标核验与运行授权，不能宣称是 P7 启动到 Task 的桥接。本候选不执行该备选。

## B3：现在如何查看（6 步，无副作用）

在你的 PR 候选仓库工作目录打开 PowerShell，复用已有依赖运行：

```powershell
npm run dashboard:bridge-preview -- --config config/desktop-environments.example.json --port 4176
```

地址：[http://127.0.0.1:4176/#/apps](http://127.0.0.1:4176/#/apps)。需要显式可信配置；没有该配置就退出。示例文件没有配置工作区，不为验收自动改 JSON 或选择夹具。端口冲突时换端口并访问对应地址。此入口不同于 A2 发现，不读取安装身份、软件目录或原生窗口。

1. 打开页面，核对标题“P8-B 任务桥接只读预览”、主机与显式配置。环境初始未选择；没有扫描、候选或授权，扫描/路径/确认按钮禁用。
2. 明确选择已列出的本机环境，查看“任务桥接不可用”的原启动窗口/撤销边界说明。发现与历史启动验证都不等于允许任务；选择不启动应用。
3. 阅读“拟议受控测试预览（不会执行）”四个阶段：发现候选、历史启动验证、任务桥接、受控实测。预览不是当前已安装软件或可执行命令。
4. 核对候选：本地隔离工作区、网易云音乐 **3.1.40.205461**、孙燕姿《我怀念的》固定搜索/播放及读取验证；实际配置、版本和原实例仍 **selection/target UAT PENDING**。已有可信工作区可明确选择并看诊断；未配置则报告不可用，不根据本机清单推断或回退。不要为了体验启动真实目标。
5. 清空环境、重选并点刷新，再重载。环境诊断/旧会话清空，没有自动扫描或动作；候选预览仍仅为独立说明，不自动绑定环境。
6. 在启动终端 `Ctrl+C` 停止，关闭页面。临时 Registry 丢弃；没有真实应用需要结束。向 #29 的私有交接反馈环境/候选版本是否合适、文案是否易懂、期望/实际和严重程度。真实路径、设备信息、截图只保留于忽略的私有证据，公开反馈去标识化。

本轮只征求预览/目标反馈，不请求实时运行许可。操作者在聊天中选择此候选仅为预览；**操作者已报告五步只读预览全部通过**（受测源提交 `0e8f4be340a19d891191892e7f89a119bba22c1a`）；反馈只覆盖初始禁用、环境诊断、四阶段分离、拟议候选及清空/刷新/重载，不证明实际配置、安装版本、原实例或原生桥接。根据反馈补充桥接术语的白话解释，并按配置是否加载标注候选环境状态；配置已加载也不等于应用或实例已验证。交付后停在独立 Review 与操作者反馈，不自行合并/关闭或进入 P8-C。

## 验证范围

仅合成身份、Fake backend/collector/Session、既有 FakeModel/FakeWorker 和 loopback 新临时浏览器 profile。没有真实启动、输入、模型/第三方联网、VM、安装或 UAC。新反例检查同签发者/一次消费、profile/安装/argv/cwd/上下文替换、Registry 撤销赢过 await、迟到 status/Session 替换、丢失 drain ACK，以及缺原生证明始终不可用。它们不是原生窗口生命期或远程 ACK 串行证明。

定向复用 P7 的 0/1 已提交动作→阻塞效果→HTTP revoke ACK→释放反例、缺少/旧桥接能力、暂停/重放/输入释放回归；其 synthetic producer 的成功只证明原合成契约。预览检查覆盖真实 CLI、HTTP 拒绝效果、未选环境、切换/刷新/重载、四阶段中文和移动端，不要求重复 P8-A 人工体验。必要矩阵及失败见 exact head 的 PR 交付记录；远端 CI 未报告不能写为 PASS。日志、截图和实际启动路径仅在忽略的 `.validation/` 保存，不提交生成资产。
