# 第一批包边界与显式装配

本批从已提交的 `84ec942` 建立独立工作分支。原工作区未提交的原生修复、实验脚本和
主工程修改留在原处，不作为本 PR 的隐含依赖，也不夹带提交。

## 当前布局

```text
hidden_desktop_lab/
  contracts/
    experiment.py      # 原配置校验器，保持目录约束和 schema
    matching.py        # 原 validate_match，纯规则
    uia.py             # 原角色表及 UiaError，无 COM 初始化
  tasks/service.py     # 原 TaskRuntime，执行/核验/去重语义保持
  transports/http.py   # 原 Handler，通过所属 server 获取 application
  bootstrap.py         # BenchApplication / create_application
  paths.py             # LabPaths，资源仍定位到 lab 根目录
server.py              # 兼容启动入口
agent_runtime.py       # 兼容导入
experiment_config.py   # 兼容导入
```

依赖方向：HTTP 适配 → 显式 application → 原能力与回放组件。
任务服务仍由调用方注入 backend。纯契约不依赖执行器、传输层或原生客户端；
UIA 客户端及身份读取不再反向导入回放层。

原生控制、COM 实现和大型回放执行器仍在原文件。后续拆分不属于本批。
不新增框架、安装要求、依赖或第二套执行循环。

## 资源生命周期

- 包和入口导入只定义符号，不加载实验配置、学习记录、历史报告或创建执行器。
- `create_application()` 显式读取配置、创建基础运行时及各流程的原 `LearnedReplay`。
  原 300 秒默认租约、256 次动作上限及其他组件边界保持。
- `create_server(application, port)` 附加该实例。锁、日志、绑定、预览和流程注册表不再
  是模块共享状态。同一 application 内各流程继续共用原运行时和执行锁。
- 只读预览保持独立路径，不等待执行锁。流程切换、基础动作导致的失效规则保持。
- 退出在各 replay 的所属线程释放引用，再清理自有桌面；原清理未确认信息继续报告。
  配置装配或 HTTP 绑定失败时也释放已经创建的组件。关闭成功后重复 close 不重复释放。
- 原 CLI 参数、HTTP 路由、`/manual-flow` 别名、X-Lab/Host 检查、请求上限及响应结构保持。
  原入口模块中的运行时全局变量不再创建；嵌入使用应显式持有 application。

资源路径集中到 `LabPaths`，仍指向现有 lab 根目录。`experiment.json` 的目录限制、
JSON 源定义、revision/hash 引用和 MCP profile 参数均未修改。

## 检查分类

根目录 `check`、`test:offline`、`test:python` 仍不覆盖 lab，本批不改变它们的发现范围。

| 命令 | 范围 |
| --- | --- |
| `npm run test:labs:python` | 清单内的 Python 合成单元与集成测试 |
| `npm run test:labs:js` | 原预览和回放客户端逻辑测试 |
| `npm run test:labs:browser` | JEV Fake 服务和全新浏览器上下文，仅访问本地服务 |
| `npm run test:labs` | 顺序执行上述三组，任一组失败即失败 |

清单维护于 `tests/offline-suites.json`。名称含 `real_backend` 的 Python 测试使用
FakeRuntime、FakeTree、临时 JSON 和原生调用拒绝守卫，不运行真实 backend。
`verify_*.py`、UIA 实机实验及真实桌面 smoke 不在清单中；不得通过扩展通配符将其纳入默认检查。
执行器清理与参数契约仍由原测试覆盖，新增检查针对本次导入、装配与所有权边界。

基线 `84ec942` 的 lab Python 测试共 306 项。能力声明、错误目录及四种 MCP schema
的摘要直接从该提交的干净源码捕获，存为合约回归 fixture；不读取本机学习记录。
README 中历史实测结论不作为本批验收。Windows 实验暂停、P3 NO-GO、A5 safety FAIL
和整体未完成状态保持，本批不运行真实模型、第三方站点、VM 或实机输入。

本批 lab 检查：318 项 Python、10 项 JS 和 1 项合成浏览器测试通过。
另在临时源码副本叠加原工作区待提交的 lab Python 内容，347 项合成测试通过；
只复制源码，不复制本机学习记录、报告或私有配置。原工作区记录的 29 个待提交源码
哈希全部保持。叠加检查是兼容性补充，不将这些待提交文件收入本 PR。
