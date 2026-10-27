# Stage1 v24：B08 透印来源追查（源 PDF 相邻物理页）

基于 v17 SHA 固定的 B08 物理第 64 页完整图像，单次读取原书 PDF 并验证原书大小、SHA256、物理总页数及 v17 PNG 字节哈希。仅在 Windows D: 私有目录生成 PDF 物理页 **63、65** 的来源原图，搭配原始第 **64** 页按正向及镜像排列的离线 HTML。

不调用 OCR、MinerU、Docling 或云视觉模型。图像、来源全文、精确 SHA 不写入 GitHub 仓库、Actions 日志或 Artifact；CI 仅输出固定状态和页数。

**重要的判别限制**：PDF 相邻物理页不必然对应当前纸张的背面；镜像文字外观近似不构成准确归属证明。v24 只提供可供目视检查的邻页证据，`bleedthrough_classification=UNDETERMINED`、`reference_gold_approved=false`、`full_page_cer=null`。不能无来源地将淡色文字放入正面正文，也不能未经核验宣称其来自背面。

私有 Windows 位置：

- D:\ai-cognitive-pdf-benchmark-data\semantic_gate\multibook_matrix_20261023\b08_adjacent_source_review_v24\B08_疑似透印相邻原页镜像审阅.private.html
- D:\ai-cognitive-pdf-benchmark-data\private-review-handoff\ACS_B08_p63_p64_p65_相邻原页_v24.private.zip

严格采用新的 D: 目录，禁止覆盖 v17、原 PDF、历史 OCR 及用户数据。初次创建 O_EXCL/暂存目录原子替换；重复执行逐字节重新渲染与审计；修改与缺失一律 fail-closed。分支和 workflow 限定仓库拥有者及预期 HEAD；不做生产开关、不合并 PR。

正式五书独立 Gold 仍为 0/5，CER 未计算，Issue #161 OPEN，生产解析主备引擎 NOT_FROZEN。
