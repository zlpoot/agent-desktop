# 提取与私有留存

本轮先生成逐文件清单，再将物化白名单逐文件复制；没有复制目录、旧 .git、分支、标签、依赖/浏览器缓存和运行数据库。公开 `extraction-manifest.csv` 列出源文件去向、理由及必要依赖；完整私有清单含所有缓存和运行资产文件，单独随本地交付保存。没有敏感值。

未知实现先保留。未确认任何实现满足“无入口、动态注册、脚本调用和测试依赖”的废弃条件，故没有按废弃删除。核心接口、协议、Workflow schema 保持原样。两份已修改配置没有复制；应用清单重建为空，预算重建为原代码默认上限，辅助模型关闭，内网模型地址和私人程序默认路径去除。

必须原样私有归档的实验测试：`tests/p7a-baseline.test.ts` 全部（真实 P7-A 快照/来源 ID）；`tests/p9-a5-runner.test.ts`、`tests/p9-a5-startup.test.ts` 全部（冻结源码与历史种子）；`tests/p7b-contract-coverage.test.ts` 最后一项历史 P7-B 重放/计数断言；`tests/fixture-gate.test.ts` 四项历史 SQLite 回归及其输入；`tests/verification-file-evidence.test.ts` 的真实 Guest RPC 样本；`tests/verification-raw.test.ts` 所引用的历史截图。

候选保留 P7-B 三项独立契约反例；fixture-gate 四类历史场景改成新建合成 SQLite，仍测试跨页来源、未渲染、候选截断和缺失属性；Guest 文件证据使用人工编写 before/after，仍断言 pass、wrong-content fail、missing-boundary unknown；PNG 换为同尺寸常量像素，仍验证 CRC、截断、几何和绑定。新合成数据不得冒称真实实验记录。

D1 Worker 传输测试的 2×2 假截图改为标准库生成 PNG，避免隐含依赖旧机器安装的 Pillow；认证、只读动作拒绝、MIME 和 PNG 字节断言仍保留。文本用 LF 签入，保证全新 Windows 检出的夹具指纹稳定。

A5 manifest/build-readiness/startup-gate/browser-probe/browser-window/runner-readiness/runtime-fingerprint 留在私有原工程。可复用 sidecar/readiness/execute-audit/request-meter/run-analysis/runner-io 保持现有目录，改为当前导入与合成 baseline；historicalAudit 私有留存，未调用原实验数据库。measurement 的 Case 类型只从原接口提取，核心 schema 未改。

所有阶段文档、真实评测、证据目录、数据库、截图、日志、browser state、缓存、阶段 p8/p9 排障脚本、P7 历史采集链继续在原工程留存。原工程未删除、封存或切换维护。本轮交付私有清单和源码完整性指纹，供后续确认完整私有现场及迁移；尚未把“只维护新主工程”作为自动完成的步骤。
