# Hidden Desktop 基础能力测试台

## 共用代码与实验数据

- `replay_contract.py`：JSON 契约、错误类型、文件读取和安全上限；不包含应用名或任务参数。
- `learned_replay.py`：共用解释执行器、线程归属、输入预算与核验；既有导入接口保留。
- `local_replay.py`、`learned_paths.py`、`replay_observation.py`、`uia_client.py`：局部查询、学习路径、身份与结果核验。
- `experiment.json`：本实验使用的模板、学习记录、流程、报告和页面入口。`experiment_config.py` 只校验并解析本目录内的配置路径。
- `recipes/`：应用与流程定义；`learned/`：当前机器的已学定位参数；`reports/`：逐次任务输入、截图、耗时与失败记录。
  子能力的 `verification.report` 只引用独立报告，不将整轮真实任务数据复制到每个能力定义里。
- `tests/fixtures/`：独立合成配置；共用执行器检查不再读取网易云配方，也不导入真实学习记录。

窗口规格由配方及已学布局声明，运行时要求二者严格一致；不在通用校验器中写死某个应用的尺寸。
节点、深度、缓存数量、动作及租约边界保留；这些上限不作为任务参数开放。
`learned/` 中的应用指纹、子能力和定位参数依赖当前机器，随 `reports/` 中的真实运行记录一起留在本地，
不纳入源码提交。新检出目录可启动测试台，但完整回放需要先准备并验证当前环境的学习记录；
缺失时明确返回需要学习，不恢复旧实例或自动执行任务。下文各轮实测结论仅适用于所述输入及环境。

名称谓词可声明有界的 `nameAliases` 映射，只接受当前输入对应的准确别名，不做包含匹配或别名链推导；
应用自己的映射保存在任务 JSON，实际控件仍按当前名称与 RuntimeId 核验。
静态标签可显式声明 `bindingScope: container`，学习时保存命名容器身份，在该容器和声明区域内唯一定位标签，
不将中间匿名节点的旧叶子矩形当作跨内容不变的地址，也不回退全树。

把「打开并使用隐藏桌面上的应用」所需的能力**分装成独立、可声明、可逐条验证的基础能力**，
并配一个能直接看到效果的页面。

- 位置：`labs/hidden-desktop/`
- 该实验独立于主工程，本次核心提交仅包含此目录内的运行代码、配置、文档和合成检查。
  主工程的两道检查都不覆盖这里（`npm run check` 只扫 `tsconfig.json` 列出的路径，
  `npm run test:python` 只 glob 仓库根的 `tests/*.py`）。
- 不 import 主工程的任何模块（`src/`、`guest/`、`spikes/` 都不用）；运行期仅依赖 Python 标准库。

## 本家族的硬边界

这一族能力的**定义性特征**是"完全不影响本机"：不动用户的鼠标、键盘、焦点、窗口位置和剪贴板。
它在声明里是**第一等字段**，不是注释：

```python
effects = {touchesUserDesktop: False, sendsSystemInput: False,
           changesForeground: False, touchesClipboard: False}
```

`user-desktop` 环境对**全部**能力一律 `forbidden`。
另有四条边界对整族生效：不切换输入桌面（权限掩码 `0xC3` 不含 `SWITCHDESKTOP`）、
不用系统输入、不回退默认桌面、不改变前台窗口。

## 目录

```
labs/hidden-desktop/
├── capabilities.py               # 27 条基础能力的**声明 + 实现**（唯一事实来源）
├── hidden_desktop.py             # 生命周期与定向动作原语（创建桌面/启动/窗口定尺/枚举/点击/输入/抓画面/租约）
├── uia_client.py                 # 最小 UIA 客户端（只读观测 + ValuePattern / InvokePattern）
├── spawn_window.py               # 目标测试窗口：把自身状态回显在界面上
├── server.py                     # 按能力 id 泛化调度的本地服务
├── ui.html                       # 能力目录 + 逐条表单 + 实时画面
├── verify_real.py                # 更早写的独立真机验证入口（仍需 --real）
├── real_app_validate.py          # **真实第三方应用**上的逐条能力验证入口（需 --real）
├── tests/test_capabilities.py    # 声明约束 / 可用性判定 / 错误翻译（离线）
├── tests/test_hidden_desktop.py  # 生命周期、动作、画面、租约、目标选定、输入路由（离线，注入 FakeApi）
├── tests/capability_bench_smoke.mjs  # 页面烟测：逐条点按钮并核对效果
└── reports/                      # 运行生成的 JSON/PNG 证据（.gitignore 已排除）
```

## 一、能力是怎么"分装"的

每条能力是一份**声明**，页面目录、表单、可用性判定、对外错误码全部由它派生。九段式：

| 段 | 作用 |
| --- | --- |
| `id` / `version` | 稳定身份；发布后不得改名（改名等同新能力） |
| `effects` | 副作用四个开关，见上文 |
| `idempotent` | 重复执行是否等价（步骤级是否可重试属于技能层，不在这里） |
| `environments` | 逐环境标 `verified / partial / planned / forbidden`，`verified` 只在其 `limitation` 内成立 |
| `requires` | **前置事实**：必须由运行时探测，调用方不能申报；探测未知也算不满足 |
| `guarantees` | 成功时必然成立，且要指向另一个**只读能力**来独立复核 |
| `refuses` | 必须 fail-closed 的拒绝条件，每条带稳定错误码 |
| `input` / `output` | 参数与结果；页面按 `input` 自动生成表单 |
| `errors` / `budget` / `conformance` | 错误分类（`kind` + `retryable`）、有限上限、合成用例 |

**27 条，21 条 `verified` + 6 条 `planned`：**

| 层 | 能力 |
| --- | --- |
| environment | `hidden.open` · `app.launch` · `app.close` · `identity.probe` |
| observe | `window.enumerate` · `uia.tree` · `capture` · `state.read` |
| ground | `window`（选定目标窗口：className/title/最大面积）· `structured`（role/label/text/autoId/className，**必须唯一**）· `template`✗ · `vision`✗ · `ocr`✗ |
| execute | `window.fit`（显示 + 定尺为给定几何）· `click` · `type` · `set_value` · `invoke` · `cancel` · `keypress`✗ · `drag`✗ · `scroll`✗ |
| verify | `target.identity` · `capture.rendered` · `structured.equals` |
| control | `lease.renew` · `budget.consume` |

