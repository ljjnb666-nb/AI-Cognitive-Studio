# AI Cognitive Studio｜B15 物理第 109 页 OCR 分歧诊断协议

**前置结果**：已核验 #145 Windows 同页真实 RapidOCR 与 MinerU Basic ONNX 文字一致性。B15 规范化 RapidOCR 为 226 字符、MinerU 为 105 字符，三字符片段 Dice 为 0.605505；其他四页约 0.95～0.98。这是**分歧程度**，不是哪款引擎准确率高的证据。

## 本阶段目标

只利用旧 D: 私有五书 OCR 回执与 MinerU Markdown，分析 B15 的文字分歧是**集中在少数 OCR 行**还是广泛分布，输出检查优先级；不做第二次模型推理、不使用任何云端模型、不上传图片/原文、不制造独立金标准。

脚本：`tools/pdf-parser-benchmark/scripts/ebook_b15_disagreement_triage.py`。

### 输入身份门禁

1. 首先只读重新计算并审核已有 `fivebook_rapidocr_mineru_text_consensus.private.json`，确保 #145 全五书同物理页证据一致、报告未被篡改。
2. 使用 B15 原 PDF 第 109 物理页的 RapidOCR 行级回执，核对行级证据 SHA 与同源单页 PDF SHA。
3. 读取 B15 已存在的私有 MinerU Basic Markdown，核对 SHA；调用 #145 的相同图片剔除与文本 NFKC/大小写/字母数字规范。Base64 图像字节不能当 OCR 字符。
4. 对每条 RapidOCR 行，计算行内 3 字符多重集合在 MinerU 整页中存在的**可能匹配比例**，按 EMPTY/TOO_SHORT/ZERO/LOW/MEDIUM/HIGH 分类，再按行序号分四区统计。重复短语可能在多行重复计为“可能匹配”，**不可相加形成全页召回率**。
5. 缺失原页、错误 SHA、行数不一致、重复写入和报告篡改一律拒绝。数值只用于诊断来源差异，绝不推断哪套引擎漏字或 OCR 质量。

### 私有输出与验收

`D:\ai-cognitive-pdf-benchmark-data\semantic_gate\multibook_matrix_20261023\b15_samepage_ocr_disagreement_triage.private.json`

- 第一次 `--write` O_EXCL 独占生成；再次用 `--audit-only` 重算对账；既存报告不能覆盖。
- 报告仅含原页身份、私有 SHA、数值统计和按行索引划分的**匿名元数据**。**不存** OCR 原文字、识别出来的词、三字符片段、截图、坐标或图片 Base64。GitHub 标准 CI 只跑完全合成的数据。
- Windows owner-only 只读旧 SHA 固定来源、写一次私有诊断报告，真实运行后核对源 OCR/Markdown 没有变化。
- CLI 输出仅样本 ID/页码、行数、区间计数以及 `ROOT_CAUSE=UNVERIFIED`、`ACCURACY=UNVERIFIED`。
- 合成测试覆盖空行/短行/全匹配/低匹配、元数据泄露、SHA 篡改、错物理页、重复写入和回执改写。

### 诊断之后应该怎么做

如果 B15 的低支持行高度集中，优先在**本地私有原始页面**核对相应文字框、扫描区域、插图/表格布局与 Markdown 结构；如果普遍偏低，则继续检查 MinerU 的读取顺序、图片折叠、版面和文本流。任何“MinerU 漏字、RapidOCR 更准确”之类的判断，都必须有与两者独立的来源证据；不能将二者的相似度分数当作 CER。

已知遗留：#146 已证明五页均无通过验收的独立 reference；#147 快照版本化尚需完整验收；Docling Standard 尚未进入同源公平比较。**本阶段不合并任何 stacked Draft PR**。
