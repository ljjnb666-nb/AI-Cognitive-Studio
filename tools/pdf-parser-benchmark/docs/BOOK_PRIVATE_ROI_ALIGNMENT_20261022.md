# 2026-10-22｜私有版面区域与图表视觉参考的空间对齐门禁

该工具把 Docling 输出的 picture provenance bbox 规范化到左上原点、[0,1] 页面坐标，允许与 D 盘私有 L2 参考 ROI 比较。不可将区域重叠视为图表语义正确率。

输入：现有 B15/B31 私有参考 JSON 的 `regions`，以及同页 Docling 图片框。来源文件 SHA-256、匿名书籍 ID、物理页必须完全一致。
规则：IoU >= 0.10 且参考 ROI 覆盖 >= 0.20 时可视为空间候选。采用最大基数的单独一对一匹配（增广路径、候选边按 IoU 降序与稳定编号排序），先保证可匹配数量不被贪心策略低估；算法**不保证同一最大匹配数下的 IoU 总和最优**。结果仅为 L2 暂定空间一致性，既不是人工真值召回率，也不是图表关系/箭头语义准确率。已加入歧义重叠造成旧算法漏匹配的纯合成回归。
严格拒绝无效坐标、非有限数、未知 TOPLEFT/BOTTOMLEFT 原点、跨文档 SHA、不属于当前页的 Docling provenance，以及 humanVerified/graphVerified 越权字段。

Docling Windows 实书报告新增长度受限的 `private_picture_boxes_normalized`，全部保留在 D 盘 `reports/*.private.json`，Actions 日志只读已批准的匿名版面数量，不输出具体 ROI/框、书本原文或图像。
仅当 D 盘存在 `semantic_gate/B15_B31_roi_candidates.private.json` 私有参考时，Windows 工具才自动执行区域对齐；参考不存在时输出 PRIVATE_REFERENCE_UNAVAILABLE，不产生错误的零命中率或已验收结论。
本会话云沙盒中的私有 L2 文件不会被上传到公开仓库，也不能默认假设在 Windows 自托管 Runner 中存在。因此此轮实际任务重点是规范化的图片框采集及可选私有对齐门禁。

生产解析器、CAS、humanVerified、graphVerified 均不修改。无论结果如何，graph_semantics=UNVERIFIED、human_verified=false、graph_verified=false、certified_graph_f1=null。
真实 ROI 的像素坐标与页物理旋转必须同源；在缺少旋转和尺度一致性证据时不得以粗略重叠冒充语义理解。
