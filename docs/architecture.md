# 架构

Host 控制台 `src/app` 接收目标、显示轨迹、管理批准/暂停/接管。`src/composition` 创建 Cordis Root 和 Session 作用域，按契约注入模型、存储、Worker 和扩展；业务扩展仍由 `src/extensions` 动态登记，核心不硬编码业务。

`src/graph` 的 LangGraph 循环经过观察、决策、grounding、执行和独立验证。`src/capabilities` 与 `src/actions` 决定可用 provider、目标及风险边界；完成声明必须有独立证据。`src/runtime/model-budget.ts` 持久化调用预算，缺失用量不能假装零成本。关闭辅助模型不关闭风险门或规则完成验证。

Guest `guest/action-worker.py` 通过认证 RPC 及截图通道访问 Windows Worker。控制状态、租约、controlEpoch 和 recoveryEpoch 防止旧 Agent、人类客户端或断连前动作继续输入；`src/desktop-session` 持久化 Session、控制状态和恢复信息。原 Host/Guest 协议与核心接口保持不变。

Workflow schema、参数化、distill、匹配、回放、后置条件、版本摘要、迁移和恢复位于 `src/workflows`；SQLite trace 与 checkpoint 保存执行边界。断连后重新观察并验证，未知 dispatch 结果不能盲目重放写入。

`prompts` 是现有提示词接口。`testbench` 提供合成本地网页、Windows 测试台和独立 Oracle 旁路；Oracle 仅显式 EVAL 装配，不能向 Agent 泄漏金标准。`measurement/p9-a5` 保留只读统计、ledger、模型请求与执行身份审计，使用当前源码和合成夹具，没有旧 Git/冻结源码启动链。
