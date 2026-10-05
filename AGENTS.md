# Agent Desktop

保持核心契约、Host/Guest 协议和 Workflow schema。保留 guest、prompts、testbench 布局；不借整理改框架、升级依赖或放宽安全/预算边界。

运行 `npm run check`、`npm run test:offline`、`npm run test:python`；涉及网页再运行 `npm run test:browser`。用合成数据及 FakeModel/FakeRuntime，不导入私有快照、密钥、数据库和浏览器状态。

真实模型、第三方站点、VM 或实机输入须显式授权和配置。默认辅助模型关闭，独立完成验证、风险门、预算、输入控制必须保留。Windows 实验暂停，A5 safety FAIL 和整体未完成不得改写成通过。

提交采用逐文件审查和显式暂存；不提交生成资产或凭证。本候选没有选许可证，不 push 或更改仓库可见性，除非用户另行明确授权。
