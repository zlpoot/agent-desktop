# Labs runtime + MCP + thin skill

默认入口只运行合成数据；独立、显式启用的真实 profile 仅支持网易云搜索框填写与回读。
两种模式复用 `CapabilityRuntime` 的基础能力调度、`SkillLibrary` 的 JSON
引用及哈希校验、`LearnedReplay` 的专用线程/绑定/输入/独立回读执行器。
`synthetic_runtime.py` 注入 FakeRuntime / FakeTree；不会实例化原生桌面 API，不启动应用、
访问模型、第三方站点或读取本机 `learned/`、`reports/`、私有配置。
不 import 主工程，不改变 Host/Guest 协议或主工程 Workflow schema，不添加依赖。

调用关系：agent → STDIO MCP → `TaskRuntime` → 现有 JSON 执行器 → 合成桌面/UIA。
配方来自 `synthetic/form.template.json`；启动时仅在独立临时目录生成合成学习数据和
组合 JSON，退出清理。其合成指纹不代表真实软件学习或验证。

## 启动与接入

从仓库根目录运行（Python 3.10+，仅标准库）：

```powershell
python labs/hidden-desktop/mcp_stdio.py --fake
```

该进程等待 MCP 输入，没有网页。stdout 仅输出 UTF-8 JSON-RPC；不应在终端中等待
启动横幅。默认也是 synthetic；真实执行必须同时指定 `--real --profile cloudmusic-fill-search`。
不支持 `--live`、外部配方或任意路径参数。

快速安装项目级 MCP 和 skill（安装及真实 Codex 验证脚本需要 Python 3.11+）：

```powershell
python labs/hidden-desktop/install_codex.py
codex mcp get agent_desktop_lab --json
```

脚本将当前 Python、脚本绝对路径及 `--fake` 注册到仓库 `.codex/config.toml`，复制
薄 skill 到 `.agents/skills/lab-tasks/SKILL.md`。保留其他设置；遇到同名但不同配置时停止。
可重复运行以同步 skill；这些本机配置/副本不提交，源文件仍维护在 labs。
重启相关 MCP 或 Codex 后使用 `$lab-tasks`。其他 STDIO MCP 客户端可使用相同启动命令。

权限只简化这一台合成服务器：项目配置设置其 `default_tools_approval_mode=approve`，
不逐项确认纯合成调用。不引入 OAuth、账号、令牌或权限管理平台，不改变全局沙箱或其他
MCP 策略。该入口没有真实 backend，不能通过参数启用实机、联网业务动作或任意代码。

## 工具和调用链

| 工具 | 输入 | 结果 |
| --- | --- | --- |
| `capabilities_list` | `{}` | 合成任务及按当前前提计算的可用性 |
| `capability_describe` | `{capabilityId}` | 参数 schema、前提、副作用、定义哈希、验收与证据范围 |
| `session_open` | `{}` | 显式开启会话并起算租约；重复调用不续租 |
| `task_start` | `{capabilityId, inputs, requestId}` | 接收回执 `jobId`，不是完成证明 |
| `task_status` | `{jobId}` | 当前调用、子步骤、执行、核验、效果及错误 |
| `observation_get` | `{}` | 空闲时当前合成字段/提交值/动作计数；没有真实截图 |
| `session_close` | `{}` | 释放自有绑定、合成环境及临时目录，明确清理结果 |

完整例子：发现 → 描述 `synthetic.form.submit` → `session_open` → 提交
`{"capabilityId":"synthetic.form.submit","inputs":{"query":"合成 example"},"requestId":"example-1"}`
→ 保存 jobId 并间隔查询 → 读取当前合成状态 → 关闭会话。
用户的下一项独立任务可显式 `session_open` 再次运行；不需要重启 MCP。
完整流程按哈希引用 `synthetic.bind`、`synthetic.fill`、`synthetic.submit`，也可按前提逐项调用。
填写会独立回读当前值；提交前再次核对同一值。没有应用名分支或生成的程序脚本。

`executionStatus=done` 与 `verification.status=manual-required` 可以同时成立；提交动作
保留原 JSON 的人工验收要求。单独填写的 `passed` 只证明合成值回读，不代表真实软件或
业务验收。`effectStatus=unknown` 或核验失败时停止，不自动重发输入、重新学习、放宽
定位、延长租约或换用其他执行路径。失败后该会话封锁后续新任务，仍可查询和清理。

## 生命周期与限制

- 一个 STDIO 连接同时持有一个活动会话，sessionId 由服务生成；客户端不能申报所有权。
  不同进程的任务、状态、requestId 和绑定不共享，也不连接原页面服务。
- MCP 启动、工具发现和空闲等待不开始租约；首次 `session_open` 才开始 300 秒租约。
  再次 open 返回同一会话、不延长租约。关闭后可显式开启新会话，旧任务和去重键仍保留。
  清理未确认时不能重新打开；失败/效果未知不允许自动换会话重放。
- 一次只执行一个任务；执行期间仍可查询进度，新的任务、观察和显式关闭均拒绝排队。
- 同一连接内相同 requestId 和相同规范化输入返回原 jobId，包括运行中及失败任务。
  同 ID 不同输入拒绝。保留最多 32 个任务和去重键，满后拒绝，不淘汰旧键后重放。
- 去重和任务历史仅在进程内有效。进程重启不恢复绑定或重发动作；跨进程断线后的旧效果
  不能推断为未发生。不要用新 requestId 或新会话掩盖未知结果。
