# #97 Phase A：Task-owned 网易云动态 Agent 接线

状态：`PHASE_A_CODE_REVIEW_PENDING / MVP_PRODUCT_BLOCKED / LIVE_NOTRUN`。v0.2 发布暂停。

起点是 main@`dc125adaf2a3d0efa037b82f83134d01c7398ead`。本切片接通现有正常 Dashboard/Task Controller/Agent Loop 与 Task-owned D0 Workspace 的动态搜索；没有实现或验证真实收藏闭环。合成测试结果不表示网易云产品任务已通过。

## 实际调用链

1. 普通 `npm run dashboard` 继续使用 `start.ts` 和 `createRootAssembly`。操作者配置中的 `localWorkspace` 显式选择 `{ app: "netease", path: "<操作者核对的 cloudmusic.exe 绝对路径>", taskMode: "agent" }`；此配置不携带固定曲目。配置默认缺失，当前 RC 4194/4195 服务没有加载此分支或此配置。
2. 用户在同一工作台明确选择 `windows-local-workspace / local-workspace:netease`，输入自然语言并提交通用 Task。`TaskDesktopSessions.acquire` 调用既有 `Provider.open`，由 Task 自己创建并拥有 D0 Desktop/Job/网易云实例。无需先点 app-only 的“打开应用”，也不消费 P7 启动 receipt 或声明 `appTrustFence`。
3. 后端沿用签名/产品、无已有网易云进程、版本 `3.1.40.205461`、唯一自有 OrpheusBrowserHost 窗口、Job/Session/Desktop、安装路径、owner/epoch 和租约检查。Task 模式另读自有进程 token，要求未提升 Medium，不能把启动器权限推断为目标权限。
4. 既有 `InputControl.beginTask` 获取 Task 的 Agent grant；`LocalWorkspaceTaskExecutor.connectRuntime` 返回 `WorkerClient` 适配器。规划器得到实际受控窗口，`attach` 只能匹配该窗口，`ensureApp` 返回同一已启动实例，不二次 launch。读取窗口不激活 Default，不伪造 foreground。
5. 现有 `createAgentLoop` / `StageWorkflowModel` 完成 observe → decide → ground → resolve → risk → execute → verify。模型逐步决定查询文本、搜索按钮和单曲标签动作。Native Task 模式没有自行规划/启动固定歌曲脚本。
6. 执行器仅允许唯一 role/name 目标。输入前重新观察；D0 私有 bridge 将本次 token 中的 UIA RuntimeId/role/name/auto_id/class/rect 送给同一个 OS worker。worker 再观察并核对目标，不采信模型给出的坐标或身份；每条 HWND 消息保留身份/owner/epoch/租约/原观察期限检查。
7. `Controller.task_action` 等待原 worker 的结果，队列 ACK 不作为完成证据。未知或超时结果使 Session 失效并停止自有资源，不重放该动作。UIA 原始 RuntimeId 与搜索输入框 ValuePattern value 被交给已有独立验证器；查询输入和搜索结果是两个不同证据对象，输入框出现曲名不能证明结果列表已显示。
8. 结束时撤销输入并排空、关闭 Runtime 和自有 Session。Root 保存 `desktop_task_cleanup_done/error`；错误保持失败/恢复不确定/输入资源阻断。Dashboard 的清理字段读取这一事件，与业务验证和人工核对分别展示。

连接器通过可选的私有 executor `taskCoverage` 端口声明当前完整任务契约未闭合。Controller 与原有契约审计合并这个否定结论，保留文件要求，不允许模型把搜索结果条件升级为收藏成功。即使某个搜索阶段独立通过，最终仍等待人工结果核对；合成测试故意给出仅搜索条件的“搜索并收藏”计划，确认不能自动 done。此端口只可声明缺口，不能覆盖或抹掉原审计的失败；Task/Workflow 持久 schema 与 Host/Guest 消息没有变化。

## 当前允许的动作和保留边界

- 动态搜索文本输入（单个唯一搜索 Edit、空框才输入）、`search` 按钮、`单曲` 标签；不硬编码歌曲或歌手。不是任意应用控制。
- 收藏 `set_checked(true)` 在原生能力缺失时拒绝发送。适配器有“新观察确证已经 true → no-op”的防重复分支，其防御行为只由合成输入覆盖；当前 Native UIA 采集没有收藏状态，不能宣称真实“已收藏”识别成功。
- 坐标、视觉坐标兜底、双击播放、剪贴板、全局输入、RAW、任意 keypress、其它控件和取消收藏均未开放。Viewer 登录接管也没有由此切片开放；Task 模式的 semantic input/humanTakeover/resumable 明确保留 not-proven，不继承旧场景的支持声明。
- 旧固定歌曲配置继续走旧 D0 场景。`taskMode: agent` 不发布有限场景目录，Host 和 OS worker 都拒绝固定 script；普通配置不自动升级为通用 Task。
- Workbench Apps 的 app-only 60 秒入口不变。Task-owned 路径也暂时保留 D0 的 60 秒总期限、3 秒租约、2 秒观察有效期；本 PR 没有放大生命周期或模型预算。
- 当前 Task 在 waiting_user/paused 的正常 finish 会关闭自有 Session；旧绑定不能被另一新实例替代。因此登录→人工接管→继续还未闭合，不能声称具备这一产品流。
- Host/Guest 协议、Workflow schema、核心 Graph、固定场景、Browser、依赖版本和默认辅助模型 off 未改变。#68 未合并；#29 的 P7 跨实例可信桥没有被冒充为完成。