其中 `locate.window` 与 `act.window.fit` 是**真实应用验证逼出来的**：自建单窗口目标不需要它们，
真实应用既会建出十几个顶层窗口，界面窗口也需要先显示并定尺才会展开内容。

（✗ = `planned`，页面里按钮禁用、调用一律返回 `not-implemented`。）

三条纪律：**没实现的一律 `planned`，绝不给 `verified`**；
**没有合成用例的能力不允许是 `verified`**；**声明里不出现任何应用名**——
能力按"界面结构 + 事实"选择，应用名只出现在技能层。

## 二、页面怎么用

```bash
cd labs/hidden-desktop
python server.py                 # 默认 http://127.0.0.1:8790/
python server.py --lease 30      # 租约秒数（1..3600），默认 300
python server.py --no-browser
```

页面左边是按层分组的能力目录，右边是"隐藏窗口画面 + 本次会话 + 执行日志"。

典型流程（每一步都能在页面上看到结果）：

1. `env.hidden.open` → 创建自有隐藏桌面
2. `env.app.launch` → 在隐藏桌面上启动目标测试窗口（等 1~2 秒）
3. `observe.uia.tree` → 列出控件；之后表单里的目标值会自动补全候选
4. `act.click`（默认目标 `1002`）→ **右侧画面里 `clicks` 从 0 变 1**
5. `act.type`（目标 `1001`）→ 画面里 `文本="hello 世界"`
6. `act.set_value` → 画面里文本被语义赋值替换
7. `observe.state.read` → 直接读出目标窗口的状态回显行
8. `verify.structured.equals` → 结构化字段严格相等断言
9. `env.app.close` → 清理并确认桌面消失

**"看得见的效果"是怎么做到的**：目标窗口（`spawn_window.py`）自己有一行状态回显
（`clicks=… 文本=… 勾选=… 列表选中=…`），任何动作的效果都会立刻反映在画面里；
执行类动作完成后服务端还会自动抓一张图，右栏同步刷新。

## 三、目标测试窗口

### 歌曲搜索与打开的手动流程

页面左侧可切换「基础能力目录」和「搜索并打开歌曲」，右侧画面保持固定。
这是本实验中的手动能力编排，不依赖或接入主工程，也不使用真实模型。

1. 在能力目录创建隐藏桌面、启动已配置的网易云，必要时用 `locate.window` 选定窗口。
2. 保证租约有效；分步操作时间较长时，显式调用 `control.lease.renew`，例如 `seconds=900`。
3. 切换到流程，逐次点击「执行第 N 步」。每一步展示能力与参数预览、实际调用和返回、核验结果。
4. 搜索词固定为 `甲乙丙丁 李佳薇`，目标为李佳薇《甲乙丙丁（你我怎么两清）》。
   搜索入口、歌曲标题从完整的实时 UIA 观察中手动选择，不保存坐标、索引或占位文字为永久定位。
5. 打开前须人工核对同一歌曲行的歌手；打开后重新读取 UIA 和已渲染截图，再单独人工确认已进入详情页。
   同屏出现歌名与歌手只记为文字证据，不自动判定详情页验收通过。

流程没有收藏、下载、双击播放、后台自动推进或动作自动重试。`act.keypress` 仍未实现：
如果应用没有可点击的搜索入口而只能通过 Enter 提交，流程会停下，不能宣称搜索已经成功。
目标不唯一、树被截断、窗口更换、值回读不一致、调用失败均停止推进；先核对现场，再新建一轮。
等待结果加载时可点击「重新观察当前页」，不会重复提交搜索或打开动作。
基础能力目录中的界面操作或窗口更换会使当前流程失效；只读观察、抓图和显式续租不使流程失效。

记录保留在当前页面内，可导出 JSON；新一轮保留本页的上一轮记录。刷新页面会清空流程记录。
本流程的纯状态机合成验证（Fake 能力返回、无网络和实机输入）：

```bash
node --test labs/hidden-desktop/tests/song-flow.test.cjs
```

该验证不代表真实歌曲流程已通过，实际搜索与打开由页面逐步验证。

### UIA 角色查询与等待显示

指定 `observe.uia.tree.role` 或按角色执行 `locate.structured` 时，用
`FindAllBuildCache` 在一次批量请求中取得候选元素的 ControlType 标签，再从本地缓存筛选。
角色查询直接取得一次完整快照，不再重复进行全树数量探测（该探测在隐藏桌面本身就很慢）。
快照完成只代表本次范围内枚举完整，不承诺应用已永久稳定；独立核验及后续动作仍会分别重新查询。
全树详细观察保留原来的数量稳定性探测。
只对匹配项读取当前详细属性与归属；多个角色共享同一批轻量标签。
不通过 provider 属性条件逐项筛选（该路径在本机实测反而更慢，已移除），不跨调用复用旧缓存。
全树扫描仍然存在，但不再逐个跨进程读取非目标控件的角色与详细信息。
匹配项继续核对当前角色、归属及密码属性；禁用、屏外重复项不会被提前剔除。
定位与独立核验分开取得新结果，不用首个匹配代替唯一性判断。

返回新增 `queryScope`：`kind=all-descendants` 表示扫描范围仍为自有窗口后代，
`roles` 记录所选角色，`roleRead=batch-cache` 表示批量缓存角色（无筛选时为 `current`）。
`stageTimingsMs` 分别记录稳定性探测、角色缓存和详细读取的耗时，便于定位剩余代价。
`availableElements` 与 `enumerationComplete` 保留原有候选范围语义，不能把返回一条 Edit 说成只扫描了一个控件。
候选集超预算时即使已找到一个目标，也不能确认唯一，会返回 `enumeration-truncated`。
未指定角色时仍走原来的全树详细观察；不宣称该路径提速。
客户端使用 CUIAutomation8/IUIAutomation2，关闭隐式焦点切换，provider 连接／事务超时为
2／5 秒（不是整个查询的硬截止时间，未扩大原有能力预算）。

分步流程显示当前子调用、执行中状态及已等待时间，每秒更新文字而不重绘调用记录；
结束后保存前端实际等待耗时，服务端 `elapsedMs` 单独保留。失败时停止计时且不自动重试。
基础能力目录中的调用也显示等待时间。动作执行期间暂停后台状态轮询，避免请求积压；
计时不延长租约或能力预算，不表示后端调用可以被安全取消。