- 保留 300 秒有界租约、256 次动作上限及既有 JSON/目标契约；失败的动作尝试也计数。
  所有参数在适配层严格验证，执行器再次检查依赖；没有任意代码、程序路径或预算开关。
- 显式 close 遇到运行中任务只返回 busy，不表示取消。EOF 等待当前有界合成任务结束，
  再在原线程释放绑定并清理；不承诺硬杀进程后的清理或原生 UIA 取消能力。
- 实现工具型 MCP STDIO 子集：协议版本 2025-06-18 / 2025-11-25，initialize、initialized、
  ping、tools/list、tools/call。异步 job 是本应用契约，未声明 MCP Tasks 扩展。
  不支持 HTTP、远程多租户、sampling、resources 或取消。消息上限 64 KiB，超限关闭连接。

Windows 实验暂停、P3 NO-GO、A5 safety FAIL 及主工程整体未完成的状态不因本合成链路改变。
合成入口不会切换真实 backend；真实 profile 的启用与验证须明确授权。

## 网易云最小真实 profile

```powershell
python labs/hidden-desktop/install_codex.py --real
codex mcp get agent_desktop_lab_real --json
# 在 Codex 设置的 MCP servers 中 Restart，或重启 Codex，加载新增的原生工具。
python labs/hidden-desktop/verify_cloudmusic_mcp.py --real --query "接入测试"
```

安装器新增项目级 `agent_desktop_lab_real`，保留 `agent_desktop_lab` 合成入口。
真实入口设置 `default_tools_approval_mode=prompt`，沿用常规审批，不改变全局权限。
启动参数固定为 `mcp_stdio.py --real --profile cloudmusic-fill-search`；MCP 请求不能选择
程序路径、学习文件、任意操作、预算或模式。发现目录不会打开桌面；`session_open` 才创建
自有隐藏桌面并起算 300 秒租约。

`real_backend.py` 组合现有原生能力、JSON 执行器和已学局部定位。新流程
`recipes/workflows/cloudmusic.fill-search.json` 按原 revision/哈希引用现有四个子能力：
`cloudmusic.launch` → `cloudmusic.prepareSearch` → `cloudmusic.locateSearch` → `cloudmusic.fillSearch`。
同样暴露这四个子能力以便分段观察。参数只有 `query`（1..200 字符）。显示搜索入口时，
既有 prepareSearch 可按已声明谓词收起详情页；不提交搜索、不打开歌曲或控制播放。

应用路径/启动参数必须与既有模板相同；读取本机 `learned/capabilities/` 的指定记录，
检查定义哈希、应用文件指纹及局部布局契约，不自动生成/更新学习数据。记录缺失或变化即
拒绝。应用已在用户桌面运行时继续按既有规则拒绝，不接管或关闭用户实例。
应用可能使用自身已有设置及联网行为；隐藏桌面不是数据或网络隔离环境。

真实 `observation_get` 在原 UIA 线程重读当前绑定搜索框，同时检查实例、目标身份和租约，
返回 `scope=real-owned-window-input-readback`、实际 `value` 及自有窗口截图证据路径。
截图只保存在忽略提交的 `reports/mcp-real/<id>/observation.png`，重复观察仅覆盖本会话
这一张，不建立帧队列；观察不修改已完成 job 的调用历史。
`verification.status=passed` 只证明本条输入/回读检查；`realWorldValidated=false` 保留，
不代表搜索结果、播放或整体安全验收。关闭先在所属线程释放 UIA，再通过原生清理检查
关闭自有进程及隐藏桌面，将 `cleaned` 转换为 `cleanup.closed`；任一清理失败阻止重新开启。

验证脚本通过已注册项目 STDIO MCP 执行完整协议链，独立核对四步完成、一次输入、当前值
和清理，保存 `.artifacts/lab-tasks-real/*.json`，不调用模型。它证明真实 backend 的 MCP
链路；桌面端原生工具是否加载须在 Restart 后单独确认，不以脚本代调冒充。
离线测试 `test_real_backend.py` 仅使用生成 JSON、FakeRuntime/假原生边界，不导入真实学习记录。

## 合成验证

```powershell
python -m unittest discover -s labs/hidden-desktop/tests -p test_agent_mcp.py -v
```

真实 Codex 接入验证必须显式运行：

```powershell
python labs/hidden-desktop/verify_codex.py --real
```

该命令使用现有 Codex 登录和所选模型，一次真实 Codex 运行中连续完成两个合成会话。
子进程 shell 为只读且不使用；验证脚本把已安装 skill 内容及同一项项目 MCP 配置传入隔离
CLI，避免依赖全局信任设置或加载用户级其他 MCP。验证脚本不读取凭据文件，Codex 自身
使用既有登录。
最长 240 秒，要求不超过 30 次 MCP 工具调用；从实际 JSONL 事件独立核对两个 job、不同
session、当前合成提交值、人工验收状态和清理，而不依赖模型自述。事件、回答和汇总保存在
忽略提交的 `.artifacts/labs-mcp-codex/`，不会启用真实应用。模型费用未单独测量时不宣称为零。

含独立子进程 STDIO 客户端的完整调用、中文参数、去重、当前进度、人工验收保留、
错误回读停止、未知效果、配方篡改、预算/租约、任务隔离、历史上限、关闭及协议错误。
单元检查对原生桌面、真实 UIA 和 socket 设置拒绝替身；不使用真实学习数据或模型。

协议与工具设计依据：
[MCP STDIO](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、
[MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)、
[MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)、
[OpenAI MCP server](https://developers.openai.com/plugins/build/mcp-server)。
