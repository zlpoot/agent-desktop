# D2 Local Workspace 启动上下文（#66）

基线 main@a1aba8318fcbaf217d253362b6ecd0122d848774。D2 第一次 Task 在应用启动前阻断，不能记为播放或 UAT PASS。此次修复只处理本地启动上下文和监测诊断，不改变 Provider、Host/Guest 协议、Workflow、权限或预算。

## 根因与只读对照

使用本机私有诊断脚本，在主线程与 Monitor 的后台线程分别查询自身 token、Windows 会话、窗口站、线程桌面、输入桌面及 GetCursorPos 成败；不保存光标坐标、窗口标题、账号、SID 或凭证。Dashboard 对照使用普通 `npm run dashboard`，本机私有 preload 在 server listening 后，以 D0 的 `spawn('python', …)` 选项（cwd、stdio pipes、windowsHide=true、UTF-8）派生只读监测脚本，随后关闭临时 4175 服务。没有新建 Task、启动原生应用或发送输入。

| 执行上下文 | token / 提升 / 完整性 | 会话 / 窗口站 | 主线程和监测线程桌面 | 输入桌面 | GetCursorPos / Monitor |
| --- | --- | --- | --- | --- | --- |
| 受限终端 | restricted / 未提升 / Medium | 相同交互会话 / WinSta0 | 启动器隔离桌面 | Default | error 5 / 失败 |
| 受限终端启动的 Dashboard 子进程 | restricted / 未提升 / Medium | 同上 | 同上 | Default | error 5 / 失败 |
| 普通交互终端 | unrestricted / 未提升 / Medium | 同上 | Default | Default | 成功 / 采样通过 |
| 普通终端启动的 Dashboard 子进程 | unrestricted / 未提升 / Medium | 同上 | Default | Default | 成功 / 采样通过 |

四组均无线程 impersonation token。相同 spawn 选项在普通上下文通过，说明 `windowsHide`、stdio 管道、Python 后台线程与会话编号并非本次差异来源。受限父进程的 token/桌面继承才是此次阻断上下文；没有通过修改 ACL 或切换线程桌面单独区分其中每项的因果贡献。

[Microsoft GetCursorPos 文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getcursorpos) 要求窗口站读取属性权限，并要求当前线程桌面为输入桌面。原 `assert_default()` 仅确认会话活跃及 OpenInputDesktop 名为 Default；这不证明监测线程自身位于 Default。Monitor 现在在安装 hook、读取光标前检查自身线程桌面，非 Default 时保留 `default_monitor_unavailable` 外层错误，内部原因明确为 `monitor_thread_not_default`。不执行 SetThreadDesktop，不绕过原光标、会话、输入桌面检查；无法监测仍阻断启动。

## 本机启动修正

在用户当前交互会话的普通、未提升 Windows 终端启动已有普通 Dashboard；不要从隔离/受限桌面终端启动后假定继承的子进程能监测 Default。不使用管理员权限、修改桌面 ACL 或关闭监测来修正。先停止自己创建的同端口 D2 服务，确认端口空闲；保留 D1 4173/4180 与其它服务。

```powershell
# 只在已授权的普通交互终端执行；目录、端口、私有配置由本机操作者指定。
Set-Location '<独立 D2 工作区>'
$env:DASHBOARD_PORT = '4174'
$env:AGENT_DESKTOP_ENVIRONMENT_CONFIG = '<本机私有环境配置的绝对路径>'
npm run dashboard
```

配置沿用 `desktop-environment-config.ts` 的 `localWorkspace` schema：netease、明确的本机 cloudmusic.exe 路径、我怀念的 / 孙燕姿。私有配置置于 ignored 目录，不上传路径或安装清单。辅助验证器保持 off，诊断服务不携带模型凭证。配置/目录 supported 不代表原生 Session 或播放 ready；原生动作仍需已有固定场景的新一次明确授权。

在同一终端可先运行以下只读 Monitor 探测；仅安装/回收观察 hook 和读取采样，不启动应用或发送输入，输出不含光标坐标。若失败，保留具体 error 并停止原生任务准备。

```powershell
@'
import sys
sys.path.insert(0, 'spikes/local-workspace')
from monitor import Monitor
observer = Monitor()
try:
    observer.start()
finally:
    print(observer.close())
'@ | python -
```

4174 服务在普通上下文重新启动后只读回读原失败 Task，保持 Task ID、错误、五条事件、执行/验证 NOTRUN、产品清理 UNKNOWN 和零模型调用。D0 原生 cleanup PASS 与产品 UNKNOWN 分别保留；不改历史证据、不重新提交或 Resume。后续 LIVE 授权另行取得。

## 验证与停点

按 #66 本轮要求只运行类型检查、D0 合成安全回归、相关 Provider/场景任务测试及只读上下文对照，不重复全量 CI 或 D1。测试与当前诊断的实际结果同步到 Draft PR / Issue。私有诊断脚本、原始进程信息与生成记录不提交。

Draft PR 等待独立 Review，未经授权不合并、不关闭 #66。A5 safety FAIL / Windows PAUSED / overall INCOMPLETE 保持；监测通过不等于网易云播放或 Owner UAT 通过。
