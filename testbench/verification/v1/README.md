# 合成验收夹具

scenarios 与 semantic-cases 为人工编写输入，build-verification-dataset 从它们生成 development、holdout 与 manifest。标签未获得独立裁定；留出集不用于开发调参。

PNG 由常量 RGB 像素重新生成，没有真实桌面、账户或个人 metadata。尺寸分别为 2048×1152、1536×789，用于解析/CRC/截断/覆盖边界，不能证明桌面采集或语义识别。raw-cases 的图片指纹与新素材一致。

真实评测、历史来源快照及旧 baseline 留在私有原工程。评测中的 unknown 和 not_run 必须独立报告，不作为通过。
