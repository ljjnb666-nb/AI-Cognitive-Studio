# B15 物理第 109 页｜三引擎同源 OCR 文本一致性正式评测

## 为什么这一阶段有资格做真实三路对照

此前同一页已经完成、以不可变 D: 私有回执存证的测试：

- 原生独立 **RapidOCR 3.9.2/ONNXRuntime CPU**：规范化文字 **226 字符**。
- **MinerU Basic 4.0.3**：规范化非图片文字 **105 字符**。
- **Docling Standard + RapidOCR 3.9.2**：#155 Windows 已实际 SUCCESS、**99 字符**、29 个文本对象、2 个图片对象、18,140ms。
- Docling Standard 的 layout-only 曾在关闭 OCR 时输出 0 文字对象，此次对照仅针对**已经成功启用真实 OCR 的 v4 输出**，不能偷换布局模式。

这三组数据不是真值。差异来源可能是图表文字、页内扫描噪声、布局顺序、文本漏识别、重复识别或过滤不同；**不得根据输出字符多寡直接判断哪种引擎更准**。

## v5 新增的真实同源、同页数字比较

脚本 `ebook_b15_three_engine_consensus.py` 按 #155→#154 私有来源链只读审核：

1. Audit-only 重验 Docling Standard + RapidOCR v4 真正成功、从未使用云端推理的不可变私有报告和原始 worker 文本。
2. Audit-only 重验 #149 文字序列差异回执与 #150 真实 3×3 图像区域来源，以及五书 RapidOCR 原始私有收据。
3. 以唯一 **B15 物理第 109 页** 作为交集；精确校验各版本原始书 PDF SHA、单页 PNG 及 OCR 行 SHA 和 MinerU Markdown SHA。任何篡改、重名页或跨书串页均拒绝，不进行新推理。
4. 使用相同的 Unicode NFKC + casefold + 仅保留字母数字规范化，对 Markdown 移除图片 Base64、图片链接、HTML 与标题标记后才做比较。
5. 三个 pair：RapidOCR ↔ MinerU、RapidOCR ↔ Docling Standard+RapidOCR、MinerU ↔ Docling Standard+RapidOCR。每对只输出匿名数字：
   - 各自字符数、3-gram 数量、交集个数及双方覆盖比例；
   - 对称 3-gram Dice，**不是 CER/召回率或正确率**；
   - 最长公共子序列 LCS 字符数、字符袋交集、保序差距（用于调查版面顺序差异）。
6. 只计算已有输出，**不加载 OCR 模型、不调用 GLM、不调用网络 API、不下载权重、不再切割 PDF**。
7. 新冻结 `b15_samepage_three_engine_consensus.v5.private.json` 采用 O_EXCL 首次创建，之后 audit-only **独立重算并逐字节核验**。GitHub 日志只能出现上述匿名数字；所有原始 OCR token、文段、四点坐标、Markdown、原始页、源实际 SHA 继续封闭在 D:。

## 严格的技术结论边界

- 3-gram 相似度高意味着两引擎文字更相似，不意味着它们都正确；相同幻觉也可高度一致。
- 文本规范化可能丢弃标点、分节与表格结构，故不能代表播客内容结构质量、文本排序可靠性、图表 F1 或公式 F1。
- 三路中 Docling Standard 与原生 RapidOCR 底层 OCR 引擎可能共用 RapidOCR 检测/识别模型，其差异反映布局集成、图像分辨率或调用路径，不可把这两路当成完全独立的统计票数。
- 真实 CER 必须依据独立已验证的参考文字和页面映射，不能将三个 OCR 结果的投票伪称为 ground truth。
- 若后续要评测“哪种架构最好”，在这项同源页数字对照完成后，还必须扩展到有扫描/数字文字/图表/公式的不同页和 EPUB，并同时记录耗时、内存和多模型调度成本。

验收要求：46/46 新旧 synthetic、owner-only Windows v5 真实来源数值重算、主 CI exact-head 全部 SUCCESS。以上完成之前不得报“新一轮评测正式通过”。所有 stacked Draft PR 继续 Open / Unmerged。
