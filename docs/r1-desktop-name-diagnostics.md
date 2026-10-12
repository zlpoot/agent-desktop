# R1 Desktop 名称查询：离线诊断增量

状态：R1_BLOCKED / INCREMENTAL_REVIEW_PENDING / AWAITING_R1_RESULT_REVIEW。
本轮只有离线分析、代码及合成验证；没有第四次真实 Task、模型调用或 Windows UI 输入。

## 事实与定位限度

第三次运行源码为 `198e54ce997361f0dd527705dd87a608594e6a55`，
[独立 Review PASS](https://github.com/zlpoot/agent-desktop/pull/68#pullrequestreview-5486298999)。
Task `13c818bd-b0f6-489e-b075-e6c9630d3a3f` 的第一条原生诊断为：

```json
{"method":"start","chain":[{"type":"Blocked","site":{"file":"win32.py","function":"name","line":120}}]}
```

该行确定名称尺寸不满足 0<size<=1024，对应 desktop_name_unavailable。
旧版既没有记录 GetUserObjectInformationW 的即时 Win32 error，也没有记录传入 HANDLE 来源。
不同名称查询会到达同一行，因此不能仅从该日志判断失败是原保留 HANDLE、
helper 线程关联/恢复、Input Desktop，还是 HWND 所属线程 Desktop。
日志没有保存的信息无法离线补回；本轮未据此猜测 invalid-handle/access-denied 或删除检查。

[第三次完整脱敏结论与本地证据入口](https://github.com/zlpoot/agent-desktop/issues/51#issuecomment-6117334017)。
完整自有证据保留在受审查 worktree 的 .artifacts/r1-attempt-3/。
历史实际 DeepSeek calls/tokens/unreportedCalls=0/0/0，费用0、辅助0、输入0、
Trace6事件、Candidate0，未进入业务独立 Verifier；不改称自主 UAT PASS。

## 最小诊断变更

spikes/local-workspace/win32.py：

- name(handle, source) 保持原有尺寸预算及成功/拒绝条件。
  尺寸探测与名称读取前分别清零 last-error，调用后立即捕获数值。
  零缓冲尺寸探测返回 FALSE 是正常路径，取得合规尺寸后仍继续读取；
  不把预期 ERROR_INSUFFICIENT_BUFFER 当成执行失败。
- thread_desktop(tid, source) 先捕获 GetThreadDesktop 的获取错误。
  NULL 时立即拒绝，避免将 NULL 传入名称查询而丢失第一处错误。
  非空借用 HANDLE 原样返回，不额外关闭或替换。
- Input Desktop 名称和窗口所属线程 Desktop 名称提供固定来源标签。
  HWND存活、原PID/Job/session/输入Desktop及权限检查不变。

src/desktop-provider/testbench_worker.py：

- 原 Desktop 及 helper 线程关联/恢复名称查询附带固定标签。
- failure_diagnostic 只允许来源、操作、阶段的固定枚举，
  uint32 Win32 error/requiredBytes 和 handlePresent 布尔值。
  不输出 HANDLE/TID/PID 的数值、Desktop 名称、异常 message、完整路径、
  请求、凭据或任意附加 metadata。原最多3层异常链和隐式 context 规则不变。
- 不改 Guest 协议、公共能力、Graph、Verifier、Workflow schema、allowlist、预算或 Registry fence。

| source | HANDLE 来源/具体查询 |
| --- | --- |
| original-retained | NativeBench 保留的 CreateDesktopW 原 HANDLE，关联前名称验证 |
| controller-before-bind | helper 当前线程 GetThreadDesktop，关联前 Default 验证 |
| controller-bound | SetThreadDesktop 后 helper 当前线程 GetThreadDesktop，原名称验证 |
| controller-restored | finally 恢复后 helper 当前线程 GetThreadDesktop，Default 验证 |
| input-desktop | OpenInputDesktop(0, False, READOBJECTS) 返回的查询 HANDLE |
| window-owner-thread | GetWindowThreadProcessId 得到的 HWND 所属线程 GetThreadDesktop |
| unspecified | 共享 Api 的其他既有调用者；不接受自由文本来源 |

operation 区分 GetThreadDesktop 与 GetUserObjectInformationW；
phase 区分 handle-lookup / size-probe / name-read。
handlePresent 只报告是否非空，不能证明 HANDLE 有效；winerror=0 只表示该失败没有返回非零错误码，
不能被解释为成功。requiredBytes 不改变1024字节预算。

下面仅是合成 NULL HWND线程 Desktop 测试产生的诊断字段，**不是第三次真实运行的新证据**：

```json
{"source":"window-owner-thread","operation":"GetThreadDesktop","phase":"handle-lookup","winerror":87,"handlePresent":false}
```

微软契约：[GetThreadDesktop](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getthreaddesktop)、
[GetUserObjectInformationW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getuserobjectinformationw)。
前者 NULL 失败应立即读取 GetLastError，借用 HANDLE 不要求 CloseDesktop；
后者尺寸不足返回 FALSE、所需字节在输出参数，失败错误通过 GetLastError 获取。
这些契约支持诊断设计，不能替代本机失败调用点的实际证据。

## 定向验证与交付边界

- npm run check PASS。
- python tests/testbench_workspace_test.py -v：31/31 PASS。
  新增9项合成测试覆盖 NULL获取首错、无效/拒绝/错误码0、预期尺寸探测、
  名称读取首错、尺寸超预算、Input Desktop关闭、实际Api.identity来源、
  脱敏metadata白名单、helper关联前/后/恢复来源和Default恢复。
  其中既有3项本机内置SQLite console fence测试没有Desktop/App UI或输入。
- node --import tsx --test tests/testbench-workspace.test.ts：13/13 PASS，
  使用FakeRuntime/ReactiveModel，不调用真实模型。
- python -m unittest discover -s spikes/local-workspace/tests -v：56/56 PASS，共享D0离线契约。
- git diff --check PASS。不涉及网页，不重复全量CI；不升级依赖、不提交生成资产。

根因仍未确认，本轮没有针对某个假设扩大执行修复。
诊断增量交原 Draft PR #68 等 ChatGPT 独立增量 Review。
R1真实Task授权已用完，Review通过不自动授权第四次任务。
不合并、不关闭Issue、不发布、不晋级Workflow verified；
历史A5 safety FAIL / Windows PAUSED / overall INCOMPLETE保持。
