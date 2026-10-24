# B15 图 1-4-16｜图例四个来源像素标记：形状候选（v8）

## 本阶段的实际问题

独立 RapidOCR 在图例 ROI 中能读到项目名称，但原草稿表明圆形符号可能缺失、实心三角可能被误转为空心三角。v7 已有冻结的四个原书像素单元，但原书图例符号的“圆形/三角、实心/空心”仍缺自动交叉分析。

## 离线 v8 方法

- 从 D: 冻结的源页 PNG、MinerU Markdown 和 v1→v7 全部来源回执重算四格与原图，并按字节核验既存 v7 JSON、PNG；原源 JPEG 不通过任何公开网络传输。
- 对每个四格源区域左侧用保守像素阈值分割紧凑连通域，近似判断圆形/三角形及中心实心/空心。无足够来源像素、边界不合法、中心不清楚时返回 **ABSTAIN**，严禁强行给出符号。
- 将结果写入 **D: 私有** `b15_legend_marker_morphology.v8.private.json` 与 `b15_legend_marker_morphology.v8.private.png`，仅展示候选标记像素框；不绘制 OCR 文字、不声称具体曲线所属。
- 另外保留此前 ChatGPT 从个人文件库图像目视读到的四种符号顺序作为 `PROVISIONAL_EXPECTED` 参考信号：实心圆、实心三角、空心圆、空心三角。**该参考与 Windows D: 冻结 JPEG 的原始字节尚未完成单独 SHA 对账**，因此同意数量只能称 `provisional_reference_shape_agreement_count_not_gold`，不能升级为 gold。
- 公开 Actions 最多可见 0–4 的来源标记分类数、与暂定视觉参考的一致数量，以及固定 `GOLD=UNVERIFIED`、`CURVE=UNVERIFIED`；任何像素图、完整 SHA、裁片坐标、OCR 字符串只存在私有文件中。

## 安全和完整性

需要 owner-only、正确 PR 分支、精确 SHA Windows Runner；不调用任何新 OCR、模型 API、云端推理或下载，不修改生产服务。v8 文件 O_EXCL 创建，后续只能完整重算 audit-only，原始 v1–v7 及上游 SHA 必须不变；来源缺失或结果偏移拒绝而非覆盖。Linux 只跑完全合成的符号与防泄漏测试。

**本 PR 是符号形状识别的候选工程，不是独立来源核准，也不能声明曲线映射/全文 CER。** 当实物样本的边界和形状无法明确时，宁可弃判。#161 继续 OPEN、生产 OCR 架构 NOT_FROZEN，所有 PR Draft/Open/Unmerged，未经用户明确授权不得合并。