2026-10-15，同机网易云只读查询的一次对比：原定位／独立观察为 14641／16343 ms，
最终角色缓存方案为 11984／12327 ms，合计从 30984 降到 24311 ms（约减少 22%）。
provider 的原生角色缓存仍占约 12 秒；这是单次场景测量，不代表所有窗口都能达到同一耗时。
只验证到搜索框定位与独立核验，未输入搜索词、打开歌曲或收藏，未运行完整工程测试。

针对性合成检查（不运行完整工程测试）：

```bash
python -m unittest discover -s labs/hidden-desktop/tests -p test_uia_role_query.py -v
python -m unittest discover -s labs/hidden-desktop/tests -p test_capabilities.py -v
node --test labs/hidden-desktop/tests/song-flow.test.cjs
```

自建一个经典 Win32 表单，控件都带稳定 `automationId`：

| 控件 | automationId | 用来验证 |
| --- | --- | --- |
| EDIT | `1001` | `act.type`（WM_CHAR）/ `act.set_value`（ValuePattern）/ `observe.state.read` |
| BUTTON | `1002` | `act.click` / `act.invoke` / 点击计数 |
| CHECKBOX | `1003` | 点击的布尔语义 |
| LISTBOX | `1004` | 带索引的列表项定位与点击 |
| STATIC | `1005` | **状态回显行** |

## 四、踩过的坑（都写进代码注释了）

1. **DPI 必须统一**。本机是 150% 缩放，而 DPI-unaware 进程拿到的是**虚拟化坐标**：
   UIA 报的控件宽是 267，物理其实是 400（正好 1.5 倍）。于是"定位到的坐标"和"点击用的坐标"
   分属两个空间，非 100% 缩放下必然点错。修法是进程级 `SetProcessDpiAwareness(2)`，
   让 UIA / `GetWindowRect` / `GetClientRect` / 点击坐标同源。
2. **`EnumDesktopWindows` 只枚举顶层窗口**。子控件不在其中，所以"目标在自有桌面上"的判据
   必须是"同进程 + 根祖先属于自有窗口树"，不能用桌面枚举。
3. **经典 Win32 控件的点击要发给控件自己的 HWND**，发给父窗口不会被转发。
4. **STATIC 必须带 `WS_BORDER`**：无边框 STATIC 是透明背景控件，屏幕上看正常，
   但 `PrintWindow` 抓取时长文本只画出一小截。
5. **`FillRect` 在 user32 而不是 gdi32**；GDI 调用漏 argtypes 会把 64 位句柄按 `c_int` 传并抛 `OverflowError`。
6. **画面 token 与桌面同生命周期**：桌面关闭/重建后必须清掉缓存的画面引用，
   否则新会话一建立，页面就去请求上一轮已删除的图（404）；页面侧还要记住失效 token，避免每轮重试。

## 五、本机实测结果（自建目标，2026-10-14）

环境：session 20、完整性 `S-1-16-8192`、输入桌面 `Default`、显示缩放 150%。

| 检查 | 结果 |
| --- | --- |
| 离线测试 | **102/102 PASS** |
| 页面上目录渲染 | 27 条能力、6 层分组、副作用全绿、未实现能力按钮禁用 |
| 页面端到端 | **31/31 PASS**，零 JS 报错 |
| 执行效果回读 | `clicks=0 → 1`（click）、`文本="hello 世界"`（type）、`文本="语义赋值"`（set_value）、`clicks=2`（invoke） |
| 拒绝路径 | 目标不存在 → `target-not-unique`；断言不等 → `assertion-failed`；6 条未实现能力 → `not-implemented` |
| 自动刷新 | 展开状态、表单内容与结果均保留 |
| 真实第三方应用 | `real_app_validate.py` → **24 通过 / 2 被拒 / 1 跳过 / 0 失败**，约 5 分钟 |

## 六、真实第三方应用验证（2026-10-14）

在 `E:\app\CloudMusic\cloudmusic.exe`（网易云音乐 3.1.40.205461，CEF 多进程）上跑
`real_app_validate.py`，**24 通过 / 2 条按纪律被拒 / 1 条说明原因的跳过 / 0 失败**。

| 结论 | 证据 |
| --- | --- |
| 真实应用能在自有隐藏桌面上启动且不影响本机 | 自有进程建出 23 个顶层窗口，`verify.target.identity` 报 `inJob/sameUser/sameSession` 全真 |
| **必须先"显示 + 定尺"** | 定尺前 UIA 只有 60~64 个元素；`act.window.fit(1600×1000)` 后展开到 **627** 个 |
| UIA 观测可用但有代价 | 627 个元素全量枚举约 **11 秒**；整个验证流程约 5 分钟 |
| 输入优先级被实测钉死 | `act.set_value`（ValuePattern）与 `act.type`（WM_CHAR 下钻到渲染子窗口）**都生效**，且都由 `verify.structured.equals` 独立读回校验 |
| 拒绝路径同样成立 | 不受支持的定位方式 → `unsupported-locator`；`role=Button` 不唯一（实测 44 个）→ `target-not-unique` |
| 未执行 | `act.invoke` 的正向路径：在别人的真实应用上调用任意按钮会触发真实业务动作，本验证不制造此类副作用 |

**第一步只做只读 + 自有窗口几何**，写入真实应用需要显式 `--allow-input`。

## 七、真实应用逼出来的九个缺陷（都已修）

跑真实应用之前，25 条能力在自建窗口上全绿；跑之后暴露出九个**在自建目标上测不出来**的问题——
前六条是能力本身的缺陷，后三条是治理层面的：

