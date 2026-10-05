# D0-A/B/C：同 Windows 隐藏工作区 Spike

独立技术实验，尚未接入 DesktopProvider、Agent Loop、Workflow 或 Guest。只验证隐藏 Desktop 内的合成 Win32 控件、已安装经典 Notepad 的有限能力。现有 WPF TestBench 不是本实验的原生夹具，尚未运行。

目前合成 Win32 夹具的自动子集通过，人工并行输入也已由参与者报告通过；完整 D0-A 尚未通过。当前机器安装打包版 Notepad 11.2607.14.0，本入口将其标记为 `UNSUPPORTED`，没有启动该应用。打包版的无会话恢复启动、Broker 重定向与现代控件操作尚未实现，不能把这个结果解释为 Windows 上永久不可行。人工报告只覆盖本次合成夹具，自动测试不代替人工结果。详见 [本次验证](validation.md)。

历史 A5 `safety FAIL`、历史 Windows 实验暂停及整体未完成的结论保持不变。本次 D0-A/B 是用户单独授权的受控试验，不恢复原实验链。用户在完整 D0-A 未通过的情况下，明确授权进入仅限合成夹具的 D0-B；这不是 Notepad 或完整门槛通过。合成夹具的接管与恢复自动子集通过，人工参与者也报告通过；结果独立记录在 [D0-B 验证](validation-d0b.md)。

## 入口

在仓库根目录运行；只验证了 Windows 10.0.26200、Node 24.21.0、Python 3.11.5。Python 使用标准库，无需新的 pip 依赖、模型账户、密钥、数据库、VM 或第三方站点。

```powershell
# 离线契约和 Fake Viewer
npm run test:local-workspace
npm run demo:local-workspace

# 已安装匹配的 Chromium 后，测试 localhost Fake Viewer
npm run test:local-workspace:browser
```

以下入口明确执行实机实验，只在授权的机器、正常交互用户会话中运行。受限沙箱可能不能读取真实光标；若被拒绝应停止，不能移除监控门。运行账户无需提升为管理员，勿以服务账户或 Session 0 执行。

```powershell
# 启动 Viewer，尚未启动任何应用
npm run demo:local-workspace:windows

# 自动实机子集及故障注入；UNSUPPORTED 仍会出现在结果中
npm run test:local-workspace:windows

# 通过无头本地浏览器验证 Viewer → 隐藏夹具 → Stop
npm run test:local-workspace:viewer:windows

# D0-B Viewer 接管、暂停中编辑、恢复、旧代次拒绝与人类控制期间断连
npm run test:local-workspace:takeover:windows
```

打开控制台打印的完整 URL。URL 片段携带本次访问令牌，页面加载后移除；刷新需要重新打开原 URL。不把 URL、令牌或运行目录提交到仓库。

Viewer 选择合成夹具 → Run → 运行固定脚本 → Stop。脚本输入 `hello from agent workspace`，在夹具里点击一次按钮。每次运行最多 60 秒，仅执行一次固定脚本（26 个字符、一次点击）；Viewer 租约 3 秒，断连后停止。Ctrl+C 停止服务并清理。所有预算、租约和命令到期检查使用单调时钟。

人工并行检查：Run 后选择“5 秒后运行脚本”，在页底输入合成文字并移动鼠标，确认输入连续、鼠标无异常跳动、前台未被抢走，然后 Stop。输入框内容不会读取、发送或持久化；页面输入事件计数也不被当成人类证明。参与者需报告实际观察，再关联该运行记录。不要输入私人数据。

## D0-B 接管与恢复

选择合成夹具 → Run → 运行固定脚本 → 在脚本尚未结束时点击“接管 Take Control”。等待“人类控制”后，点击画面内文本框，输入合成 ASCII 文字，可用 Backspace；点击画面内按钮。再点击“恢复 Resume”，固定脚本从已完成字符数继续，不清空人类修改、不重放整段。也可在启动脚本之前接管；只有此前明确请求过脚本，Resume 才会继续该意图。停止后需要重新 Run。

切换控制权先增加输入代次、撤销旧权限并清空队列，然后等待 Worker 完成此前同步消息和目标内取消；确认前双方输入均禁用。每条键鼠消息重新校验当前代次及 HWND 归属，旧 Agent 或人类消息不得在下一代次执行。Resume 不创建新运行、不延长 60 秒预算，也不重置输入事件预算。

人类输入仅在画面获焦并且控制权已确认时转发。必须先点击 EDIT；点击仅支持 EDIT / BUTTON 的客户区。PNG 与元数据 SHA 必须一致，Viewer 将含边框、CSS 缩放的坐标换回原生像素，Worker 再核验当前窗口尺寸与控件边界。每次最多 256 个事件、队列最多 16 项、每项有效期 2 秒、控件文字最多 512 字符。人类点击不是移动真实系统鼠标。快捷键、中文输入法、粘贴、拖动、滚轮、标题栏和其他窗口均不支持。

