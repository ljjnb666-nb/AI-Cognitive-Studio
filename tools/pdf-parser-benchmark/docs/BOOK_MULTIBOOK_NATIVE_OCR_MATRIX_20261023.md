# 2026-10-23｜正式 PDF 识别架构 Benchmark 第一批跨书实测

## 为什么从 B31 单页转向正式基线

原仓库 Manifest（`ebook-20261022.manifest.json`）已经固定 27 本电子书：**6 PDF + 21 EPUB**；其中 6 本 PDF 各有 4 个确定物理页，共 24 页，**OCR 重点页 10 页**。B31 第126物理页的 50行/1191字符以及 103 个图候选的结果均只属于**单页先导试验**。OCR 文字框中出现 100/103 个 V-tip 端点，凸显文字笔画干扰问题，不能通过堆叠 CV 阈值自行认证箭头。

本阶段第一批多书评测主动复用原有固定样本：**B03、B08、B15、B16、B29、B31**；不重新选择书籍或改变页码。

## 本切片真实执行

1. 在 owner-only Windows Runner 上，用已有 Docling 虚拟环境的 PyMuPDF 解码 6 本 SHA/大小固定的原始 PDF，并对已固定的**全部 24 页**提取原生 PDF 文本字符数、原生文字块数、内嵌图像数、绘图 path 数和旋转信息；**绝不导出源文字**。
2. 将 5 本原 Manifest 明确标记 OCR 重点页的书（B03、B08、B15、B29、B31）各选择**最小的一个** OCR 重点页，并以 PyMuPDF 1.4× 固定渲染为私有 PNG。B16 `ocr_physical_pages=[]` 是数字文本对照，不冒充 OCR 指定页。
3. 新建而不覆盖 `D:\ai-cognitive-pdf-benchmark-data\semantic_gate\multibook_matrix_20261023\`，只保留 5 张源图和 `multibook_native_24pages.private.json`，并为每张图计算 SHA-256。结果含每页内容量的**计数**，但原始文字/图像都不传 GitHub。
4. 由已经安装且实测成功的独立 D: RapidOCR 3.9.2 + ONNX Runtime 1.22.1 虚拟环境在**断网的本地 CPU**上识别上述 5 张原图，各自存储私有文字行、四边形、模型分数与每页毫秒数，另写入 `multibook_rapidocr_five_pages.private.json`。每页均可以计算**OCR 输出量与速度**，但没有真实标签时绝不宣称 CER、准确率/召回率或“哪家最好”。
5. 仅对当前 PyMuPDF/Docling Python 解释器的 `docling`、`mineru`、`pymupdf` 进行软件包版本存在性探测，不启动可能联网下载权重的 Docling/MinerU 模型。**当前解释器没装 MinerU 不代表 Windows 其他隔离环境没装**。
6. 首次运行独占 O_EXCL 创建 PNG/JSON，随后只读回验；再次运行**仅验证来源/文件 SHA**，拒绝覆盖已有私有 OCR 文本。B15 的付费视觉请求仍保持历史未知计费隔离，不会再次发给 GLM。

## 不可跨越的认证界限

- 源 PDF 的原生文字计数**不是** OCR 真值；图像扫描页可能完全没有原生文字。
- OCR 行数、字数、耗时都是实际输出量，不是 CER 或真实性证明。
- 24 页原生页结构的采集 ≠ 24 页 Docling vs MinerU 正式准确率对比；本切片是**跨书来源核验与首批 OCR 性能基线**，并非最终冠军。
- 暂无独立的图节点、连线、箭头方向人工/可信 reference；Graph F1、布局准确率、OCR CER 均保持 `null`。
- 仅核验 PDF 部分；21 本 EPUB 的段落/图片完整性评测需要独立评测切片，不冒充已覆盖。

## CI 验收契约

- Ubuntu 合成端创建 **6 份非版权 PDF**，各 4 页并按原 Manifest 风格命名，跑跨书 SHA、页数、文本统计、旋转、图像无泄漏、5 个源图复用、5 页 OCR 模拟、报告独占写入、篡改拦截、零模型调用等测试。
- Windows owner-only 同仓库准确 PR HEAD；不下载 Docling/MinerU/OCR 模型、不注入 GLM key。6 本 PDF SHA+大小门禁、真实 24 页来源结构、5 本实际 RapidOCR、既有 B15/B31 私有证据的 SHA 前后相等均是硬门禁；原书路径、内容、source SHA、OCR 结果原文不输出日志和 artifacts。只打印聚合 PDF数/页数/OCR页数/行数/字符数及软件安装状态。
- 所有 Draft PR 不合并、不修改 production parser，保留首次失败、pip retry、Actions Node.js20→24 弃用 warning。后续进入**同一批原始页面的 Docling 与 MinerU 原位运行**，确保输入、页码、资源和评价指标一致。

## 后续引擎选型路线

1. **阶段 A（本切片）**：原 PDF 24 页结构基线、5 页 RapidOCR 输出量/延迟，来源/私有不变量核验。
2. **阶段 B**：保持同样原始书/页，确定 Docling/MinerU 的真实本机可执行环境、模型来源锁定、离线运行条件；不能把 package installed 当成模型可用。
3. **阶段 C**：对布局、表格、公式、图片/图、OCR 单独建立可核验 reference，再量化 CER、表格结构指标、图节点边、完整性、运行成本。
4. **阶段 D**：据此选择文本原生、OCR、复杂排版与图形理解的有条件路由架构，而不是预先指定某个引擎为万能冠军。
