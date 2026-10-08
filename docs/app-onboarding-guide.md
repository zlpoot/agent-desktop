# 首次使用应用：先选择环境

应用管理与 Task 确认卡片使用同一份按环境保存的配置。页面入口是 Dashboard 左侧的「应用管理」。应用管理默认关闭；只有维护者通过可信 composition 显式开启 `environmentAppManagement: true`，并装配对应环境的 discovery/managed launch 端口后，才能操作。普通 Task 文本、页面参数、环境变量均不能开启这些端口。未装配时页面显示不可用，维护者应先检查配置；不要把本机路径填到另一台 VM 来绕过限制。

本说明中的「AA音乐」「QQ音乐」以及 `C:\Synthetic\Music.exe`、`D:\Synthetic\Music.exe` 全部是合成占位数据，不表示你的电脑安装了这些应用。当前验收 **synthetic / NOT LIVE-VERIFIED**。真实应用、模型、VM 与业务输入仍需另行明确授权和配置。**A5 safety FAIL / Windows PAUSED / overall INCOMPLETE** 不变。

## 第一次使用

1. 在工作台下达任务前，先明确选择执行环境。也可进入「应用管理」选择对应虚拟机、本机交互桌面或本地隔离工作区。没有选择时不读取应用配置、不扫描、不启动；进入页面也不会默认选择当前 Viewer 或第一台机器。
2. 在所选环境下达任务，例如「使用 AA音乐 搜索合成歌曲」。未知应用会停在原 Task 的确认卡片。也可以主动点击管理页「扫描 / 重扫」。选环境只读取配置；扫描是另一项显式操作。
3. 选择具体安装实例。即使只有一个候选，也必须选择。多个版本或便携版请核对版本、发布者、来源、路径和参数；名称相同不代表同一个安装实例，不默认采用首项。
4. 管理页点击「查看确认内容」，核对环境、安装信息、配置版本与启动范围；再点击「确认并验证启动」。Task 卡片已有对应的确认操作，直接使用原卡片即可。确认操作授权本环境的受控启动验证，不授权任意业务动作。
5. 验证成功后配置保存到该环境的私有 Registry。软件已经运行时，服务先核对安装、进程/窗口归属和权限，再复用合法实例；不会仅凭窗口标题或路径相同就绑定。
6. 回到原 Task 查看结果。通过 Task 卡片确认且原任务仍有效时，会继续同一个 Task，保留原预算和上下文。管理页自身不恢复、重建或重放 Task；原 Task 正在等待确认时，回到原卡片按其提示处理，管理页操作可能使原候选修订过期，此时应重扫。若原 Task 已结束、Session 失效或 Host 重启，显式新建 Task，不继续旧动作。
7. 后续在同一环境正常使用有效配置，无新增确认。每次使用仍要重新核验实际安装和目标；启动成功不等于业务任务成功。

## 页面中的四层状态

| 状态 | 含义 |
| --- | --- |
| discovered | 只读发现的候选或导入记录，尚无使用许可。 |
| confirmed | 操作员确认了该环境、安装域和精确配置版本。离线可以保留确认；配置变化不能继承旧确认。 |
| launch-verified | 该配置曾通过受控启动及归属核验。时间和历史证据可查看；保存的记录不是当前运行目标、输入许可或 Task receipt。 |
| business-capable | 仍须 P6 对应用、版本、角色、动作与机制的独立证据。管理页将通用业务能力显示为 not-proven，并单独列出已装配的有限场景及其真实限制。 |

「Task 兼容准入」只说明执行器的通用入口是否存在，不表示这个应用已证明可操作。Physical generic 不支持；Native Physical 缺可信 dispatch fence 时拒绝新启动。Local Workspace 可能共享宿主 OS 安装来源，但确认和验证独立，需要 managed backend 与 owned Hidden Desktop binding，不能把主桌面窗口许可搬进去。真实执行器缺可信 launch-to-Task bridge，或该 bridge 无法在效果发生处检查当前注册信任时，继续 fail-closed。RAW、Notepad、QQ音乐、未知应用不因注册而获得通用业务能力；Guest 不支持管理协议时不会回退 Host。