接管文字会通过本地 IPC 临时传送，命令消费、切换或 Stop 时删除；状态摘要仅记录长度、进度、动作数和拒绝理由。私有帧会显示输入文字，因此这里只输入合成内容。页底并行输入框始终仅留在本页，与隐藏窗口输入分开；人工体验结果需要参与者实际观察和报告。

## 实验边界

Host 和 Viewer 留在 Default；Worker、应用、采集进程经 `CreateProcessW` 的 `lpDesktop` 启动在唯一的 `WinSta0\AgentD0_*`。操作 HWND 前逐次校验存活、PID、Session、Desktop 及本次 Job 成员身份，并要求用户 Session 为 WTSActive、输入 Desktop 为 Default。Host 只读核验 Default 上没有目标应用 PID 的窗口。Host 不向隐藏 HWND 发送输入，输入与采集都由绑定目标 Desktop 的子进程完成。

原生夹具为新编写的 EDIT / BUTTON / STATIC 窗口，持续显示合成计数器；没有导入旧截图或原 TestBench 的订单界面。固定输入仅使用同步目标消息 `WM_CHAR` 和控件的 `WM_MOUSEMOVE / WM_LBUTTONDOWN / WM_LBUTTONUP`；读取实际控件状态核对文字与点击结果。D0-B 加入有限的人类接管，仍没有 UIA、任意键鼠指令、IME、剪贴板、拖动、多窗口、WGC 或通用应用支持。

禁用系统输入、光标定位、前台抢占、线程输入关联、广播 HWND 和桌面切换。创建 Desktop 不申请 `DESKTOP_SWITCHDESKTOP`，没有 `SwitchDesktop` 调用。锁屏、权限不足、错误目标、租约到期均停止，不回退到真实桌面。独立于主工程，未修改模型预算或现有控制权协议。

PrintWindow 在独立采集进程执行，目标约 5 FPS；旧帧超时会停止整个运行。PrintWindow 返回成功不能单独证明画面有效，结果另检查非单色图像、更新、输入状态和目视截图。正常停机尝试关闭已核验窗口，随后只终止本次 Job；确认进程归零、释放监控 Hook 和 Desktop，再检查桌面对象消失。Job 使用 `KILL_ON_JOB_CLOSE` 防止 Host 异常退出遗留子进程。采集进程和 Worker 不持有长期 Job 句柄。

打包版 Notepad 或包探测失败时，不创建工作区、不启动 Notepad。经典版本只从系统安装位置解析路径，拒绝覆盖非空编辑框。未绕过 UIPI、没有应用提权或修改注册表。Notepad 文本输入与夹具像素点击分别记录，不能把语义/文本能力描述成完整鼠标能力。

同一个 WinSta0 中的 Desktop 共享窗口站资源，包括剪贴板；这是窗口归属实验，不是文件、账户、网络或恶意应用的安全沙箱。前台事件由只读 WinEventHook 记录，光标每约 10 ms 采样，只保存计数及首尾相等标记，不保存标题、坐标或真实按键。用户主动移动和切换窗口的变化不能直接归因于 Agent；光标采样不能证明没有漏掉短暂变化。

## 私有运行记录

`.artifacts/local-workspace/` 保存每次的状态、合成截图、控制文件和结果；`.artifacts/local-workspace-viewer-real/` 保存 D0-A 本地 Viewer 验证，`.artifacts/local-workspace-takeover-real/` 保存 D0-B 自动接管验证。均已被根忽略规则覆盖，不提交生成二进制、运行 PID、个人机器路径或令牌。`verification.json` 中 `UNSUPPORTED`、`BLOCKED`、`NOT_RUN` 不计为通过；CLI 返回 0 仅表示已执行用例未发生 FAIL/BLOCKED，不表示完整 D0-A 通过。

`npm run test:python` 包含本 Spike 的离线 Python 契约；主工程的 `check` 仍为 noEmit，未新增打包系统或升级依赖。浏览器 Spike 测试单独运行，现有 `test:browser` 清单保持原样。

## 来源