## 收藏证据缺口与下一步最小探测

现有 `Uia.observe` / `NETEASE_ROLES` 没有收藏控件 Toggle/Selection 状态；Task 模式也只增加真实 RuntimeId 与搜索 value。`task-planner.ts` 对 `structuredStates` 的 UIA 来源目前只接受 text/value，尚不接受 checked。歌名、窗口标题、图标文字、搜索完成或输入 ACK 都无法证明账号侧收藏状态。

取得 Owner 的单独实机只读探测授权后，最小方案是：

1. 在准确版本、本次 Task-owned Job/Desktop/原 HWND 中，由 Owner 选择自己的账号并自行处理登录。探测不接收密码，不调用模型，不发送收藏输入。
2. Owner 手动定位两首不同歌曲；只读采集歌曲/歌手与收藏控件的原生 RuntimeId、层级归属、TogglePattern/Selection/Legacy 状态和字段可用性。原始账号画面/配置不上传。
3. Owner 自己改变收藏状态，核对原生 true/false 的读回差异、刷新后持久化、曲目绑定和多候选行为。缺失/不完整/无法绑定曲目的状态记录 UNKNOWN，不从模型或图标推测。
4. 有足够证据后再单独实现并 Review：只设置 true 的受限效果；已 true 不切换；未知效果拒绝重试；独立新观察及持久化验证。若没有可读状态，继续 BLOCKED/等待人工。

还需补齐结果行的动态歌曲+歌手确切匹配、收藏控件关联、非空搜索框的受控查询替换、登录接管/恢复、适合模型任务的单独生命周期方案，以及 Owner 授权的两条不同自然语言真实收藏任务。以上未完成前保持 `MVP_PRODUCT_BLOCKED`，不发布 v0.2。

## 合成验证与审阅

新增 TS 定向测试覆盖正常 Controller → Provider → Agent Loop 的两组曲目参数；多候选/坐标零派发；窗口绑定、版本漂移、失去输入权、未知效果、收藏 true/false/UNKNOWN 及 cleanup 未确认。Python 使用 Mock API/UIA/Controller，覆盖同 worker 动态输入、UIA 身份变化、epoch/观察期限、重复动作、未知效果和 bridge token 消费。新增 Browser 用例只读取合成 Trace，确认 cleanup PASS/FAIL 与业务/人工结果分离。

完整命令和最终计数以本 PR exact HEAD 的验证记录为准：`npm run check`、`npm run test:offline`、`npm run test:python`、`npm run test:browser`，另跑 D0 合成回归。已知 #45 两项下载 canceled 不能改写为 Browser 全绿。Native 模式、真实网易云/账号、付费模型、收藏、Tag/Release 均未验收。

最终源码检查：check PASS；offline **1023/1023 PASS**；Python **216/216、20 个契约文件 PASS**；D0 合成 **57/57 PASS**；Browser **105/107，2 FAIL**（`desktop-selection-ui.test.ts` 的 `download.createReadStream: canceled`、`workflow-library.test.ts` 的 `download.saveAs: canceled`，#45 已知项）。新增 Task 清理 API/页面用例通过。首轮 offline 1022/1023 的旧“未准备”错误语义回归已修复，原断言未放宽；首轮 Python 的严格观察时限用例因 `workspace_frame_stale` 失败，原期限未放宽，最终整组重跑通过。查询字段被误当作搜索结果及缺少结构化证据 stamp 的接线问题均在定向测试中修正；最终两组“搜索并收藏”的合成 Task 都保持 paused/UNKNOWN，不能自动 done。

无副作用审阅步骤：从配置检查默认关闭与互斥模式；从 Task 提交追到原 Session/输入权和 WorkerClient；检查 Native 每次效果的 token/RuntimeId/owner/epoch/期限；检查收藏状态缺失零派发与无固定 script；检查清理事件失败及 UI UNKNOWN/人工未核对。审阅期间无需启动任何真实应用或提交模型任务。

历史 `A5 safety FAIL / Windows PAUSED / overall INCOMPLETE` 保持。停止在独立 Draft PR 的 exact-HEAD Review，不自动合并、不启动 U11、不关闭主任务。
