# P8-B 第一代码项：持久拒绝记录与 Host 准入检查

基线：PR #33 的已审查设计合并 `a3018de0df48958f2c850939dde2f4a20dfe970f`。本项是实际存储和 Host 授权代码，仍不提供原生桥接；每项代码需独立审查。

## 已接入的边界

`SqliteEnvironmentAppStore.beginAppDenial` 仅供可信 composition 使用。在与 Registry 相同的 SQLite 连接上，用 BEGIN IMMEDIATE 事务核对安装域、准确 binding/revision，再插入私有拒绝记录并 COMMIT。同步模式设置并核对为 EXTRA；成功返回表示 SQLite 已完成提交，不是 producer ACK。记录保存完整原 profile、服务器生成的 nonce、拒绝代次、原因和时间；不改变公开 binding 字段或 Registry validity。首次拒绝后不提供清除、重发、完成或重新授权 API，拒绝历史不淘汰。容量上限 4096，耗尽拒绝新记录。

新增的两个 private 表是内部存储迁移，不改变公开 EnvironmentAppRegistry、Host/Guest v1 或 Workflow schema。旧数据库可初始化为空的私有日志；已有日志只剩一个表、版本不符、读取失败都会拒绝，不静默重建部分损坏的日志。SQLite 写入、锁、COMMIT 或 rollback 失败会关闭当前连接的准入。失败没有发起任何原生请求；关闭后旧 view 不能用于授权。

| 入口 | 本项接入 |
| --- | --- |
| 启动许可 | 原 requireLaunchProfile 每次读持久拒绝；已有 launcher 在 await/效果准备检查时继续重读 |
| 应用复用与确认 | 新调用、重复调用及等待结果返回都检查拒绝；不可通过 availability 恢复开启 |
| 新 Task、继续运行、原 receipt | 查询同一私有 gate；已有 Task profile/receipt 不能替代新检查 |
| 桥接与输入领取 | 原 unavailable bridge 在 status await 前后查询；Task 在连接后、输入领取前后查询 |
| Registry 写入 | discover/confirm/verification/availability/stale/revoke 在同一 SQLite 写事务中查拒绝 |
| 重发现与安装域变更 | 同 installation 或规范化 application ID 的新 binding 被拒绝；有待决记录时安装域切换被拒绝 |
| 元数据和历史 | list/get/history 保留只读查看能力；仍为 current 的元数据不授予许可 |

Task/输入/桥接检查要求当前 Registry 对象已安装私有存储 gate；复制 facade 或未接入存储的端口会被拒绝。冻结的 legacy P7 自定义启动端口仍按旧契约运行；没有 gate 的 legacy 端口不能通过 Task/输入/桥接检查。内存 WeakMap 只保存可信回调，拒绝状态每次从数据库读取，不靠该 Map 跨重启保存。

## 验证与剩余边界

回归使用真实临时 SQLite 文件、独立连接、子进程完成 COMMIT 后直接退出（不显式 close），重新打开真实 store/launcher/service；Registry 保持 current 时仍不能发放许可或复用。还验证写失败/部分损坏、全部已有写入口、重发现/安装域绕过、复制 facade、桥接 await 竞态，以及新 Task/继续运行没有新增租约、模型或业务效果。应用、issuer、Worker、模型、窗口和输入都是合成数据/Fake ports。此处不是前一 Map checkpoint 模拟。

进程退出和 SQLite 成功提交并不证明本机供电丢失、磁盘/文件系统诚实性、Windows 文件权限或备份回滚防护。数据库路径、访问权限和写入方必须由可信基础设施管理；本项不声称抵御直接篡改、整库替换/回滚或同时删除全部私有表。生产原生接入前还需独立确认存储部署与恢复信任，不能凭这些测试开放原生授权。

**原始应用实例到效果端的绑定尚未接入。** 当前 P7 helper release/reservation 与 D0 Worker 的实例生命周期没有已证明的汇合，本项不添加 resolver/Worker/原生 RPC，不把 PID、HWND、路径或两个 Session ID 的相同字符串当证明。拒绝记录尚无已验证原 issuer/process/window/Task/lease 与 ACK 关联字段，因此没有最终撤销协调器；后续绑定代码需单独审查并补齐这些不可变来源，再实现 ACK 后最终 Registry revoke 和保留 revoked 墓碑。

已有写入口在 pending 后被封闭，但这不等于所有未来 native trust 失效写入已在 producer 效果边界排空；Host 在 await 前后的检查也不等于原生 lease 签发或效果提交的原子性。未来所有写入方、原实例 resolver、认证 ACK 和真正效果执行端必须通过同一受信协调门；在证明前不可注册 native bridge 或声明 `appTrustFence`。

真实桥接继续 unavailable；不扫描、启动、输入、调用真实模型或控制 VM。五步只读预览无需重复。#29/#27/#16 OPEN，#30/P8-C 不启动，A5 safety FAIL / Windows PAUSED / overall INCOMPLETE 不变。
