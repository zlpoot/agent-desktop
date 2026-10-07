# P7-B：环境内只读发现与候选快照

日期：2026-10-07。范围：#18 / Parent #16。基线：已合并 P7-A 的 `main` `ff63ab41db318413929cd2a085704a03bd2c44e4`。

状态：**P7-B PRE-REVIEW PASS / 本地实现候选，待独立复核与 PR materialization。** 仅交付 B；尚未 ACCEPTED / MERGED。C 的确认/启动验证、D 的 Task 与最小确认界面、E 的完整管理页尚未实现。

## 环境与端口

`ScopedAppDiscovery` 绑定精确 environment/installation scope，composition 用 `discoveredEnvironment()` 显式注入 P7-A 的 `EnvironmentAppService`。`queryEnvironmentApps()` 先验证所选环境及 Registry generation，再调用只读查询。无环境、未装配 discovery、旧 Registry 句柄都在扫描前拒绝；Core 无 Provider 分支，无 Host fallback。Root 的生产默认配置仍为空，不因 Provider discoverable 就扫描本机；后续可信装配必须提供安装域映射。

Physical 的 `WindowsAppCollector` 调用固定 Python 只读 helper，通过 stdin JSON 传递 scan/inspect 和有界配置；`shell:false`，不将名称、路径或参数拼入命令。Python 从机器 MachineGuid 与**执行用户 SID** 派生 `windows:<sha256>` 安装域，普通重启稳定；扫描前/后都核验安装域身份。配置域与执行用户不一致时，在枚举来源前拒绝，不扫描其他用户。

Local Workspace 仅通过 `sharedHostDiscovery()` 显式复用同 installationScopeId 的 Physical collector。快照 scope 重新绑定到所选 workspace，报告 `shared-host-os`，候选注明宿主 OS 来源及 workspace 启动/操作未证明。适配只依赖只读 collector，不打开 Session、不创建 hidden Desktop、不授予输入权，不继承 Physical 的确认或 launch-verified。

Guest 使用认证 `GET /state` 协商 `app_discovery: { protocolVersion: 1, scope }`，随后认证 `POST /apps/query`；请求白名单为 protocolVersion/scope/operation/limits，以及 inspect 的 path。Guest 核验自己 VM environment 与实际安装域，读取前后身份必须一致；Host 校验协商和回复的完整 scope/version，不在 Host 上 stat Guest 路径。旧 Guest、不支持、断连、身份错配都返回 unavailable，无 Host fallback。查询不走 action lock、owner、control epoch 或 desktop readiness，不调用 desktop RPC。现有 action/control/recovery、公共 DesktopProvider 与 Task/Workflow schema 不变。Guest 部署文件列表已增加 `app_discovery.py`；本轮没有实际复制到 VM。

## 首版来源与限制

- 当前执行用户开始菜单 Programs、公共开始菜单 Programs，只在这两个根中有界枚举；不遍历其他用户、文档或全盘。
- HKCU App Paths 默认视图、HKLM App Paths 的 64/32 位视图，只读默认可执行路径；不读取/使用卸载命令或任意 shell verb。
- `.lnk` 采用纯二进制读取 MS-SHLLINK 的本地 fixed-volume LinkInfo 与 StringData，提取实际 EXE、argv、working directory。没有 COM Resolve、ShellExecute、快捷方式执行或自动修复搜索。
- UNC、网络/非固定盘、设备/ADS、reparse 路径、脚本/命令解释器包装、无效/缺失目标、非 EXE 以及无法安全解释的高级 flags/ExtraData 明确拒绝。首版**不支持** advertised/environment-expansion/ID-list-only shortcuts 和额外数据块；这些拒绝计入覆盖缺口，提示手工 EXE 路径，不宣称未安装。
- PE version/publisher 可读时作为描述信息，未知不伪造；文件摘要与启动定义用于私有候选快照，不能证明产品身份/进程/窗口归属，不产生 verified。
- 当前未枚举 StartApps/AppX 包元数据；类型契约可保留可信 collector 提供的 package 信息，并标明 `package-launch-not-implemented`，不伪装成 EXE。

扫描默认全来源共享最多 500 条（目录/非 LNK 项也消耗额度）、菜单深度 5、总超时 5000ms；可显式配置 1–2000 条、0–10 层、10–30000ms。LNK 上限 128KiB，EXE 摘要读取上限 64MiB；摘要按 chunk 检查 deadline。TS 超时中止传输、Host helper 被终止；Guest 文件枚举/读取协作检查 deadline。回复上限 2MiB，不引入全机遥测。单个来源的完整/权限失败/超时/条目或深度截断分别记录 inspected/rejected/reason，保留其他来源已读出的合法候选。

