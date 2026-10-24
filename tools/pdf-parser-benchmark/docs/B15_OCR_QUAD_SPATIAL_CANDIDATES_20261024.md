# B15 p109 图 1-4-16：RapidOCR 四点框与图像 ROI 候选的空间关联（v5）

## 上游证据来源

- v1（#165）：B15 物理第 109 页图 1-4-16；两张 MinerU 嵌入图像和 19 条 RapidOCR 同页阅读顺序候选，源 PDF / 原渲染 PNG / Markdown / RapidOCR 行 SHA 固定。v1 未完成像素图像配准与图例语义证实。
- v3（#168）：原页 PNG 上多尺度/旋转模板候选，最多 6 个；独立冻结，真实 Windows 与主 CI 已通过。
- v4（#169）：ORB+RANSAC 独立算法验证候选位置；私有 v4 JSON 与 PNG 可视化，两种算法交叉信号，不等于几何或语义的独立 gold。

## 本切片

新 v5 严格核对 v1、v3、v4 的来源 SHA、固定 book/page/figure、冻结 JSON 字节、v4 overlay PNG 的 SHA 和全部未核准 authority flags，然后从 v1 19 条原始 RapidOCR 四点框计算与 v3 最高 ROI 候选（以及 v4 ORB 候选）的空间重叠比例，输出三种**几何候选状态**：

- MOSTLY_WITHIN_UNVERIFIED_ROI：OCR 行包围框超过等于 80% 落在候选 ROI。
- PARTIALLY_INTERSECTS_UNVERIFIED_ROI：有交集但不到 80%。
- OUTSIDE_UNVERIFIED_ROI：没有空间交集。

每行保留原文、四点框、位置和备用 ROI 交集供 D: 私有审核；不公开原文或完整坐标。另创建独立的 v5 原图叠加 PNG，以 R1–R19 标号绘制文字四边形及候选区域，不把识别文本写到图片。

**这些分类只代表包围框与未经独立审核的 ROI 候选的 AABB 几何关系，不等于文本真实属于图表，更不能自动定为图题、图例、标记或曲线标签。** 两种图像算法同源，尚未建立独立标准参考。RapidOCR 四点框由固定 SHA 的原 PNG 直接解码输入，不额外做 OCR，但像素框架一致性仍需独立原图验证。

## 保密、幂等与可追溯性

- 输入只读取 D: 目录，v1/v3/v4 及其叠加图都不会覆写；v5 JSON/PNG 使用 O_EXCL 成对首创，之后每次 audit-only 重算并做字节级比较。
- 私有文字、区域坐标、图片、完整 SHA **不进入公有 GitHub、Actions 日志、Artifact 或 PR 评论**。Runner 只打印固定状态及 19 条总数。
- SHA 不匹配、伪造 gold、缺失页框、越界/退化四点框、重复行号、损坏源图/回执、部分输出直接拒绝，未知异常不输出 Traceback。
- 不执行 OCR 模型、云视觉调用或权重下载，不改生产解析路径，不冻结识别架构。

## 最终界限

本 PR 不计算真实 CER，不宣称 ROI、图例、符号、曲线一一匹配通过。下一步仍需独立原图文字/符号核对与真实图表结构评测；Issue #161 保持 OPEN。保持 Draft/Open/Unmerged，未经用户授权不合并。
