# D0-A 验证记录 · 2026-10-05

**合成 Win32 场景完成验证；完整 D0-A 未通过，不进入 D0-B。** 打包版 Notepad 尚不支持，现有 WPF TestBench 未运行。结果不改变历史 A5 safety FAIL、原 Windows 实验暂停及整体未完成的结论。

## 环境和安装

Windows build 10.0.26200 x64，Node 24.21.0，npm 11.19.0，Python 3.11.5。Playwright 使用现有 lockfile 和 Chromium 1243 / 153.0.8010.12。当前用户安装 Microsoft.WindowsNotepad 11.2607.14.0，System32 启动器文件版本 10.0.26100.8875。没有安装新依赖或选择许可证，其他版本未验证。

受限执行环境可以读取 Desktop 名称，但 GetCursorPos 返回访问被拒绝；该尝试未发输入，清理通过。随后在正常交互用户权限下显式执行实机命令，未要求应用管理员权限，也未去掉任何验证门。

## 离线及本地浏览器

| 命令 | 实际结果 |
|---|---|
| `npm run check` | PASS；现有 TypeScript noEmit |
| `npm run test:offline` | 422 PASS，0 FAIL；约 190.6 秒 |
| `npm run test:browser` | 50 PASS，0 FAIL；约 108.9 秒 |
| `npm run test:python` | 11 个文件均成功；原有 30 条 + Spike 16 条，合计 46 PASS |
| `npm run test:local-workspace` | 16 PASS，0 FAIL；与 Python 聚合中的 16 条重复，不重复计数 |
| `npm run test:local-workspace:browser` | 1 PASS，0 FAIL；Fake Worker，没有创建 Desktop |

现有符号链接测试因沙箱 EPERM 跳过创建链接分支，文件整体仍成功；不能宣称这个分支已验证。Python Spike 测试覆盖目标 PID/Desktop/Session/Job 错误、已退出目标、过期租约/命令/旧 run、禁止系统输入 API、重复脚本、部分启动失败清理、监控不可用、采集停更，以及令牌、Origin、Host 和字段限制。Fake Viewer 验证画面加载、固定脚本、输入文字不发送、Stop；页面自动输入不计为人工验证。

## 显式实机子集

| 用例 | 结果与证据 |
|---|---|
| 合成 Win32 夹具正常运行 | AUTOMATED_SUBSET_PASS；同 Session 的非 Default Desktop，本次 Job 成员，Default 目标窗口数 0 |
| 定向文字和点击 | PASS；控件实际读回合成文字，点击计数为 1；目视检查 PNG 也显示相同文字和计数 |
| 采集更新 | PASS；560×310，有效非单色帧；最终自动复验观察 16 帧，约 4.92 FPS；计时分辨率较粗，单帧记录常为 0 或 15–16 ms；目标约 5 FPS，未达到或宣称高帧率能力 |
| 静止场景防干扰 | 一次成功复验中前台事件 0、光标变化 0、321 个样本，首尾相同；其他活动场景中的用户移动另行记录，不归因于 Agent |
| 无效 HWND | PASS；输入前拒绝 |
| Viewer 租约断连 | PASS；约 3 秒停止，进程归零、Desktop 消失 |
| 目标进程退出 | PASS；仅终止本次 Job 中已登记的合成应用，随后 target_exited / Worker 停止 |
| 采集停更 | PASS；终止本次采集进程以冻结最后一帧，约 2 秒新鲜度超时停止；没有真的阻塞 PrintWindow，因此不能宣称验证了所有 GDI 卡死情况 |
| Worker 退出 | PASS；仅终止本次 Worker，约 3 秒心跳超时停止 |
| 正常和故障清理 | PASS；最终 5 个合成用例全部 Job 活跃进程 0、Desktop 不存在 |
| 已安装 Notepad | UNSUPPORTED；包预检发现打包版，未启动或采集，不读取恢复标签页，也不启动 Broker；经典 Notepad 操作路径本机 NOT_RUN |
| 本地 Viewer → 隐藏夹具 → Stop | AUTOMATED_SUBSET_PASS；真实 560×310 画面、文字和点击、持续帧更新、页面无 JS 错误，Stop 清理 PASS；无头浏览器不证明实际人类输入 |

人工参与者完成 Run → 延迟脚本 → 并行合成输入及移动鼠标 → Stop，报告“输入连续、鼠标无异常跳动、前台未被抢走”。对应会话约 15 秒，文字和点击 PASS，前台事件 0、光标变化 220、约 1447 个样本，Stop 后清理 PASS。记为 **人工报告通过，仅覆盖合成夹具**；不保存输入文字。另一会话未执行脚本，租约停止且清理 PASS，不计为定向输入通过。

人工会话在最后增加 WTSActive / Default 窗口只读检查之前完成；输入、捕获及 Viewer 脚本相同，新增检查随后通过自动实机复验。光标采样不能排除漏掉瞬时变化，事件及采样也不能识别变化是谁造成的。证据为本次有限观察，不能证明一般应用永不干扰。

## 实现期间的失败和修复

- 提交审查发现撤销输入租约会阻止正常 WM_CLOSE：为清理增加仍要求目标归属的关闭入口；停止采集不再误报采集错误；加入反例并复验正常和故障清理。
- 沙箱光标读取失败：保留阻断；监控首个完整样本成功后才允许创建 Desktop。
- 空 Desktop 枚举携带旧错误码：清除旧错误，空结果重试，真实错误仍停止。
- Windows 原子替换状态文件短暂共享冲突：限定重试，持续失败仍停止。
- 初次 Stop 中 Desktop 仍存在：先退出只读 WinEventHook 监控，再释放和检查 Desktop；后续正常与故障用例清理均通过。
- 目标退出测试最初从 Default 校验隐藏 HWND，被 target_exited 拒绝：改为只终止经过本次 Job 成员核验的登记进程，不从 Host 发送窗口输入。
- Playwright 浏览器路径初始化过晚：在动态加载 Playwright 前设置现有缓存路径；Fake Viewer 复验通过。
- 新增清理 mock 测试因 mock 默认拒绝 `assert_*` 属性而提前停止：显式声明只读检查 mock，确认部分启动失败确实清理已创建的 Job/Desktop。

修复前的失败、截图和原始日志私有留在忽略的 `.artifacts/` 中。本文及 validation-results.json 只保存不含令牌、绝对路径、PID、运行 UUID、窗口标题和输入内容的摘要。

## 未运行及进入下一阶段的条件

未运行真实模型、第三方站点、VM、原 A5 链路、通用系统输入、WPF TestBench、Chrome/Electron/Office 目标应用、UIA、WGC、IME、剪贴板、拖动、多窗口及人类接管。当前完整 D0-A 因已安装 Notepad 未通过而不满足进入 D0-B 的门槛。下一步应先单独设计并审查打包 Notepad 的安全启动和目标归属方案，或在具备经典 Notepad 的机器上显式验证；不通过降级到 Default 或系统输入来补齐结果。
