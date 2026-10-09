# Agent Desktop v0.1 · 控制台源码版 Release Notes（草稿）

**尚未发布。** 当前为 `OWNER_UI_UAT_PASS / RELEASE_PREPARATION_NEEDED / TAG_NOT_CREATED / RELEASE_NOT_CREATED`，发布准备候选等待 ChatGPT 独立 Review。Tag/Release `v0.1` 仍需 Owner 单独明确授权。

第一版是可在本地运行的 Agent Desktop 控制台源码版本，需要 Node/Python 环境及仓库依赖，按 [README](../README.md) 运行 `npm run dashboard`。没有正式 Windows 安装包或打包系统；通用无人值守产品能力尚未证明。仓库尚未选择许可证，来源与授权边界不因版本号改变。

## 已支持与验收范围

- UI-01 五区页面：工作台、任务、工作流、环境与应用、设置；统一导航、旧 Hash/Task 深链接、响应式布局与实际后端状态呈现。
- 工作台显示四种模式的产品入口、显式环境/目标选择与准入原因；仅已有受限场景在配置和授权满足时可提交。未接通模式不会因 UI 选择而获得执行权限。
- 已有 Task 可以查看步骤证据、执行回执、独立验证、清理与人工反馈，区分 Guest/Browser 归属及 UNKNOWN；已有 Workflow 支持候选/已验证/退役、固定版本与只读预览。
- 环境与应用区分能力声明、Session/目标准入、应用发现/确认/历史启动验证/业务能力；设置区分实际生效项和待接入项。
- Owner 在 `main@c4885c7bd6a0e91ee961a570193a22d39a8bbf2c` 完成 [E2 五区人工页面验收](https://github.com/zlpoot/agent-desktop/issues/49#issuecomment-6080617594)，均为 PASS。这确认页面与已有受限能力的体验，不新增真实执行或回放证明。

## 尚未接通或尚未证明

- 稳定/自主/学习/优化的完整多模式后台未完成；四种入口不能等同于四种策略均可执行。
- 任意应用、完整虚拟电脑、通用无人值守任务与通用 Workflow 回放尚未证明；环境类型不能推导应用/Session 的输入能力。
- Hidden Chrome 15 步 Workflow 是 candidate，仍未回放、不允许通用回放、未晋升 verified。只读查看/预览不产生 Task 或副作用。
- 未接通的模型/主题等设置保持规划说明或禁用；可操作配置以现有后端实际支持为准。
- 历史 **`A5 safety FAIL / Windows PAUSED / overall INCOMPLETE`** 保留。Owner UI PASS、合成回归或有限场景结果均不能推翻整体安全结论。

## 已知问题与后续 UI 改进

- Owner 建议学习/优化入口灰化；现有选项可查看，但缺少后端支持时禁止提交并解释原因，本轮只记录建议。
- 16 个内层执行步骤聚合成一个外层步骤，人工复核颗粒度不足；后续改善内层证据呈现，本轮不改变历史步骤/结果或执行器。
- [#45](https://github.com/zlpoot/agent-desktop/issues/45) 保留两项 Browser 下载失败：合成问题记录 `download.createReadStream: canceled`，Workflow 报告 `download.saveAs: canceled`。前者曾在未修改基线复现，后者未完成基线归因；不能合并原因或宣称完整 Browser 全绿。

## 发布来源与最后门禁

页面验收基线是上述 `c4885c7…`，**最终 release commit SHA 待确定**。发布准备 PR 独立审查合并后，回读 main 的精确 SHA、核对无未审查代码变更、记录必要检查结果，随后等 Owner 单独授权 Tag/Release。当前页面“v0.1 预发布 · 源码版”表示候选版本，不表示已创建 Tag/Release。

本轮不上传本地历史 DB、截图、Key、Chrome profile、输出原文或发布资产；默认辅助模型关闭，独立完成验证、风险门、预算、输入控制、Host/Guest 协议与 Workflow schema 保留。#49 保持 OPEN，#51 LIVE-02 及新 Key/真实 Task/Workflow 回放未启动。

发布条件和顺序以 [#50 Release Gate](https://github.com/zlpoot/agent-desktop/issues/50) 及其[发布前核对](https://github.com/zlpoot/agent-desktop/issues/50#issuecomment-6080664096) 为准。
