# 五本真实电子书｜RapidOCR 与 MinerU 文字一致性评测（2026-10-24）

## 本阶段工作

继 PR #144 的五书真实 Basic ONNX 与 RapidOCR 同源运行成功之后，本阶段比较**两种解析器的文字输出**，而不仅是 PDF 能否跑通或 Markdown 文件有多大。

准确来源：固定 Manifest `ACS-EBOOK-20261022-A` 的 B03 物理67、B08 物理64、B15 物理109、B29 物理72、B31 物理126。沿用 #144 已经 SHA 固定的五本各一个 OCR 焦点页，绝不选新页、重新运行模型或重发历史 B15/B31 云端视觉请求。

## 对齐的输入和指标

1. 首先只读审计原书 SHA、24 个已裁切单页 PDF、五本真实 RapidOCR/OCR 坐标私有回执、四本新增 MinerU Basic 成功报告、B31 已成功报告、图片负载拆分及总五书同源汇总。不对齐来源就不比较。
2. 只在本地 D: 内将 RapidOCR 每行的原始文字按识别顺序拼接；同时从 MinerU Markdown 中**移除所有可识别的图片 Data URI、Markdown/HTML 图片标记、图片引用、HTML 标签、链接地址**，再进行 Unicode NFKC 归一化、大小写折叠，并只保留字母与数字用于比较。归一化视图可能包含公式/表格词元，不声称完整消除所有 Markdown 杂质。
3. 对同页的归一化字符序列计算**三字符连续片段的重合多重集合**（trigram multiset），分别报告 RapidOCR 的片段中被 MinerU 也输出的比例、MinerU 被 RapidOCR 覆盖的比例，以及对称 Dice 系数；保留双方清洗后字符量和空输出状况。重复出现的相同短句按出现次数计量，避免仅按词集合夸大一致性。
4. 若某引擎为空，系数为 0 或 null，绝不将两个空结果评定为满分；各引擎的阅读顺序可能不同，因此**低一致性只代表差异，绝不能直接解释为哪边更正确**。
5. 每页保留来源单页 PDF SHA、MinerU Markdown SHA、RapidOCR 行级原始报告 SHA，全部只存在 D: 私有 JSON。GitHub 仅输出 B03/B08/B15/B29/B31 匿名样本 ID、物理页、两个归一化长度和数值系数，**不输出任何书页文字、语音、个人路径、坐标、Base64、内容片段、文件 SHA 或模型调用**。
6. 新私有 `D:\ai-cognitive-pdf-benchmark-data\semantic_gate\multibook_matrix_20261023\fivebook_rapidocr_mineru_text_consensus.private.json` 使用 O_EXCL 首次写入、二次重算对账。既有原 PDF/24单页/5原图/全部 RapidOCR/MinerU 输出以及历史两次失败日志严格执行前后 SHA 不变。
7. 本阶段**零新模型推理、零模型下载、零付费 provider**。并非在没有真值的情况下人为认证一套 OCR 为金标准。

## 如何理解结果

- 这些分数衡量**两种模型对同一图片文字的语法一致性/分歧**，不是 CER、WER、识别准确率、文字覆盖真值、公式准确率、表格结构 F1、图节点和有向边 Graph F1。两种模型即使输出完全相同，也可能都识别错。
- 原先 MinerU 五书 Markdown 总 373668 字符中 370980 字符属于可识别图片编码数据（约 99.3%），必须剔除后才能尝试比较文字。
- NFKC 会合并全角半角，删除标点与空白以减弱排版和阅读顺序干扰，但本阶段并未证明 OCR 内容真实。公式/表格评估需要独立 reference。
- 等识别差异归因出来之后，再挑选具有独立来源文本或可复核标注的样本形成 OCR CER 的真实金标准，并将文本路由、扫描 OCR、表格/公式、图片/图结构分别建模。Docling Standard 仍须准备并核验完整离线模型，不拿 NativePdfPipeline 冒充 AI 解析。

## 验收

- Ubuntu 使用合成 Markdown 含大量图片 Base64、NFKC 字符、故意空输出、错页、篡改报告和假 CER 证明会被拒绝；兼跑上游五书 synthetic。
- Windows owner-only exact-head job 无额外模型调用；检查历史全部 Markdown、OCR 报告、24 PDF、源 PNG 和两次失败日志的 SHA。
- 保留 #137 Ubuntu 安装失败，#139 正则误报首次失败，#140 原 MinerU DocLib 两次真失败，Node20→24 warning；完整 CI 未完成前绝不宣称通过。
- 所有 Draft PR Open/Unmerged，未经用户明确授权不合并，不上传私有电子书或任何输出原文。