1. **`main_windows()` 只认"pid 等于启动器"** → CEF 的界面窗口由子进程承载（实测 `Chrome_WidgetWin_0` 的 pid 是 GPU/渲染子进程），合法目标会被误判成外来窗口。判据改为**属于本次 Job**。
2. **单实例应用会被静默重定向** → 目标程序已有实例时新进程立刻退出，能力会报"找不到窗口"，而真正原因完全不同。`env.app.launch` 现在先探测同名进程并返回 `existing-instance`。
3. **真实应用需要启动参数才暴露 UIA**（如 CEF 的 `--force-renderer-accessibility`）。`env.app.launch` 增加 `args` 字段；**能力本身不做应用特判**，参数由调用方给。
4. **界面窗口需要先显示并定尺内容才会展开**（60 → 627 个元素）。新增 `act.window.fit`（`ShowWindow` + `SetWindowPos`，不激活、不改 Z 序、尺寸有预算）。
5. **`act.type` 在 CEF 上是"静默无效果"** —— 消息成功发出、界面纹丝不动，比报错更糟。改为沿**窗口树 + 坐标**下钻到真正的输入接收窗口（实测 目标窗口 → CefBrowserWindow → Chrome_WidgetWin_0 → Chrome_RenderWidgetHostHWND），**不依赖任何窗口类名**。
6. **`act.click` 取的是"窗口中心"而不是控件中心** → CEF 元素没有自己的 HWND 时会点到完全无关的位置。改为按 UIA 矩形换算并校验落在客户区内。
7. **15 个内部错误码没有稳定归属**，真实触发时退化成无意义的 `dispatch-effect-unknown`（例如 `capture_requires_unique_window`）。现在有平台级 `ERROR_CATALOG`，并有**门禁测试**扫描源码里所有内部码，禁止任何一条再退化成"未知"。
8. **UIA 枚举超预算会直接失败** → 把"树太大"变成"能力不可用"。改为**截断并标记** `enumerationComplete=false`；`locate.structured` 在截断状态下"没找到"会报 `enumeration-truncated` 而不是 `target-not-unique`——**没找到 ≠ 不存在**。
9. **首次枚举的结果不完整**：查询本身会触发应用异步构建无障碍树（实测同一个窗口 64 → 627）。枚举现在会先用"只数不读"的方式等树稳定。

## 八、怎么跑

```bash
cd labs/hidden-desktop

# 离线（零真机副作用、不加载任何窗口）
python -m unittest discover -s tests -v

# 页面烟测（逐条点按钮并核对效果）
PLAYWRIGHT_BROWSERS_PATH=<C 盘浏览器缓存> \
  node tests/capability_bench_smoke.mjs http://127.0.0.1:8790/ reports/ui

# 独立的真机验证入口（仍需显式 --real）
python verify_real.py --real --report reports/real-run.json

# 真实第三方应用上的逐条能力验证（默认只读 + 自有窗口几何）
python real_app_validate.py --real --app "<绝对路径>.exe" \
  --args="<启动参数>" --report reports/real-app/app.json

# 允许向真实应用写入文本：只作用于唯一的文本输入控件，用完还原到原值
python real_app_validate.py --real --app "<绝对路径>.exe" --args="..." --allow-input
```

`E:` 盘上的 Playwright chromium 会报 `Invalid file descriptor to ICU data received`，
把浏览器缓存放 `C:` 盘即可。

## 九、已知边界

- 只在 Windows 上运行，且需要交互会话（否则以 `session-not-active` 明确拒绝）。
- `locate.template` / `locate.vision` / `locate.ocr`、`act.keypress` / `act.drag` / `act.scroll`
  在本家族**尚未实现**（主工程能力表里 `RAW_ISOLATED_INPUT` 也是 `NOT_PROVEN`）。
- 自绘界面（Canvas / DirectX / 无 a11y 的 CEF）在 UIA 下拿不到控件，只能靠后续补的定位层。
- **真实应用的 UIA 观测很慢**：627 个元素全量枚举约 11 秒、整个验证约 5 分钟，
  期间会把 60 秒租约耗尽（页面默认 300 秒，且提供显式续租）。这是实测代价，不是缺陷。
- **`largest` 选窗口在真实应用上不可靠**：实测会选中面积最大但不可见的 CEF 辅助窗口
  （2880×1537），而不是真正承载界面的窗口（32×32 → 定尺后 1601×1128）。
  所以默认走"自动唯一"，需要覆盖时用 `className` / `title` 显式选定。
- **不改写应用自身的成功判据**：`verify` 只回答"这一步的事实成不成立"。
  验证跑到"听得见声音"这一层需要人工确认，本子工程不宣称。
- 上线接入主工程**不在本子工程范围内**：这里是一次能力分装与验证，不是把主工程切过去的迁移。

## 十、UIA 查询对照实验（独立入口）

`uia_query_experiment.py` 将原全后代角色查询与逐级 `Children` 重绑定对照，
默认各测 5 次，交替先后，报告原生 Find、数组计数、端到端耗时和成功中位数。
首次 UIA 就绪查询独立记录，不计入五轮中位数。入口不注册新能力、不改变手动歌曲流程。

```powershell
python uia_query_experiment.py --real --app "<绝对路径>.exe" `
  --args="<显式启动参数>" --runs 5 --report reports/uia-query-experiment.json
```

仅启动自有隐藏桌面中的应用、定尺和读取；没有搜索、点击、播放、收藏或其他业务输入。
必须先清理测试台持有的旧实例，遇到已有第三方实例会拒绝。结束必须确认自有 Job / 桌面清理。
默认租约为 900 秒，保留既有最大租约与 2000 元素预算，不静默续期。

每级使用 `role / AutomationId / className` 描述，完整枚举直接子节点并要求唯一，
再核对发现时的 RuntimeId 和原 desktop instance / session / HWND / PID。
RuntimeId 只用于身份复查，不用于从重复描述中选中一个。路径仅绑定本次环境，
未证明跨重启稳定；容器内唯一不表示整个窗口全局唯一。歧义、重建或不完整时直接拒绝，
不使用首个匹配、索引或静默回退，拒绝耗时也不计作成功定位的速度。

2026-10-15 本机五轮结果：全树 5/5，中位 10.29 秒；分层 0/5，
遇到 14 个同描述容器后拒绝，暂不改变上层流程。细节见本地
`reports/uia-query-review.md`，原始记录和截图均不提交。

## 十一、P3 身份与覆盖实验

`uia_p3_experiment.py` 是独立只读入口，不改目录、UI、流程或主工程。
采集歧义容器最小身份、父子/祖先关系、Edit 分布；用固定五轮轮换对照原查询、
ControlView、完整 Children 分区、RawViewWalker 分区和独立结构重绑定。
不使用坐标、数组顺序或 RuntimeId 从歧义项中强选；失败不静默回退。

```powershell
python uia_p3_experiment.py --real --app "<绝对路径>.exe" `
  --args="<显式启动参数>" --runs 5 --report reports/p3/uia-p3.json
```

