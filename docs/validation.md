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
| 规则测量 benchmark | 38 个合成用例 × 20 次，共 760 标签匹配 / 0 false pass / 0 false fail / 0 modelCalls；不是独立新增的 760 项回归 |
| 提交前内容/来源审查 | 2 张合成 PNG 已按实际像素与 CRC 审核；118 项依赖锁条目未改，624 个原跟踪文件内容指纹未改；无旧源码绝对路径、内网默认地址、原密钥值或未经审核二进制 |

TypeScript 文件工具测试在当前权限下不能创建符号链接，**链接分支跳过**（diagnostic）；测试整体仍通过。它不等于验证了 Windows 链接分支。

初轮失败保留记录：两个路由测试被过早的应用路径校验阻止（校验移动到实际执行前，接口路由不变）；测量 readiness 遗漏 fileHash 引用（恢复本地只读哈希）；Python startup 测试漏 controlEpoch 导致 400 而不是预期 422（测试补当前 epoch，Worker 协议不改）；本地表单示例未按 pathname 处理查询参数（修正后 done）。未通过的初轮结果不计入上述最终通过数。

规则评测差异为 `challenge/contract-omits-path`：纯字段规则 pass，但原始任务路径没有覆盖，任务级独立 gate 回归验证会阻止。raw 差异为 `uia-duplicate-label` → `target_uniqueness_unconfirmed` 和 `desktop-context-frame` → `missing_capture_geometry`。预期标签未为绿灯而更改。

真实模型、第三方站点、VM 和真实桌面输入均 **NOT RUN**：未显式授权现场执行，Windows/A5 现场暂停，且不计入离线结果。历史 A5 safety FAIL 和整体未完成保持原结论。

## 全新检出复验

首次本地提交 `131dafc` 建立了独立根历史。从它以 `git clone --no-local` 检出到独立空目录，按 README 重新建立 venv（`include-system-site-packages=false`）、安装 psutil 5.9.0、运行 npm ci 并重新下载 Chromium。没有复用原目录或候选工作树的 node_modules、配置、数据库、npm/浏览器缓存。

首个干净 venv 的 Python 回归失败：D1 Worker 传输测试隐含 `PIL` 导入，本机已有 Pillow 掩盖了依赖。已用标准库生成同尺寸 PNG，未安装 Pillow 或新增依赖，保留原契约断言。修复提交 `ff2b9b6` 已在独立检出目录快进；依赖锁未改，继续使用该检出自行下载安装的依赖。

| 独立检出检查 | 最终实际结果 |
|---|---|
| 新 npm 安装 / Chromium 下载 / Python venv 安装 | 全部退出 0，Node 24.21.0、Python 3.11.5、psutil 5.9.0 |
| noEmit 类型校验 | PASS，退出 0 |
| TypeScript 离线 | 422 PASS / 0 FAIL / 0 skipped，236.263 秒 |
| 本地浏览器 | 50 PASS / 0 FAIL / 0 skipped，121.066 秒 |
| Python Worker 契约（修复后） | 30 PASS / 0 FAIL，10 文件，退出 0 |
| FakeModel/FakeRuntime 示例 | PASS，status=done，退出 0 |
| localhost 浏览器示例 | PASS，status=done，退出 0 |
| 无模型/Guest 配置控制台 | PASS，四个本地只读路由可用，退出 0 |

符号链接分支在独立检出中仍因 Windows 权限跳过。现场实验仍全部 NOT RUN。原目录的两份已改配置、三份未跟踪日志及既有私有现场保持原样；未删除、封存或推送，未修改可见性，未添加项目许可证。

机器可读结果在 `validation-results.json`，含各组数量和私有运行日志指纹。日志、下载缓存、生成数据库与独立检出目录留在本机，不作为公开候选内容提交。最终文档提交仅记录复验与来源审查，不改变已测试代码。
