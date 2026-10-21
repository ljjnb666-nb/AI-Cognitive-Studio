# ACS 电子书工具选型 Benchmark：首轮真实基线（2026-10-22）

## 证据级别与结论

**阶段：工具选型 A/B 的实际输入盘点和 CPU 基线已执行；并非 Docling/MinerU/Marker/PaddleOCR 全工具横评通过。**

原始材料来自用户提供的单个电子书 ZIP（原始书籍没有提交 GitHub）。所有自动化选样以原文件 SHA-256 为准，`corpus/ebook-20261022.manifest.json` 仅收录元数据、物理页码，不存储书名、正文、书页图片及 OCR 文本。仓库经实时 GitHub API 核验为 **Public**。

本轮检索了 36 个输入文件：PDF 6、EPUB 21、MOBI 4、AZW3 4、PRC 1。按照既定产品一期 PDF/EPUB 范围，正式记录 27 份 PDF/EPUB；其余 9 份保留为后续格式拓展测试，**不计入本轮成功率**。

### 最值得注意的发现

- 6 本 PDF 的分散七页抽样检查中，5 本抽样页均 **没有可提取的文字层**，仅 1 本有原生文字。这是 PDF 文档属性，不是已证实的 OCR 失败或准确率。
- 每本 PDF 自动选 4 个 1-based 文件物理页，共 24 页，分别执行 PyMuPDF、pypdf、pdfplumber、Poppler `pdftotext -layout`。
- 对 5 本扫描型 PDF 各选 2 页，使用本地 Tesseract 5 / `chi_sim+eng` OCR，共 10 页。
- 对 21 本 EPUB 根据 OPF spine 顺序读取 XHTML，并解析引用完整性。
- 总执行记录 **127**，执行异常 **0**。EPUB 解析取得 **974 个 spine HTML 章节项、0 个缺失路径引用**。这不等于章节正确性由人类逐章验证。

| 已实测组件 | 页/书/次 | 中位耗时 | P90 耗时 | 作用与限制 |
|---|---:|---:|---:|---|
| PyMuPDF | 24 页 | 0.13 ms | 1.17 ms | PDF 文本层抽取 |
| pypdf | 24 页 | 0.83 ms | 11.64 ms | PDF 文本层抽取 |
| pdfplumber | 24 页 | 1.31 ms | 50.63 ms | PDF 文本层抽取 |
| Poppler（layout） | 24 页 | 13.42 ms | 19.30 ms | PDF 文本层抽取 |
| Tesseract（中文+英文） | 10 页 | 1865.80 ms | 2494.27 ms | 扫描页 OCR，尚无 CER 真值 |
| EPUB OPF + lxml | 21 本 | 79.35 ms | 207.02 ms | EPUB 章节结构提取 |

**测时边界**：PDF 数字文本引擎只计提取阶段、未计 PDF 加载及单页构造；Tesseract 包含 1.6 倍渲染和 OCR；EPUB 包含 OPF/HTML 阅读。不同任务和时间边界**不能直接横向排名**。本次 Linux CPU 沙盒，不是用户 Windows 11 / RTX 4060 主机；绝不冒充 Windows 测试。

## 工具分组：下一批必须进入真实横评

1. 原生快速路径：PDF.js / PyMuPDF / Poppler / LiteParse；EPUB 原生 OPF（可与 Docling EPUB 对照）。
2. 综合结构解析：**Docling、MinerU 4、Marker**。同页测阅读顺序、表格、图片、公式；不事先内定 MinerU 胜出。
3. OCR 和版面专项：**PaddleOCR / PP-StructureV3、Surya、olmOCR**，条件允许时再纳入轻量 OCR 变体。
4. 特殊疑难页：受控云端视觉模型（包括已有 GLM 配置）只在独立预算/调用授权后运行；本轮 **0 次付费调用**。

外部文档能力尚待本地部署验证，官方参考：
- Docling https://docling-project.github.io/docling/usage/supported_formats/
- Marker https://github.com/datalab-to/marker
- PaddleOCR https://github.com/PaddlePaddle/PaddleOCR
- Surya https://github.com/datalab-to/surya
- MinerU https://github.com/opendatalab/MinerU

## 质量指标与判定门槛（预注册，未得分不填写 0）

先完成 **人工真值**，再给排名；没有真值的输出只能算引擎可执行，不能算正确。

- 文本：按页 CER（中文字符错误率）、WER（英文词错误率）、乱码/缺字、脚注/标题遗漏。
- 结构：双栏阅读顺序、章节对应、页码定位、页内坐标与阅读顺序。
- 表格：行列、合并单元格和语义数据；测试可计算 TEDS 或结构 F1。
- 公式：LaTeX/MathML 表示完整性和关键公式语义。
- 图：节点、箭头、方向和关系三元组，计算实体/关系 precision、recall、F1。
- 性能：冷/热启动耗时、峰值 RAM/VRAM、失败/重试、单位页成本，记录硬件和模型 digest。
- 安全：禁止私有正文、图片、OCR 完整输出或云端请求写入公开仓库；零付费调用为默认。
- 横评：每个候选使用同样 SHA、同样物理页、同样真值；失败、超时、模型缺失必须显式列出，不能偷换为“跳过后通过”。

## 离线复跑

```powershell
python -m pip install pymupdf pypdf pdfplumber beautifulsoup4 lxml
# 若要启用 Poppler / Tesseract，另外确认 pdftotext 和 tesseract 已在 PATH
python tools/pdf-parser-benchmark/scripts/ebook_tool_selection_benchmark.py `
  --archive "D:\ai-cognitive-pdf-benchmark-data\books\电子书(1).zip" `
  --manifest "tools/pdf-parser-benchmark/corpus/ebook-20261022.manifest.json" `
  --output "D:\ai-cognitive-pdf-benchmark-data\reports\ebook-20261022-baseline.json"
```

如果已将电子书解压到多个受控子目录，改用 `--directory "D:\ai-cognitive-pdf-benchmark-data\books"`。仓库中的输入示例路径只是约定，不声明该 ZIP 已存在于 Windows 主机；运行前要核对实际路径。

脚本 SHA 匹配，不依赖电子书文件名或目录结构；元数据输出不含正文。脚本单文件逐个处理，且设单文件 200MiB 上限。该复跑脚本是正式留档的下一轮执行入口；本轮 127 条历史测时由本会话原始工具运行采集，不能把“脚本已提交”当成 Windows 实跑证据。

## 接下来的必要工作

- **A1：** 在 Windows Runner 核验测试资料与 SHA 是否对应；确认 Docling/MinerU/Marker/PaddleOCR 等实际版本、模型权重、开源许可证与可用硬件，做好资源门禁。已完成 MinerU 历史证据应引用而非重新假定通过。
- **B1：** 每种高价值类型补齐人工真值、图表/公式测试标签，完成同页多引擎数据采集。
- **C1：** 基于 B1 真实精度+成本设计路由组合（快速路径、OCR、复杂结构、图关系、可追溯人工复核）；不得凭本次速度基线提前冻结选型。

## 阶段治理

本工作沿用独立 Draft PR；不合并，不改生产解析器，不触发付费 GLM 请求，不改变审核认证门禁。所有精确 SHA CI 和真实 Windows 测试结果须另行核验，当前不得写“最终架构已验证”。