2026-10-15：25 次对照完成，原查询中位 10.190 秒，等价完整分区 10.246 秒，
ControlView 10.325 秒；其余两方案因覆盖不等价或结构不唯一各拒绝 5 次。
目标 Edit 没有原生 HWND，该快速路径不适用。没有找到同时正确且更快的替代方案，
P4 主工程集成 **NO-GO**。详细报告及 NOT_PROVEN 项目见 `reports/p3/REPORT.md`。

P3 也修正了 P2 的原因归纳：原选择器的 14 个匹配项不包含正确 Raw 祖先，
不仅是选择器未使用 Name；RawViewWalker 能找到该层正确祖先，但第 10 层仍有两个
同属性同直接子结构的候选。保留原始实验记录，不把这类拒绝计作性能提升。

## 十二、当前通用定位方式：全树唯一 + 当前身份

正式供本 labs 手动流程使用的仍是原全后代查询，不启用 P3 尚未通过的快速路径。
`locate.structured` 在完整查询且唯一后，独立读取当前 PID/RuntimeId、Raw 祖先链、
原窗口/Session/Instance 归属及最新矩形，返回 `identity` 数据证据。
RawViewWalker 只核对归属，不从歧义候选中选择目标。

后续能力的 `target.expectedIdentity`（以及再次定位时的顶层 `expectedIdentity`）
可传入上一次返回的 identity。每次仍现建客户端、重新全局查询并再次证明唯一，
比较 desktop / instanceId / session / hwnd / windowPid / rootRuntimeId / elementPid /
runtimeId；变化报 `target-identity-changed`，不自动改选同名控件，不自动重放。
该字段是附加限制，不能授予归属、绕过预算或将局部唯一冒充全局唯一。

手动歌曲流程自动传递此证据，独立观察还要确认同一 Edit 的 RuntimeId；每步窗口
绑定同时检查 Session 与 Instance。输入、点击、回读的结果也返回本次独立证明。
输入框 Name 可随内容变化，不用旧占位文字作为跨操作身份。

能力 ID、基础表单及 27 条目录不变，相关能力兼容性新增版本为 1.1.0；原安全和预算
上限保留。此改动加强衔接核验，不宣称降低约 10 秒的原生全树查询耗时。

歌曲演示兼容中文「搜索」与英文独立词 `search`；歌名比较仅统一 Unicode 括号和空白，
定位时仍使用实际观察的原始名称，不接受伴奏、合唱、翻唱或 Live 版本。格式统一后
出现多个同版本候选仍拒绝。最终人工确认不会由测试自动代填。

## 十三、网易云已学能力（当前环境配方）

2026-10-15 起，此标签使用 **JSON 学习记录 + 共用执行器**，替换应用专用的 JS 操作脚本。
此前“每次操作都全树重新查询”的实现和历史实测报告保留为历史，不代表当前执行路径。
基础目录和旧歌曲分步流程仍使用原契约；这里单独采用用户指定的固定软件/界面假设。

| 文件 | 用途 |
| --- | --- |
| `recipes/cloudmusic.search.template.json` | 已验证流程的声明模板，包含启动、目标、参数、动作和核验规则 |
| `learned/cloudmusic.search.json` | 点击学习后产生的本机数据，包含模板及当前程序指纹、目标属性、学习时间；忽略提交 |
| `learned_replay.py` | 共用执行程序，解释有限 JSON 指令；不根据应用名选择脚本 |
| `learned-skills.js` | 共用页面客户端，只提交 JSON 操作 ID 和参数、显示后台子调用 |

使用顺序：启动应用 → 学习／重新学习 → 填写并核验 → 提交搜索。
学习成功后当前实例已绑定，无需再点第二步。应用重启后，读取已有 JSON 再点
「绑定已学目标」；同一实例再次绑定只做轻量实时检查，不扫全树。
没有 JSON、JSON 参数缺失/无效或程序指纹改变时，明确要求学习，不自动回退。
学习只发现和读取目标，不执行搜索，也不等于重新验收完整工作流。

学习/新实例绑定时，对 JSON 中每个目标做一次原完整唯一定位。后续执行保留的
UIA 引用只用于寻址；每次现场检查原 Session/Instance/窗口、PID/RuntimeId、
Job 归属、密码属性、启用/屏外状态、祖先链及最新矩形，实际值另开 ValuePattern
现场读取。不复用旧值、坐标或操作成功结论，也不重新全树查询。
结果明确标记 `globalUnique=null`、`uniqueness=proven-at-binding-only`，不能冒充
一次新的全局唯一观察。其他位置新增同名控件不会使已经绑定的原目标自动改选。

COM 引用仅在一个专用 MTA 线程内存活；JSON 不保存 HWND、PID、RuntimeId 或指针。
应用关闭、外部动作、清除绑定、失败和服务退出时在该线程释放。版本变化要求重新
学习；原目标失效要求手动清除/重新绑定，仍失配则重新学习；不自动重试任何输入。
动作尝试计入原预算，保留默认桌面隔离和显式租约；不修改基础能力的全局唯一性契约。

JSON 中需要记录的内容：

| 内容 | 当前字段 | 是否长期保存 |
| --- | --- | --- |
| 格式和技能身份 | `schemaVersion / id / revision / title` | 是 |
| 启动和运行环境 | `application / environment`：路径、启动参数、窗口类、尺寸 | 是 |
| 软件适用版本 | `learning.applicationFingerprint`：可执行文件 SHA-256、大小、路径 | 是 |
| 调用输入 | `parameters`：类型、必填长度、默认值；动作通过 `parameter` 引用 | 是 |
| 目标定位规则 | `targets.*.selector / namePolicy`；输入框名称允许随值变化 | 是 |
| 学习得到的目标属性 | `learning.targets`：角色、名称、autoId、类名 | 是，供检查与解释 |
| 动作与核验顺序 | `operations[].steps`：launch、bind、set_value、assert_value、click、wait、capture | 是 |
| 前后置状态和完成条件 | `requiresState / remember / consume / acceptance / completion` | 是 |
| 失效处理 | `replayPolicy`：缺数据、版本变化、目标过期和禁止自动重试 | 是 |
| 学习证据范围 | 时间、`validation=targets-and-patterns-only`、工作流未重验标记 | 是 |
| 当前实例绑定及输入状态 | HWND、PID、Session、RuntimeId、COM、已核验的本次输入 | 否，仅本次运行内存 |
| 每次执行结果和截图引用 | 后台 job/calls；页面可导出调用记录 | 与学习 JSON 分开 |

