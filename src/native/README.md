# Python Native 基础层

`agent_desktop_native.windows.win32` 是从 D0 原实现移动来的唯一 Win32 `Api`
及 ctypes 声明；`windows.policy` 只含共用的 `Blocked`、目标归属检查和 PNG 编码。
模块导入不加载 WinDLL，真实初始化仍只在显式 `Api()` 时发生。没有新增原生操作。

正式运行期 import 图：

```text
src/desktop-provider/workbench_app_worker.py
  -> guest/app_launch.py -> guest/app_discovery.py
  -> src/native/agent_desktop_native/windows/win32.py
       -> .policy (Blocked, validate_target, png_rgb)
  -> src/native/agent_desktop_native/windows/policy.py (同一个 Blocked)
```

部署时保持上述相对目录，携带 Worker、两个 guest 模块及正式 Native 包的四个
Python 文件（两个 `__init__.py`、`win32.py`、`policy.py`）。无需 `spikes/`。
真实 Windows 执行沿用 guest 的既有 pywin32/运行环境要求；本单元不修改安装或发布流程。
Worker 从自身文件定位导入目录，正式包缺文件时报告
`workbench-native-package-unavailable`，不从实验目录或同名全局模块回退。
Worker 及其预览目录的 ROOT 定义保持原样。

D0 实验由 `spikes/local-workspace/_native_path.py` 做仓库路径装配后直接引用正式包。
原 `policy.py` 仅 re-export 三个共用原语，其 D0 输入/epoch/lease 规则留在实验层。
没有旧 Win32 入口 shim；Mock 应指向 `agent_desktop_native.windows.win32`。

无 spikes 的复制部署、异名工作目录、缺失/损坏正式包及 Fake UTF-8 stdio smoke
由 `python tests/workbench_app_worker_test.py -v` 覆盖，不执行真实 APP/窗口/输入。
Fake PASS 不代表 Win32/GDI/PrintWindow 实机验收；A5 safety FAIL、Windows PAUSED、
overall INCOMPLETE 保持。
