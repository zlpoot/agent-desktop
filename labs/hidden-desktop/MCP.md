# Labs runtime + MCP + thin skill, v1

此入口只运行合成数据。复用 `CapabilityRuntime` 的基础能力调度、`SkillLibrary` 的 JSON
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
启动横幅。默认也是 synthetic，`--real`、`--live`、外部配方和任意路径参数均不支持。

需要在 Codex 中试用时，可由使用者注册本地 MCP（本次实现不修改个人配置）：

```powershell
codex mcp add agent-desktop-lab -- python E:\projects\agent-desktop\labs\hidden-desktop\mcp_stdio.py --fake
```

其他支持 STDIO MCP 的 agent 使用相同 command/args；替换为当前机器的 Python 和
仓库绝对路径。`skills/lab-tasks/SKILL.md` 是配套薄 skill，随代码交付、未自动安装。
客户端可按自己的 skill 发现机制加载它；不支持 skill 的客户端也能直接调用工具。
安装 skill 或接入 MCP 不授予真实模型、实机输入或联网业务执行权限。

## 工具和调用链

| 工具 | 输入 | 结果 |
| --- | --- | --- |
| `capabilities_list` | `{}` | 合成任务及按当前前提计算的可用性 |
| `capability_describe` | `{capabilityId}` | 参数 schema、前提、副作用、定义哈希、验收与证据范围 |
| `task_start` | `{capabilityId, inputs, requestId}` | 接收回执 `jobId`，不是完成证明 |
| `task_status` | `{jobId}` | 当前调用、子步骤、执行、核验、效果及错误 |
| `observation_get` | `{}` | 空闲时当前合成字段/提交值/动作计数；没有真实截图 |
| `session_close` | `{}` | 释放自有绑定、合成环境及临时目录，明确清理结果 |

完整例子：发现 → 描述 `synthetic.form.submit` → 提交
`{"capabilityId":"synthetic.form.submit","inputs":{"query":"合成 example"},"requestId":"example-1"}`
→ 保存 jobId 并间隔查询 → 读取当前合成状态 → 关闭会话。
完整流程按哈希引用 `synthetic.bind`、`synthetic.fill`、`synthetic.submit`，也可按前提逐项调用。
填写会独立回读当前值；提交前再次核对同一值。没有应用名分支或生成的程序脚本。

`executionStatus=done` 与 `verification.status=manual-required` 可以同时成立；提交动作
保留原 JSON 的人工验收要求。单独填写的 `passed` 只证明合成值回读，不代表真实软件或
业务验收。`effectStatus=unknown` 或核验失败时停止，不自动重发输入、重新学习、放宽
定位、延长租约或换用其他执行路径。失败后该会话封锁后续新任务，仍可查询和清理。

## 生命周期与限制

- 一个 STDIO 连接拥有一个运行时，sessionId 由服务生成；客户端不能申报所有权。
  不同进程的任务、状态、requestId 和绑定不共享，也不连接原页面服务。
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
此版本不暴露真实 backend；后续实机集成须另行授权、配置与验证。

## 合成验证

```powershell
python -m unittest discover -s labs/hidden-desktop/tests -p test_agent_mcp.py -v
```

含独立子进程 STDIO 客户端的完整调用、中文参数、去重、当前进度、人工验收保留、
错误回读停止、未知效果、配方篡改、预算/租约、任务隔离、历史上限、关闭及协议错误。
单元检查对原生桌面、真实 UIA 和 socket 设置拒绝替身；不使用真实学习数据或模型。

协议与工具设计依据：
[MCP STDIO](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、
[MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)、
[MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)、
[OpenAI MCP server](https://developers.openai.com/plugins/build/mcp-server)。
