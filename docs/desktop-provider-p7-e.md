# P7-E：按环境应用管理、说明与合成产品验收

日期：2026-10-08。Issue [#21](https://github.com/zlpoot/agent-desktop/issues/21)，Parent [#16](https://github.com/zlpoot/agent-desktop/issues/16)。实施基线：`fb8862fb70eadf11c3016e2dfa90f180689043bb`。本候选待 ChatGPT Independent Review；未自行接受、合并或关闭 Issue，未宣告 P7 全部验收完成。

## 实现与限制

Dashboard 新增独立「应用管理」导航及 `#/apps` 页面，保留 P7-D 原确认卡片。环境选择无默认值，只读取该环境 Registry；扫描、手工路径、查看确认内容、确认启动、重验、撤销均是显式操作。切换环境、离开页面、取消与 pagehide 清空选择和路径，关闭旧操作会话；请求序号丢弃晚到 open/scan/prepare/confirm 响应。late open 得到的会话也会关闭。文本通过 textContent 展示，无 HTML 注入。

`POST /api/desktop/apps` 是本机私有操作员 API，不暴露为模型工具。所有读取和写入都要求 Origin、同源 localhost/127.0.0.1 Host、非 cross-site、JSON 和 4096-byte body。动作字段白名单，客户端只选择 providerId/environmentId；安装域和 adapter 来自可信 composition。只允许 candidate ID/revision 或 path 经服务器检查，不允许 launchSpec/executable/shell/operatorId/trust/runtime target。错误仅返回稳定代码，adapter 的路径异常不透出或写日志。

`environmentAppManagement` 默认关闭，只有可信 `createRootAssembly` / Controller options 显式开启才创建管理协调器；依然需要明确配置环境 discovery 和 managed launch 端口。现有 Dashboard 启动脚本不默认开启，不增加网络、实机配置或新依赖。

会话是随机、五分钟有界的内存对象，绑定所选环境、安装域和原 service 身份；过期计时器撤销在途启动。列表不扫描、不取得 Session/输入权、不调用模型。每次操作重查环境和 Registry 持久代次；页面 revision CAS 和 requestId 指纹幂等限制并发、旧响应及重放。确认仍使用 P7-C prepare/display digest/安装复核/配置 CAS；重验仍使用 P7-C reuse，明确 allowLaunch 且需要可信启动后端的原 policy/permit。撤销调用原 P7-C revoke，保留历史；重复确认返回当前视图，不能把已撤销配置重新显示为有效或再启动。

协调器不发起/继续 Task，不把启动 target receipt 暴露 HTTP 或持久化。P7-D 的原任务恢复、终态、预算、输入权和可信 bridge 逻辑保持原样。管理页、卡片与 Task 后续复用共享同一个 `EnvironmentAppServices` Registry/onboarding 事实源。

页面分别显示 discovered、当前配置 confirmed、历史 launch-verified 和业务 not-proven；从现有 `desktopOptions` 读取执行器准入、blockedReason、P6 固定场景与其应用/版本限制。安装源 shared-host-os 与环境独立确认保持分开。Physical generic、Native Physical dispatch fence、Local Workspace managed backend/owned Hidden Desktop、RAW、Notepad 和真实 Task bridge 缺失继续 fail-closed。本轮没有实施 native bridge、真实 QQ音乐业务或新的 Provider/协议/schema。

用户流程与故障处理见[首次使用说明](app-onboarding-guide.md)。无需新用户手写 JSON；旧配置仅走显式 P7-A 导入，仍为 discovered。

## 合成验收索引

所有新 E2E 使用 production `createRootAssembly` → `composeEnvironmentApps` → SQLite Registry/P7-C 服务 → Dashboard HTTP/真实 localhost Browser，基础设施是 Synthetic backend。与原 Task 的衔接使用 P7-D FakeModel/Fake Worker 私有目标夹具。没有第三方站点、真实模型、用户浏览器状态、VM 控制、实机应用启动或业务输入。

| #21 验收项 | 对应证据 |
| --- | --- |
| 未选环境零扫描/启动；VM-A/B 晚到隔离 | 新 HTTP defaults-off/isolated-scopes 和 Browser late-response 用例，inflight close 用例。 |
| QQ音乐同环境第二用零新增确认、合法已运行复用 | 新 shared-registry Task 用例及 HTTP reverify；P7-D 正常二次 Task 用例。 |
| AA音乐唯一候选须确认、原 Task 继续、重复确认只启动一次 | 新 Browser 单候选选择与两阶段确认、HTTP duplicate；原 P7-D same-Task/预算保留用例。 |
| 多候选、路径、安装后重扫、权限/断连/不完整 | 新 HTTP manual/multi/incomplete/offline 与 Browser manual/multi/offline；P7-B rejected coverage / P7-D reject/recovery 用例。 |
| 删除、身份/参数/版本变化，离线保留确认，业务证据不升级 | 新 deleted/argument-drift 与 offline/version/unknown-result 用例。 |
| 同 OS 来源共享但 Physical/Local 确认验证独立、Guest 不回 Host | 新 production shared-domain 独立 Fake launch 用例及默认 fail-closed 界面；已有 P7-B/C Guest/adapters 合同。 |
| 取消/撤销/刷新/Host 重启/晚到确认不重放 | 新 HTTP inflight cancel/revoke/restart 与 Browser refresh；P7-D terminal/late/cross-Task/restart 回归。 |
| 伪造/跨环境/不可信候选，Task 无任意 executable | 新 HTTP allowlist/origin/body/CAS/digest/permit negatives、Browser inert text；P7-D Task HTTP negatives。 |
| 注册与业务 capability 分层，原风险/预算/输入/验证保持 | 新 capability labels/zero-model-input-runtime 与 shared-service Task 用例；既有 P6/P7-C/D 回归。 |
| 依说明完成流程，不猜 PID/HWND/windowClass | 真实 Browser 导航、环境/候选选择、确认、手工路径、撤销、刷新及移动端布局；说明覆盖原 Task 返回及显式旧配置导入。 |

新增 `tests/app-management.test.ts` 九个 HTTP/服务用例、`tests/app-management-ui.test.ts` 两个 Browser 用例；合成首次验证和现有 P7-D 定向回归已通过。初轮新增测试失败日志保留：负向请求错误复用同一 requestId（幂等冲突）、Browser 未展开帮助即断言隐藏内容；修正的是测试请求/读取流程，未放宽行为或跳过失败。

最终所需矩阵只对提交后的 exact head 运行一次，原始日志保留 `.validation/p7-e-{check,offline,python,browser}.log`，结果、完整 head 与下载基线对照写入交付 PR。日志、截图、SQLite 和生成资产不提交。Browser 历史 `download.saveAs: canceled` 必须用精确基线对照并保留 FAIL；不能用它解释其他新失败。

## P7 已合并索引与停点

| 阶段 | Issue / PR | accepted squash SHA |
| --- | --- | --- |
| P7-A | #17 / #22 | `ff63ab41db318413929cd2a085704a03bd2c44e4` |
| P7-B | #18 / #23 | `2cafd7668386e2e59e0184c433169eacc9253139` |
| P7-C | #19 / #24 | `d448e0df629ec73fd868ca17dd869917c35a4d30` |
| P7-D | #20 / #25 | `fb8862fb70eadf11c3016e2dfa90f180689043bb` |
| P7-E | #21 / 本候选 PR | 等待 Independent Review，未接受/合并 |

P7 最终收口仍由 Parent #16 的独立评审决定。真实环境可用性 **NOT LIVE-VERIFIED**；真实 native launch-to-Task bridge、Physical native fence、广泛 Local Workspace 支持及任意业务能力未证实。**A5 safety FAIL / Windows PAUSED / overall INCOMPLETE** 保持不变。