当前版本适用性以 exe 内容指纹判断；尚未覆盖全部 DLL、远端页面或资源包版本。
界面结构变化而程序指纹未变时，通过实时目标检查发现失配并停止，不能保证检测所有
远端语义变化。固定软件/界面是本实验前提，不宣称跨版本迁移。
搜索结果采用截图人工核对。歌曲打开采用下述独立操作学习；不包含收藏。
提交操作的耗时是发送动作、有限等待和读取当时画面的耗时，不包括等待网络结果
完全加载。若截图仍在加载，使用右侧「刷新画面」单独读取，不能重放搜索来补图。

本机 API：POST `/api/learned/start`，请求 `{action, inputs}`，其中 action 可以为
JSON 中的 operation ID、`learn`、`learn:<operationId>` 或 `reset`；返回 jobId。
GET `/api/learned/status?id=<jobId>` 读取当前子调用、耗时、结果和错误。
写请求仍要求 `X-Lab: 1`，不能提交代码或任意脚本。
此 API 仅属于 labs，不是主工程 MCP/HTTP Skill Registry。

针对性检查（不运行完整 AD 测试）：

```powershell
python -m unittest discover -s labs/hidden-desktop/tests -p test_learned_replay.py -q
node --test labs/hidden-desktop/tests/learned-client.test.cjs labs/hidden-desktop/tests/song-flow.test.cjs
```

## 十四、实时画面与截图传输生命周期

右侧「实时画面」默认开启，页面可见、目标窗口就绪且租约有效时，约每秒拉取一张。
关闭开关后停止自动取帧，仍可单独点击刷新；切到不可见页面时暂停取帧。
每个页面最多一条在途请求，服务端并发取帧拒绝排队且限频；不启动无限后台录像。
租约、归属或几何检查失败会暂停并显示原因，不自动续租或改抓默认桌面。

核心实现是 `HiddenDesktop.capture_frame()`，复用原 PrintWindow、Job/用户/Session/
默认桌面与几何检查，返回受 4MiB/2048 尺寸限制的内存 PNG。抓取前后核对原实例和
目标身份，捕获与环境清理用同一把锁互斥。UIA 学习持有执行锁时，独立只读取帧
不排在执行锁之后；帧中不携带任何输入/控制权限。

POST `/api/preview/live`（X-Lab: 1、请求体 `{}`）返回 `image/png`，元数据位于
`X-Lab-Frame` 响应头。`live-preview.js` 负责单请求轮询、暂停、旧实例帧丢弃；页面
同时释放旧 Blob URL。服务端 `live_preview.py` 最多保留最近 2 张 PNG（合计最多
8MiB），按实际抓取顺序丢弃迟到旧帧，不创建无限文件或帧队列。

普通 `observe.capture` 保留原来最多 8 个待处理文件的约束。服务端读取、验证长度和
SHA-256 后立即消费并删除私有传输文件，再交给有界内存预览。这与主工程
`workbench-app-native-client.ts` 的 `readPreview()` 读取后 unlink 思路一致；labs
不 import 主工程。旧问题是 labs 只生产文件、从未消费，导致第 9 张必定拒绝。
原始能力直接连续产生 8 个未消费文件时仍应拒绝；实时取帧不占这个传输池。

预览是瞬时传输，token 只对应最近的有限帧，不是长期证据仓库；流程报告里的哈希
和取帧时间仍保留，需长期保存的 PNG 应另行导出。画面不等于动作成功验收。
`/api/state.previewTransport` 可检查 retainedFrames/frameLimit 和
pendingFiles/pendingFileLimit；实时流不会刷满执行日志或消耗动作预算。

针对性检查：`test_live_preview.py`、`live-preview.test.cjs` 和已有 CaptureTests。
上述合成检查不启动应用；不运行完整 AD 测试。真实操作验证另见下一节的记录。

## 十五、操作学习与歌曲页回放

`learningRequired: true` 的操作必须先在页面点击“学习并验证”。共用执行器运行
模板中的有限指令，所有页面断言和最终截图成功后才原子保存到原学习 JSON；失败
保留旧文件并停止。之后“调用”从保存的 JSON 回放同一个操作，操作内容哈希变化
需要重新学习。上方普通“学习／重新学习”仍只学习搜索入口，不自动执行新操作。

新增通用指令：`observe_page` 完整观察当前自有窗口；`assert_rows` 核对匹配数量；
`click_match` 要求唯一匹配、现场重读身份和矩形后定向点击。匹配参数包括准确
ControlType/Name、相对窗口区域，以及相邻歌手的文字与相对位置关系。区域是当前
固定布局的约束，与精确名称联合使用，不使用数组下标或固定第 N 个条目。
完整查询被截断、重复、目标变动、实例变化、版本变化均停止；原基础能力契约不变。

`bind_match` 通过唯一匹配保留本次操作内的控件寻址引用；`ensure_state` 从该控件
实时读取声明的状态名称，只在可操作状态时点击一次，并独立回读期望状态；未知状态
或身份变化即失败。这用于双击后立即暂停，避免先等完整查询而发生自动切歌。
RuntimeId 在候选筛选后读取，不因无关动态歌词没有 RuntimeId 而丢弃候选；选中目标
仍必须有有效身份并通过原有祖先/几何检查，原基础能力的默认身份读取不变。

动态页面在显式观察点重新查询，观察内不重复全树查询；有动作后旧快照失效。
此阶段打开歌曲仍有页面观察成本，尚未承诺整个过程不再查询 UIA。搜索入口仍保留
原有实例内快速绑定。学习 JSON 保存可重放规则、通过的断言数量、操作哈希和截图
哈希/时间；COM、PID、HWND、RuntimeId 不写入新操作的长期学习参数。

