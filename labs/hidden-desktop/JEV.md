# JEV 独立测试页面

在仓库根目录启动：

```powershell
python labs/hidden-desktop/jev_server.py
```

打开 <http://127.0.0.1:8791/jev>。端口占用时可指定 `--port 8792`。
服务与原基础能力测试台独立，不导入桌面模块，不创建窗口或执行模型选出的动作。
页面包含模型列表检查、候选动作选择，以及完成、处理中、失败、缺失证据四类语义核验。
请求预览、模型选择、置信度、独立预期比较、token 用量及耗时均可查看。

默认 Fake 模式完全使用内置合成数据，不读取任何私有配置、不访问模型。
可注入低置信度、候选越界、无效置信度、类型错误、缺失答案、超时及 HTTP 错误。
Fake 成功只说明测试台的合成链路通过，不代表真实模型、Windows 能力或应用验收通过。

先填写仓库根目录 `.env` 中的两个字段（该文件已被 Git 忽略，不提交）：

```dotenv
JEV_BASE_URL=https://jev.example.invalid/v1
COMPUTER_USE_API_KEY=YOUR_API_KEY
```

上面均为 demo 占位值，必须替换为真实配置。真实请求仅在操作者显式启用后可用：

```powershell
python labs/hidden-desktop/jev_server.py --live
```

配置规则参考 `src/agent/local-config.ts` 的 `configuredJev`：
沿用 `JEV_BASE_URL`、`COMPUTER_USE_API_KEY` 名称，模型名固定为 `jev`。
本独立测试台另外支持用户要求的根目录 `.env`：环境变量逐字段优先于 `.env`；
API Key 还可回退根目录 `.env.local` 中的同名字段。不读取普通模型的 `config/model.local.json`，
不修改进程环境，不导入其他字段。Fake 启动不会读取这些文件；改配置后重启 `--live` 服务生效。
密钥不返回页面或写入测试记录。`--live` 启动不自动发请求，须在页面逐次点击。
GET `/v1/models` 检查模型，POST `/v1/systemone` 发送 `model/state/questions`。

每次点击最多一次请求，不重试、不跟随重定向。每个服务进程最多 20 次尝试，失败也计数；
网络等待超时 5 秒，响应体上限 64 KiB，同时只允许一个请求。重新开始须显式重启服务。
本地置信度阈值为 0.8；不合法、越界和低置信度答案均拒绝。
阈值是本测试台的准入设置，不改变主工程的风险门或辅助模型开关。
接受合法答案后，仍与合成用例的固定预期独立比较，错误结论显示“不符合预期”。
页面记录仅在当前页保留，刷新即清空。

合成验证（无模型、无桌面输入，HTTP 仅回环本地测试服务）：

```powershell
python -m unittest discover -s labs/hidden-desktop/tests -p test_jev.py -v
node --test labs/hidden-desktop/tests/jev-page.test.mjs
```

这些 lab 测试需单独运行，根目录测试脚本不会自动发现此目录。