## 遇到问题

| 情况 | 下一步 |
| --- | --- |
| 没有候选 | 仅表示已扫描来源中没找到。指定**所选环境内**的 `.exe` / 安全本地 `.lnk` 路径，或自行安装后点击重扫。页面不下载、安装、卸载或提权。 |
| 多个安装版本 | 逐一核对版本、路径、发布者与来源，明确选择；选错可取消本次接入，重新扫描。 |
| 扫描 incomplete / unavailable | 查看来源覆盖、权限或断连原因。不能据此断言「未安装」。恢复环境后重扫，不跨环境尝试路径。 |
| 环境离线 | 保留原确认与历史，不伪造当前可用。恢复后显式「重新验证启动」，不会重复注册有效配置。 |
| 软件删除、身份或版本变化 | 旧配置标记 stale，重新发现并确认新配置。旧版本业务证据不会自动覆盖新版本。 |
| 修改路径或启动参数 | 由该环境的可信发现/快捷方式配置产生新候选，再确认、验证。新定义没有旧 verified；管理 API 不允许塞任意 executable/args/shell，普通 Task 接口也不接受。 |
| 启动失败 | 看最近验证时间、失败原因和可用性。先检查连接、安装身份及适配范围，再决定重扫或显式验证。结果未知时不盲目重启；服务保留 unknown-result 防重试边界。 |
| 取消、刷新或切换环境 | 页面丢弃候选选择与确认会话，并撤销本页在途管理操作；晚到结果不能显示或用于新环境。重新选择后读取已保存配置，不自动扫描或启动。 |
| Host 重启 | 配置保留，页面会话/确认摘要/运行 receipt 不恢复。旧 Task 不自动重放；需要新 Task。 |
| 撤销注册 | 点击对应配置的「撤销注册」。撤销本项目配置的信任，成功确认后，运行中 Task 也不能产生该配置的新业务效果。已发生的效果和历史审计保留；不卸载软件、不关闭用户已有进程、不重放原 Task。撤销记录不能靠重新验证恢复，后续接入须有效的新配置和显式确认。 |

原始路径、参数、安装身份与详细历史只通过本机同源可信操作员接口读取，不进入模型视图或公开日志。不要把扫描清单、用户路径、数据库、密钥或真实截图提交到仓库。

## 显式导入旧 JSON

新用户走上述页面流程，无需手写 JSON、猜 PID/HWND/windowClass。已有旧配置时，由维护者执行 P7-A 的 `importLegacyApps(rootDir, source, scopedRegistry)`：

1. 明确选定目标环境，使用可信 composition 返回的 `assembly.environmentApps.forEnvironment(selectedTarget).registry`，核对其安装域。
2. 显式选择 `apps.local.json` 或 `config/agent-desktop-apps.json`，只在该文件实际属于所选安装域时导入；VM 不能使用 Host 文件冒充 Guest 清单。
3. 通过 `src/environment-apps/legacy-import.ts` 的导入函数单向写入 Registry。它只读旧文件，不自动导入、不双写、不把 windowClass/窗口标题当作归属证据。
4. 导入条目为 discovered，无 identity、确认与验证。回到管理页指定路径/扫描得到服务器检查的候选，再按首次确认流程验证。若检查后的安装实例与旧导入记录成为两条配置，验证新配置后撤销旧 discovered 记录，避免同名歧义。旧文件只是明确的来源，不能作为 verified 配置或运行目标直接使用。

导入示例（仅说明可信维护代码，不是普通 Task 或公共 HTTP API）：

```ts
const selectedTarget = { providerId: 'synthetic-provider', environmentId: 'synthetic-environment' };
const registry = assembly.environmentApps.forEnvironment(selectedTarget).registry;
await importLegacyApps(rootDir, 'apps.local.json', registry);
```