歌曲流程为：精确标题与同卡片歌手核对 → 双击 → 核对底部播放器身份 → 封面进入
歌曲页 → 详情页断言及截图。当前版本顶部大标题未提供 UIA，详情歌手链接祖先层级
超过原检查上限；保留原上限，通过底部准确歌名/歌手、歌词标签与收起按钮联合
断言详情页，再以实际截图人工核对顶部标题。双击可能开始播放，流程立即暂停；
收藏从未加入该流程。
最终真实结果和适用布局见本机 `reports/ui/open-song-review.md`。

## 十六、独立子能力与整体播放流程

`/workflows/cloudmusic` 是单独的整体流程页面，原实验台提供入口。它有歌曲标题、
歌手两个输入，“回放完整流程”执行整条链路，也可顺序点击每项“仅调用此子能力”。
右侧固定显示实际窗口，左侧可独立滚动；所有调用仍经过同一 MTA 执行器与安全边界。

三层分别保存/维护：

| 层次 | 保存位置 | 职责 |
| --- | --- | --- |
| 基础能力 | `capabilities.py` | 原子观察、定位、输入和核验契约 |
| 独立子能力 | `learned/capabilities/<id>.json` | 启动或复用、显示搜索入口、绑定、填写、提交、打开详情并暂停、开始播放 |
| 整体流程能力 | `recipes/workflows/cloudmusic.open-and-play.json` | 通过 ID、revision 与内容哈希引用上述 7 项，绑定参数，顺序调用 |

每份子能力 JSON 包含完整环境/版本/定位契约和一项 operation，可单独加载回放。
原有 `learned/cloudmusic.search.json` 保留。整流程 JSON 不复制子能力的步骤，不生成
应用专用脚本；`${song}`、`${artist}` 只作整个 JSON 字符串的字面值参数替换。
工作流的 join 输入绑定只拼接已声明字符串参数，不支持代码、路径或任意表达式。
这套 labs schema 不修改主工程的 Workflow schema。

流程顺序：启动或核验复用自有实例 → 显示搜索入口 → 绑定搜索目标 → 填写并回读 →
提交搜索 → 打开详情并暂停 → 核对歌曲身份、启动播放、独立核对正在播放状态。
新增加的 `ensure_app` 只复用本次实验拥有且身份吻合的进程；不接管外部实例。
`click_if_present` 只有在声明的观察范围中候选为 0 时才明确跳过，为 1 时定向操作，歧义拒绝。
子能力可复用内存绑定的前提是环境、版本和目标参数契约完全相同；引用不会写进 JSON。

`POST /api/learned/start` 支持 `{action:"workflow:cloudmusic.open-and-play",inputs:{song,artist}}`，
以及 `capability:<id>` 单独调用。接口均返回同一 job 结构；当前步骤、参数、每项返回和
验证在 job.workflow / calls 中记录。完整依赖及输入先校验，随后才开始有副作用的步骤。
任一步失败或效果未知立即停止，不执行后续步骤、不自动重试。需要时显式清除失败状态。

已记录的搜索及打开能力保留原有证据范围；参数化输入、复用启动、返回搜索与最终
播放链路在此轮均标记待用户实测，未声称新的整体真实流程已经通过。此次只运行合成
检查和页面/服务启动检查，不运行完整测试、不实际执行歌曲播放、不收藏、不接入主工程。

## 十七、固定窗口规格与局部绑定回放

独立播放流程的 7 份能力 JSON 已迁移至 revision 3。`localReplay` 声明物理像素
1600×1000、局部范围、最多 256 个访问节点/16 层，以及实例内绑定缓存上限。
启动时设置 DPI 坐标模式、显示并定尺，随后核对实际窗口尺寸；尺寸未生效立即停止。
搜索入口范围为窗口顶部；详情页“歌词”标签范围扩展到详情头部，修正原先过窄的
纵向匹配范围。旧截图使用过 1601×1128，不能沿用其归一化区域作为新布局的保证。

显式学习中的 `observe_local` 操作不调用 FindAll。首次使用某个完整匹配谓词时，以 ControlViewWalker
逐层读取声明区域，跳过不相交的可见祖先分支；零矩形包装层继续遍历。此范围显式
依赖 `control-view-visible-ancestor-containment`，不是全窗口覆盖证明，也不改写 P3 的 NO-GO。
查询超预算、深度超限或存在多个候选均拒绝，不截断后选第一个，不隐式切回全树。

成功绑定后，在同一执行器/Session/Instance/窗口内复用目标引用，并逐次重新读取
当前属性、RuntimeId、祖先与矩形；歌曲身份及播放状态均以当前局部读数核验。
COM 引用用于寻址，不作为旧观察证据；不会保存到 JSON 或在重启后复活。缺少
局部参数、版本/布局变化或目标失效会停止并提示重新学习，不自动搜索替代目标。
缓存只保留最多 32 个谓词、合计 2000 个元素；失败、重置与环境关闭在专用线程
释放引用。可选控件“缺席”结果不缓存。

局部验证输出 `scope=learned-local-region`、`globalUnique=null`；暖绑定只证明该实例
目标身份仍有效，不重新证明全局唯一。原 `observe.uia.tree`、`locate.structured` 及
原学习页的完整观察保持原契约，供用户显式检查/重新学习；新执行路径不自动调用它们。

每次调用分别记录局部查询次数、复用读取次数、当前子调用、参数与耗时。最近一次
完成/失败的记录原子保存到 `reports/latest-replay.json`，GET `/api/learned/latest`
只读恢复页面记录；重启服务不恢复绑定或重发动作。刷新运行中的页面只继续观察。

本轮仅做合成针对性检查及服务/页面基础启动。新局部路径的真实覆盖、耗时和整体
播放结果仍为待用户实测；旧真实学习证据仅证明原操作语义，不代表新路径已实测通过。

### 显式学习定位路径与手动回放

“重新学习定位参数并验证流程”运行同一 JSON 整流程，通过后才原子保存
`learned/cloudmusic.local-paths.json`。它记录应用指纹、布局契约、匹配参数和经过
核验的 Raw 祖先路径，每个路径节点只含 role、AutomationId、类名和相对窗口矩形。
不保存 PID、HWND、RuntimeId、COM 引用或程序脚本；失败保留旧定位文件。

