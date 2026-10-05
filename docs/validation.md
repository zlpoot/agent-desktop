# 验证记录（2026-10-05，Asia/Shanghai）

环境：Windows 10.0.26200 x64；Node 24.21.0，npm 11.19.0；Python 3.11.5；psutil 5.9.0；Git 2.43.0.windows.1。Playwright 使用原锁版本及 chromium build 1243（Chrome for Testing 153.0.8010.12）。其他 Node/Python 版本未验证。

## 候选工作树

| 检查 | 实际结果 |
|---|---|
| 原锁 npm ci | PASS，独立下载安装，无原 node_modules |
| 新 Python venv / psutil 5.9.0 | PASS，no-cache-dir 安装；本机有编译工具，psutil 从源码构建 |
| tsc --noEmit | PASS，包含核心、测试、可复用 measurement 和迁移入口 |
| TypeScript 离线回归 | 421 PASS / 0 FAIL / 0 skipped；后加公共配置测试另行 1 PASS，总覆盖 422 项 |
| 本地浏览器组 | 50 PASS / 0 FAIL / 0 skipped；VM 路由合成 ID/地址替换后单独 1 PASS（不重复计数） |
| Python Worker 契约 | 30 PASS / 0 FAIL，10 文件独立运行 |
| FakeModel/FakeRuntime 示例 | PASS，status=done，无真实输入或联网模型 |
| localhost 浏览器示例 | PASS，status=done |
| 控制台无模型/Guest 配置启动 | PASS，本地只读首页、runtime、prompts、workflows 路由 |
| 本地批准恢复示例 | PASS，start=waiting_user，显式 approve 后 resume=done |
| 规则数据集评测 | 104 evaluated，103 标签匹配，1 false pass，18 not_run，modelCalls=0；脚本退出 0，不宣称标签全部通过 |
| 原始证据评测 | 10 evaluated，8 标签匹配，2 unknown 与标签不一致，0 false pass，modelCalls=0；脚本退出 0 |
| 提交前内容/来源审查 | 2 张合成 PNG 已按实际像素与 CRC 审核；118 项依赖锁条目未改，624 个原跟踪文件内容指纹未改；无旧源码绝对路径、内网默认地址、原密钥值或未经审核二进制 |

TypeScript 文件工具测试在当前权限下不能创建符号链接，**链接分支跳过**（diagnostic）；测试整体仍通过。它不等于验证了 Windows 链接分支。

初轮失败保留记录：两个路由测试被过早的应用路径校验阻止（校验移动到实际执行前，接口路由不变）；测量 readiness 遗漏 fileHash 引用（恢复本地只读哈希）；Python startup 测试漏 controlEpoch 导致 400 而不是预期 422（测试补当前 epoch，Worker 协议不改）；本地表单示例未按 pathname 处理查询参数（修正后 done）。未通过的初轮结果不计入上述最终通过数。

规则评测差异为 `challenge/contract-omits-path`：纯字段规则 pass，但原始任务路径没有覆盖，任务级独立 gate 回归验证会阻止。raw 差异为 `uia-duplicate-label` → `target_uniqueness_unconfirmed` 和 `desktop-context-frame` → `missing_capture_geometry`。预期标签未为绿灯而更改。

真实模型、第三方站点、VM 和真实桌面输入均 **NOT RUN**：未显式授权现场执行，Windows/A5 现场暂停，且不计入离线结果。历史 A5 safety FAIL 和整体未完成保持原结论。

## 全新检出复验

首次本地提交完成后，从该新仓库检出到独立空目录，重新建立 venv、下载 Node 依赖及匹配 Chromium，然后按 README 校验类型、两组 TypeScript、Python、示例及控制台。此节将在实际复验后补充结果；不会使用原数据库、配置或缓存。