来源实现参考：[Microsoft App Paths](https://learn.microsoft.com/en-us/windows/win32/shell/app-registration)、[MS-SHLLINK LinkInfo](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-shllink/6813269d-0cc8-4be2-933f-e96e8e3412dc)、[StringData](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-shllink/17b69472-0f34-4bcf-b290-eccdb8de224b)、[Shell Links 的 Resolve 行为](https://learn.microsoft.com/en-us/windows/win32/shell/links)。没有运行实际机器扫描来证明覆盖率。

## 去重、分类与手工路径

候选 envelope 保存 opaque candidateId、revision、私有 digest、P7-A candidate、来源、可读版本/发布者及限制。按实际规范化目标 + argv + working directory 去重，EXE 与重复快捷方式可合并来源；不同路径、版本安装、便携版或不同启动参数分别保留。同名查询可排序但不选择首项：一个为 found，多个为 ambiguous。任何数量的候选仍为 discovered，无 Registry 写入、确认、启动或 capability 提升。

报告区分 complete/incomplete/unavailable；查询仅在覆盖完整且零匹配时返回 `not-found-within-scanned-sources`。来源失败、被拒绝目标、权限不足、超时/截断且零匹配为 unavailable，不改写为“没有安装”。有效部分匹配可返回 found/ambiguous，同时保留 incomplete 及覆盖缺口，唯一候选仍需要 C/D 的人工确认。

手工输入仅接受所选环境绝对 `.exe`/`.lnk` 路径，由该环境 collector 读取、解析并返回相同结构的候选；不存在/目录/不支持类型等保留明确原因。调用者不能替换解析所得 argv。结果提供 `specify-path` / `rescan-after-install` / `cancel` 后续动作；B 不下载、安装或卸载，不交付 UI。安装后再次调用 scan/query 即重扫，每次都更新 revision、生成新候选 ID 并清除旧快照；未知/过期候选不能引用。重扫不恢复 Registry 旧确认、撤销或 installation incarnation。手工候选也不自动登记/授信。

`modelDiscoveredApp()` 只输出名称/别名、opaque candidateId、revision 和 discovered；路径、argv、fingerprint、来源引用、publisher、安装域及 digest 不进模型视图。可信确认界面到 P7-D 再使用私有 envelope。P7-A 原 contract 与 validation 没有扩大字段，scan/inspect 仍兼容原 discovery 端口。

## 验证

定向发现/Registry 合同及 Python 合成 scanner/Fake Guest 已验证环境隔离、无环境零扫描、Local 映射、去重与歧义、唯一候选不授信、覆盖分类、超时/截断、手工路径与恶意包装、重扫/撤销、旧 Guest 协商、回复身份漂移以及原 action/control 状态保留。公共 fixtures 只使用临时合成 LNK/EXE/注册信息；无真实安装清单、用户路径、截图或凭证。

最终定向 discovery **10/10 PASS**、Python discovery **7/7 PASS**；先前 discovery + 原 Registry **27/27 PASS**，之后只给新增 Host helper 与模型投影补充受影响的定向检查。实现期第一次日志管道因 `.artifacts` 目录未创建而失败，未计为测试通过；创建目录后执行定向验证。未以重复矩阵替换失败记录。

最终源码必要矩阵按 check → offline → Python → diff-check 顺序执行一次，各退出码为 0：

| 检查 | 结果 | ignored 本地日志 |
|---|---|---|
| `npm run check` | PASS | `.artifacts/p7-b-check.log` |
| `npm run test:offline` | **628/628 PASS**，0 fail / skipped | `.artifacts/p7-b-offline.log` |
| `npm run test:python` | **14/14 契约文件 PASS**，failed: [] | `.artifacts/p7-b-python.log` |
| `git diff --check HEAD`（包含新增文件） | PASS | `.artifacts/p7-b-diff-check.log` |

源码测试后仅补充本文验证记录并审查/提交。未改变网页/UI 或 Dashboard HTTP；Guest 管理 HTTP 由 Fake Guest 与 Python Worker 合同覆盖，按 AGENTS.md 不运行 Browser。未调用真实模型、实机应用启动/输入或 VM 控制，未运行 Guest 部署脚本。没有真实安装扫描验收记录，自动化通过不等于实机发现覆盖率。历史 A5 safety FAIL、Windows PAUSED、overall INCOMPLETE 不变。