“回放完整流程”读取该文件，按组合身份路径重新绑定当前元素；逐层检查全部
符合路径的分支，不选固定第 N 项，末端继续核对歌曲、歌手、归属和当前状态。
路径缺失、歧义或失效立即提示重新学习，不自动降级为发现查询。首次显式学习
可使用 Control View 的局部发现；普通回放不调用该发现路径或 FindAll。

声明的页面切换通过 `newPageBindings` 在操作起点释放上一页的临时引用，之后
从保存的路径重新绑定；同一页中仍复用绑定并独立读取。`readyMatch` 只在明确的
页面切换点有限等待 UIA 就绪（2 秒），只重读条件，不重发点击。未知失效仍拒绝。
路径回放的 scope 为 `learned-target-identity-path`，仅证明声明路径中的候选和
目标身份，不重新宣称整个窗口全局唯一。原归属、预算、深度和隔离边界保持。

原生宿主使用 `nativeAnchor` 区分实例性 AutomationId；重绑时检查当前原生归属，
不把 HWND 派生的 ID 当成固定参数。矩形采用重叠区域约束，末端仍按声明区域、
准确名称和关系检查；允许文字排版的小幅变化，不单凭坐标或数组顺序选目标。

## 十八、当前指定歌曲的真实自测结果

在用户随后授权实际自测后，本机当前网易云版本和1600×1000布局已完成：
显式学习定位参数并核验94.254秒，服务/应用重启后从磁盘JSON回放25.630秒，
同实例第二次完整回放21.707秒。两轮7步均完成并独立核验准确歌曲、李佳薇和
正在播放状态；普通回放无全树发现，未执行收藏，未接入主工程，未跑完整测试。
这些是单次端到端实测，不是通用性能保证。69条相关合成检查通过。

本节真实自测结论取代上述初轮“仅基础启动、待用户实测”的状态；范围只覆盖
该输入和当前环境。详细记录与失败样本见 `reports/ui/local-selftest-review.md`。

## 十九、参数化歌曲回放与临时首个匹配规则

播放流程及七个子能力为 revision 4。长期定位文件 schemaVersion 2 分开保存静态控件路径、
已学命名容器及 `${song}` / `${artist}` 匹配模板；运行时把实际输入代入模板，在容器内
重新读取当前候选。查询键使用未替换的模板，换歌不再查找另一份歌曲专属路径。
JSON 不含可执行代码，不为每首歌生成脚本。版本、布局或已学容器失效仍停止并提示重新学习；
有效容器内没有业务匹配时提示核对输入，不能把两者混为一谈。

用户本轮明确选择临时策略：歌曲搜索结果按歌名及歌手筛选后，播放当前列表显示顺序的
首个匹配项。仅该谓词声明 `selectionPolicy: first-visible-match`，依顶部、左侧排序，
不使用原始数组序号；记录完整声明范围内的候选数与实际选中目标，不声称唯一。
暖读只核验已绑定目标，候选数记为 null，另给出绑定时的候选数。
未声明此策略的局部查询、原全树观察及 `locate.structured` 保留原唯一性要求。
这条临时规则取代第十七节针对歌曲候选“多个一律拒绝”的描述；版本/专辑选择后续完善。

同一实例的命名容器引用仅用作寻址；每次新查询核对当前身份、祖先、归属和矩形，
重新读取子控件。只读容器可以有延伸出窗口的内容，输入叶子仍必须完整位于自有窗口内。
显式页面切换默认释放全部引用；只有声明 `retainContainerBindings` 时才保留容器寻址，
丢弃旧叶子观察。失败、重置与关闭仍释放所有客户端；避免重复关闭同一客户端。
256 节点、16 层、32 谓词、2000 元素和动作/租约预算均保留，无隐式全树回退。

当前环境真实回放：勇气／梁静茹 35.580 秒，随后仅换参数回放甲乙丙丁 (你我怎么两清)／
李佳薇 34.017 秒，均完成歌曲/歌手、详情页及正在播放状态核验。前者发现两个匹配并按
用户指定规则选首个，后者一个匹配。两次使用同一定位 JSON，哈希不变、未重新学习、
没有全树查询、不收藏、不接入主工程。77 条相关合成检查和页面基础启动通过，未跑完整测试。
详细证据见 `reports/ui/generic-song-review.md`。这些单次结果不构成所有歌曲或性能保证，
也不改变历史 P3 NO-GO / A5 safety FAIL 的结论。

## 二十、播放回放去重优化（revision 5）

整体播放流程不再先暂停再恢复：双击结果后保持播放，联合核对迷你播放器的准确歌曲与歌手，
打开详情，最后以一次新的局部观察核验歌手、歌名和 `pause` 按钮状态。最终核验是只读操作。
同一观察内对每个 RuntimeId 对应目标只证明一次；保留并重新评估刷新后的关联字段。
已绑定查询也保留现场核验，但不再于匹配前后重复证明同一目标。

就绪条件的证明只能由紧邻、谓词相同的断言或点击消费，中间有任何其他步骤就失效。
记录明确标记 `observationReused`，不把复用结果称为新的独立观察。操作前仍核对环境、窗口和预算。
角色投影仅省掉无关角色的详细属性读取，不跳过树节点、祖先遍历、归属、密码或预算检查。
查询计时区分 `pathRebindMs` 和 `containerReadMs`。窗口规格已正确且已渲染时，核验后直接复用。

取消暂停后，原歌曲的滚动标题会出现两个准确同名的文本副本。播放器身份核验改以稳定歌手字段为锚点，
在已学容器内明确要求 1..2 个准确标题副本、逐一核对身份；不把其中任一个任意选为唯一目标。
歌曲搜索仍按用户已指定的首个匹配规则执行，最终播放状态必须核验通过。

本轮前后实测保持“冷启动勇气、复用实例回放原歌曲”的顺序：勇气 35.580 → 25.446 秒，
原歌曲 34.017 → 21.993 秒。局部读取每轮 21 → 9 次，暂停/恢复动作 0 次；两首均通过最终独立核验，
两轮间未重新学习或改写定位 JSON。85 条相关合成检查通过，未跑完整测试、不收藏、不接入主工程。
页面展示每一步耗时，逐步对照、源记录与失败样本见 `reports/ui/optimized-playback-review.md`。
单独角色投影的提速仍为 NOT_PROVEN；目前剩余最大瓶颈是搜索结果容器的 UIA 子树读取。
