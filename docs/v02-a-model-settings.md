# v0.2-A · 本机普通模型设置（Issue #58）

状态：`A_IMPLEMENTED_REVIEW_PENDING`，交付独立 Draft PR 后停在 ChatGPT Review；未自行合并、关闭 #58 或启动 #59/#51。精确基线 `342778807b250874738dcff5de20acd032c95116`；候选 head 与测试统计记录在 PR/#58，最终 SHA 不预写入自身提交。

已有 `local-config.ts` / `configuredModelProvider()`、Root 注入与 TaskRunner 规划/决策创建链、预算/提示词保存；缺少普通模型持久化/API/设置表单。实现新增 `model-settings.ts`（本机存储及脱敏视图）、`model-settings.js`（表单），连接现有 server/workbench/静态入口；Root 与 TaskRunner 只绑定正确 rootDir 和单次执行的模型配置快照，未改 ModelProvider 契约、Agent Loop、Runtime 或 Workflow schema。

## 配置与作用范围

| 字段 | 生效优先级 |
| --- | --- |
| HTTP(S) 地址、模型名 | 非空进程 env → 本机 `config/model.local.json` |
| API Key | 非空进程 env → 本机 Key / 显式清除标记 → 旧 `.env.local` Key |

GET `/api/settings/model` 返回本机编辑值、有效地址/模型、`keyConfigured`、逐字段来源、配置完整性及未就绪原因。Key 永不返回，包括错误路径；配置完整不等于连接验证 PASS。PUT 仅接受本机同源 JSON（含 Origin）及 `endpoint/model/keyAction`，仅 `replace` 可附 `apiKey`；三种动作是 `keep`、`replace`、`clear`。地址禁止非 HTTP(S)、URL 凭据、query/fragment；普通模型不支持 JEV。读写均校验 schema/大小，失败返回静态脱敏错误，不 echo 请求/异常/私有路径。

私有文件及临时文件均被 gitignore 覆盖；同目录独占创建临时文件、rename 原子替换，Key 保留/替换/清除在 Host 执行。文件不加密，Unix 新文件 0600，Windows 继承目录 ACL；不能提交、分享、截图或拷贝到公共目录。显式清除不修改旧来源，禁止 `.env.local` Key 自动回退；env 仍优先。旧 `.env.local` 仅兼容 Key。JEV/辅助验证配置保持原链路、默认关闭。

保存/读取不会调用模型、连接端点、提交 Task、启动 Browser/Worker 或发送输入。新普通任务开始构造模型时读取一次配置快照，规划与探索/决策共享这份配置；排队任务在开始时读取，不在提交时将 Key 写入 Task/Workflow。已运行模型保持自己的配置。暂停/恢复继续原有生命周期，重新装配时读取当时配置；不将秘密持久化到任务检查点以跨重启保留旧 Key。

模型表单的 Key 不回填、不存 localStorage/sessionStorage/URL；提交 HTTP 前立即擦除密码输入，失败也清空，响应未确认后禁用重复保存并要求重新读取。离开设置页也擦除未保存 Key；插件页仍只读。预算/提示词入口保留。

## 人工核对手顺（无需真实连接或任务）

1. 打开已有 Dashboard 的「设置」，查看模型卡与逐字段生效来源；无配置时明确未就绪。
2. 填 API 地址、模型名称，选择「替换 / 新设 Key」，输入本机 Key 后保存；不要为验收调用真实模型。
3. 查看保存结果及有效来源；env 覆盖时显示环境变量仍生效，不能将私有保存视为已切换。
4. 刷新或重新读取，地址/模型仍在，Key 输入为空且只显示是否配置。保留或显式清除时无需输入旧 Key。
5. 只在另行授权真实 Task 时执行任务；本 PR 用合成注入/transport 测试证明新任务读取，不靠真实调用验收。

## 验证与边界

`model-settings.test.ts` 覆盖 GET/PUT、来源优先级、Key 三动作、无回显、错误/私有文件/原子临时文件、provider 快照；普通 Task 用 stub transport 拦截规划请求并在 Runtime 启动前停止，断言新模型/地址/认证进入现有注入链且秘密不进入 trace。`model-settings-ui.test.ts` 覆盖编辑/保存/刷新/Host 重启、覆盖解释、读写失败/未知结果、重复点击、密码擦除/不缓存、七宽度按钮命中；management Fixture 的 FakeModel/FakeRuntime/输入计数保持 0。预算/提示词、AppShell、控制归属及路由进行受影响定向回归。

不重跑大量全套 CI，不处理 #45 两项下载 canceled，不声明完整 Browser 全绿。精确命令、统计、截图仅本机的事实记录在 PR/#58；不提交截图、测试 DB、日志或凭据。保留 `A5 safety FAIL / Windows PAUSED / overall INCOMPLETE`、预算/权限/输入控制与默认辅助模型关闭。