此目录代码为本轮新编写；ctypes 结构和调用按公开 Win32 ABI 定义，没有复制第三方实现或素材。运行依赖仅为现有 Python、Node、Playwright 及 Windows 系统 API；没有增加项目许可证。API 依据：[CreateDesktopW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createdesktopw)、[STARTUPINFOW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-startupinfow)、[SetThreadDesktop](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setthreaddesktop)、[PrintWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow)、[PostMessageW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-postmessagew)、[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[Window Stations](https://learn.microsoft.com/en-us/windows/win32/winstation/window-stations)、[SendMessageTimeoutW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendmessagetimeoutw)、[WM_CANCELMODE](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-cancelmode)、[EM_GETSEL](https://learn.microsoft.com/en-us/windows/win32/controls/em-getsel)、[ClientToScreen](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-clienttoscreen)。

## D0-C：安装版网易云真实应用边界

当前 D0-C 已接受，仅限本次网易云启动、孙燕姿《我怀念的》检索/播放及有限接管子集。自动用例通过，人工参与者也报告“我验证了，没问题”；人工运行验证了 60 秒预算停机与清理。人工日志未记录 Resume，恢复和搜索框合成编辑的证据来自自动用例。完整 D0 仍 OPEN，详见 [验证记录](validation-d0c.md)。

仅按用户授权检索孙燕姿《我怀念的》并尝试正常播放；不登录、购买、下载或改变账号。本次复用已安装应用的普通用户配置，应用可能显示已登录账号、收藏和播放历史。隐藏 Desktop 不是独立账号或文件沙箱，也不能隔离声音。该应用是 CEF 多进程客户端，不是经典 Win32 控件对照。历史 Notepad 结果停在包预检层，不能据此判断其实际激活或控件能力。

先从托盘正常退出当前网易云实例；预检发现已有实例会拒绝启动，避免单实例重定向。只接受显式路径、有效签名和匹配产品名。没有设置路径时，原控制台、Fake 与合成夹具入口仍可运行。模板见 `netease.env.example`，不自动加载。

```powershell
# 自行填写实际安装路径；不在仓库中保存机器路径
npm run demo:local-workspace:netease -- --netease-path '<已安装的 cloudmusic.exe 绝对路径>'
# 单独执行真实应用自动子集，包含接管、合成编辑、退格和恢复
npm run test:local-workspace:netease:windows -- --path '<已安装的 cloudmusic.exe 绝对路径>'
```

也可显式配置会话环境变量 `NETEASE_APP_PATH` 后启动 Viewer。默认歌曲和歌手为本次授权值；不同曲目需通过 `--song` / `--artist` 显式指定，不代表其他歌曲已验证。安装过程不下载或复制网易云、CEF、SDK、音乐或图片。

Viewer 选择网易云 → Run → 等待完整画面和固定脚本按钮可用 → 运行固定脚本。脚本输入检索词、打开单曲页，精确选择带原唱标记和匹配歌手的结果。不会点击“播放全部”、收藏、下载、会员或其他歌曲。匹配含糊、登录/付费障碍、非空搜索框、画面或控件失效时停止。脚本有限执行一次，不接模型、不改 Provider，也不采用系统输入回退。

输入分类为 `TARGETED_WINDOW_INPUT`（本次 Job 内唯一 CEF 渲染 HWND 的 WM_CHAR / 鼠标消息）和 `SEMANTIC_INPUT`（接管搜索框的 UIA ValuePattern）。UIA 读取与操作前校验进程属于本次 Job、Session 和原生 HWND 的 Desktop，拒绝密码控件。应用用 accessibility 启动参数暴露控件；ctypes COM ABI 来自 Windows SDK，未增加 comtypes/pywinauto 依赖。Invoke/Legacy 的有限客户端接口保留，但当前脚本和人类点击使用已验证的目标消息；不声称通用 UIA 输入已通过。

当前应用在启动稳定后使用线程 DPI 感知、仅针对归属窗口的非激活尺寸设置（1600×1000）及 PrintWindow(flags=2) 取得完整画面；初始化黑帧不能算成功。最大捕获尺寸仍为 2048，未增加预算或启用 WGC。Host 检查所有 Job PID 在 Default 上的窗口，采集与输入均在隐藏 Worker 内完成。

接管允许搜索框中的合成 ASCII 编辑/退格，以及底部播放/暂停按钮。恢复保留编辑与脚本进度；不重新输入检索词。实际检索词若被人工改成别的内容，脚本仍只允许最初授权歌曲，可能停止。接管时已发操作的效果无法确认则 fail closed，不能为了 ACK 继续未知动作。正常切换只在已确认效果的步骤间进行；这是有限接管能力，不是任意实时应用控制。

自动播放判断要求本轮选择精确搜索结果、匹配歌曲/歌手标题且当前底部按钮语义为 pause。静态 AutomationId 在 play/pause 时都不变，不能单独判定播放。该结果证明应用播放状态；可听声音、试听长度、设备音量与人工并行体验必须由参与者另行确认。每次仍限 60 秒、租约 3 秒、输入队列 16、有效期 2 秒、人类事件 256，不支持 IME/粘贴/快捷键/滚轮/拖拽。

`.artifacts/d0c-netease*/` 保存真实应用帧、UIA 名称、安装路径、临时 IPC 及详细运行记录，全部私有忽略。公共验证仅保留版本、布尔结果、计数及原因，详见 [D0-C 记录](validation-d0c.md)。完整 D0 仍 OPEN；不进入 D1。来源补充：[UIA ElementFromHandle](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation-elementfromhandle)、[ValuePattern](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-implementingvalue)、[SetThreadDpiAwarenessContext](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setthreaddpiawarenesscontext)、[SetWindowPos](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos)。
