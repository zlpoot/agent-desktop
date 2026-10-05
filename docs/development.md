# 开发与测试

遵循 README 安装；不复制 node_modules、浏览器缓存或数据库。`npm run check` 是原 noEmit 类型校验。版本由原 lockfile 决定；本次只改变根包名称及脚本，未升级依赖。

`test:offline` 运行不启动浏览器的 TypeScript 文件；`test:browser` 运行清单里的本地浏览器/控制台测试（同文件里的纯逻辑断言也随组运行）。`test:python` 逐文件运行所有 Worker/输入控制/采集契约。系统查询测试仅检查当前测试进程和本地测试端口，不发送真实输入。Windows 符号链接创建不可用时，会输出 diagnostic 明确跳过链接分支，不能据此宣称该分支通过。

覆盖关系：风险批准与安全门见 human-loop、structured-acceptance、verification-*；预算见 model-budget、candidate-budget；暂停/接管/断连恢复见 desktop-control*、guest-control-epoch、worker-reconnect、crash-dispatch；Workflow 学习与回放见 workflow-learning、workflow-execution*、workflow-recovery*；迁移与版本见 workflow-schema-v2、workflow-version-rollback。测量 readiness 仅为合成数据演练。

迁移工具仍按原 CLI 工作：`npm run workflows:migrate-targets` 处理当前目录的 `workflows.sqlite`，先备份到 `.artifacts/workflow-backups`，然后原地迁移；没有路径参数或 dry-run。只在自己的可弃测试库或另行授权的库上执行，不要对历史实验快照执行迁移。

新增或调整测试时保留反例目的：错误目标、过期证据、unknown、未确定 dispatch、恢复版本边界不得改成成功。合成图片只测试解析及几何边界，不证明真实截图采集/语义识别。评测输入不得向模型暴露预期标签。

验证记录区分安装下载、离线测试、本地浏览器与现场实验；失败必须记录，修复后可复验，但不得删除历史实验 FAIL。现场入口仅显式执行，本地脚本名包含 smoke 并不自动意味着离线安全。

D0-A/B 是 `spikes/local-workspace` 中独立的受控实验。修改该目录后增加 `npm run test:local-workspace` 和 `npm run test:local-workspace:browser`；前者也由 `test:python` 纳入。带 `:windows` 的入口会启动真实隐藏桌面应用，单独授权、执行和记录，不计入离线通过数字。根提取分类清单记录提取时的基线，本轮新增 Spike 的来源、范围和后续验证见其 README、D0-A validation.md 与 D0-B validation-d0b.md。
