# D0 Capability Matrix

本表仅描述同一 Windows 的 Hidden Desktop Local Workspace Spike，不是 Provider 接口，也不表示任意 Windows 应用或完整虚拟电脑已通过。当前为 **OPEN_PENDING_D0D**；D0-C 有限子集已接受，D0-D 的同次真实 Resume 和专项并行干扰两门仍待人工证据。

| 分类 | 能力 | 结果 | 证据 | 边界 |
|---|---|---|---|---|
| Workspace | `SAME_OS` | PASS | D0-A/B/C | 同一交互 Session；仅当前 Windows 版本 |
| Workspace | `HIDDEN_DESKTOP` | PASS | D0-A/B/C | 唯一 Desktop 与 Job；不是独立 OS/账号/文件沙箱 |
| Workspace | `LOCAL_INSTALLED_APP` | PASS | D0-C | 仅网易云 3.1.40.205461，正常用户配置 |
| Observation | `GDI_CAPTURE` | PASS | D0-C | PrintWindow；固定归属窗口、有限尺寸和新鲜度 |
| Observation | `UIA_OBSERVATION` | PASS | D0-C | 仅暴露且属于本次 Job 的控件 |
| Observation | `VIEWER` | PASS | D0-B/C | localhost；Fake 自动回归与真实参与者 |
| Input | `TARGETED_WINDOW_INPUT` | PASS | D0-B/C | 归属 HWND 消息；有限文本、结果行与允许控件坐标 |
| Input | `SEMANTIC_INPUT` | PASS | D0-C 自动用例 | ValuePattern；仅有限搜索框编辑，不是任意 UIA 输入 |
| Input | `RAW_ISOLATED_INPUT` | NOT_PROVEN | 未实现/未运行 | 任意像素、按键组合、Canvas/DirectX 等不在本轮 |
| Input | `GLOBAL_INPUT` | FORBIDDEN | 既有静态反例与运行边界 | 本 Spike 禁用系统输入；不扩大到其他 Provider 的声明 |
| Ownership | `AGENT_TO_HUMAN` | PASS | D0-B/C | 有限控件与同步效果确认；未知效果 fail closed |
| Ownership | `HUMAN_TO_AGENT` | PASS | D0-B 人工 / D0-C 自动 | 网易云同一次人工完整闭环仍待 D0-D Gate D1 |
| Ownership | `EPOCH_REJECTION` | PASS | D0-B/C 自动与离线 | 旧代次拒绝；不延长运行预算 |
| Ownership | `LEASE_TIMEOUT` | PASS | D0-B/C | 3 秒租约；人类模式断连清理 |
| Ownership | `DURATION_BUDGET` | PASS | D0-B/C 人工 | 60 秒；NetEase 实际预算到期和清理已记录 |
| Ownership | `OWNED_JOB_CLEANUP` | PASS | D0-B/C | 本次 Job 归零、Desktop 消失；不结束外部实例 |
| Isolation | `DEFAULT_DESKTOP_FALLBACK` | FORBIDDEN | Spike 边界 | 归属/控制失败时停止 |
| Isolation | `SWITCH_DESKTOP` | FORBIDDEN | Spike 源码与静态检查 | 不申请切换权限；无切换调用 |
| Isolation | `SYSTEM_SENDINPUT` | FORBIDDEN | Spike 源码与静态检查 | 无系统键鼠、光标定位或前台激活回退 |
| Isolation | `DEFAULT_PARALLEL_USE` | PENDING | D0-C 总体报告 / D0-D Gate D2 | 故意持续输入、切窗口、移动鼠标的专项仍待报告 |
| Isolation | `SEPARATE_USER_PROFILE_FILES_NETWORK_AUDIO` | NOT_PROVEN | 同一用户/窗口站边界 | 现有配置、文件、网络、剪贴板和声音不独立 |
| Compatibility | `SYNTHETIC_WIN32` | PASS | D0-A/B | 原生合成 EDIT/BUTTON；不能替代真实应用兼容性 |
| Compatibility | `NETEASE_CEF` | PASS | D0-C | 指定版本/歌曲及有限接管 |
| Compatibility | `PACKAGED_NOTEPAD` | UNSUPPORTED | D0-A 包预检 | 没有实际激活；兼容性案例，不阻塞有限能力收口 |
| Compatibility | `CHROME` | NOT_RUN | 未运行 | 不增加应用范围 |
| Compatibility | `OFFICE` | NOT_RUN | 未运行 | 不增加应用范围 |
| Compatibility | `WPF_WINUI_OTHER_APPS` | NOT_RUN | 未运行 | 不推断通用桌面兼容性 |
| Observation | `WGC` | NOT_RUN | 未实现/未运行 | 不以新增捕获系统阻塞收口 |

`PASS` 仅在对应证据的版本、动作及限制内成立；`NOT_PROVEN` 不等于永久不可行；`UNSUPPORTED` 只描述当前入口；`FORBIDDEN` 是本 Spike 的明确边界。音频、普通配置、文件、网络与剪贴板并未隔离。

来源为 [D0-A](validation.md)、[D0-B](validation-d0b.md)、[D0-C](validation-d0c.md) 和 [D0-D 收口](validation-d0d.md)。机器可读副本见 [capability-matrix.json](capability-matrix.json)。历史 A5 safety FAIL、Windows PAUSED 及整体 INCOMPLETE 保留。Notepad、RAW_ISOLATED_INPUT 和其他应用不再作为本次有限能力收口的阻塞项。
