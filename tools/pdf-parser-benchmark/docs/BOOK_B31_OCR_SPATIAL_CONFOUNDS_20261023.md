# B31 离线 OCR 文本框与原始箭翼候选的空间混淆审查

日期：2026-10-23

## 已知真实基线

- 上游 Draft PR #135，准确 HEAD `4e78f2e0fc8c01efb0d94352c5648c1da47fad25`，真实 Windows owner-only 运行 `39963708147` 的 RapidOCR 3.9.2 / ONNX Runtime 1.22.1 **成功**。首次安装失败与重试详情见 #135 评论。
- RapidOCR 在 SHA 固定的 B31 PDF 第 126 物理页原始 PNG 上识别出 **50 行、1191 字符**，均已私有保存；这只是模型输出数量，不是 OCR CER 或文字正确率。此前原生 PDF 0 个可用文字块，因此**不得声称可以直接与原生文字算 CER**。
- 已存在 103 处 source-only V 形端点候选，前序像素双翼负对照得出 3 优先／84 复杂背景／16 弱连续；源页像素连通得到 32 连通模式／71 连通不足。这些都是几何复核线索，**都不能当作实际箭头的数量**。

## 本切片新增什么证据

只读取以下既存私有 D: 凭证（各自均需通过独立原 SHA/候选身份审计）：原 PDF 页图、OCR 50 个文字框、全部 103 处 V 型端点、三类翼部负对照、局部像素拓扑、先前 OCR 文字总量。

- 对每一 OCR 四边形进行四角有限数值、面积与凸性约束；使用真实四边形的内外点到边界最小距离，**不以轴对齐包围盒替代旋转文字框**。
- 对全部 103 处端点逐一标记 `OCR_BOX_INTERIOR`／`OCR_BOX_NEAR`（边界小于等于 8 像素）／`OCR_BOX_OUTSIDE`，不删除任何候选。
- 输出上述三类计数，以及与源翼部三类复核桶、源连通性三类复核桶的独立交叉表。**3 处原先较清晰候选中是否落入文字框**可由交叉表检查，但具体坐标、逐索引结果和文字仅保存在私有 D:。
- 报告并不写入 OCR 原文，记录每一候选的原序号、最近文字框序号、距离和此前状态；同时以原始 PDF 页面绘制一张**只在 D: 私有保存**的文字框/候选点叠加复核 PNG。

私有输出：
`D:\ai-cognitive-pdf-benchmark-data\semantic_gate\b31_ocr_spatial_confounds.private.json`
`D:\ai-cognitive-pdf-benchmark-data\semantic_gate\b31_ocr_spatial_confounds.private.png`

默认只读预检，`--write` 只独占创建（不能覆盖），`--audit-only` 重新从上游 50/103 源凭证计算报告并验证 OCR/source SHA、候选身份和 overlay SHA。任何残缺输出都必须拒绝继续，不自动删除现场。

## 认知边界

**OCR 文字框覆盖不代表是错误箭头；未覆盖也不能证明是真箭头。** 文字本身可能就是图节点的语义标签或指向关系的一部分，也可能被 OCR 漏掉或错框。因此三个新状态只是用于盲法优先排查，而不是字符准确率、精确率／召回率或金标准。

所有结果固定 `native_text_ground_truth_available=false`、`ocr_quality_gold=null`、`independent_graph_gold=null`、`arrow_direction_verified=false`、`certified_graph_f1=null`。不能拿 GLM 的五节点／四边反向调节 OCR 阈值。无新增付费 API、无 OCR 模型重新推理。

## CI 和隐私

沿用已稳定触发的主 `ci.yml` owner-only exact branch Windows Runner；只使用已安装的 D: 隔离 `rapidocr-3.9.2-onnx-1.22.1` Python，**不下载 wheel、不下载模型**，在脚本运行阶段禁止 HTTP/HTTPS/SOCKS 代理联网。Linux 合成测试使用仿真 OCR 框及 103 候选，检查多边形旋转、假坐标、全量候选、伪金标准、私有文件独占写入和不读 GLM 预测。

真实 Windows job 检查新增文件写入之前及之后 **17 件旧的 B15/B31 私有记录 SHA 均不变**，并只打印 OCR 框总数与三类匿名数量。原图、OCR 文字、坐标、GLM 原文、密钥和私有 SHA 均不得进入日志、PR 评论或 Actions artifacts。

所有 PR 保持 Draft/Open/Unmerged，未经用户明确批准不可合并。此前 checkout 网络重试、Node20→24 弃用告警、PySocks/NumPy 首次失败必须保留。
