# 2026-10-23 正式 Benchmark 第二种引擎：Docling Native PDF（非 AI/OCR 管道）

## 基线

上游 Draft #137 SHA `3b47d2f2528030fa1fd4ee2261a120f767b986ea`：Windows 真实 6 本原 PDF 的 24 页原生结构已完成；在五本各取一页的 RapidOCR CPU 测试共 142 行、2831 字符；原图和行级文字保存在 D:，非 OCR 金标准。保留上游 27 本书源 Manifest（6 PDF、21 EPUB），**不改任何原有页码或抽样**。

## 本轮实际运行

用已安装 `docling==2.141.0` 的隔离 Python 在**同一批 6 本 PDF 的同一 24 个物理页**实测 Docling 官方 `NativePdfPipeline`：

- 严格匹配每一本原书的 Manifest 大小/SHA，按原物理页使用 PyMuPDF 逐页裁出一次性的**单页 PDF**；不接受临时重选页、缺书、页次错位或额外页。
- 显式使用 `NativePdfPipelineOptions(parser_threads=2, generate_page_images=False, generate_picture_images=False, enable_remote_services=False, allow_external_plugins=False)`。
- Docling 返回 `SUCCESS` 才记录；逐页只在 D: 保存原生文本 Markdown、本引擎文本单元/图片单元计数、运行毫秒和正文 SHA；汇总日志只允许**匿名总数**。24 张单页 PDF 只留在 D: 私有路径，以 SHA 绑定。
- 输入页独立重复从 Manifest 和原 PDF 验证、保留全部 24 页原编号，不能通过复用 RapidOCR 的 OCR 原文填充结果。
- 任何失败保留原始首次 CI 和局部私有文件，停止后不会覆盖或跳过失败页。已有完整运行则改为只读 SHA 验收，不执行二次 Docling 推理。
- 所有历史书、图片、B15/B31 付费标记和 GLM 原始回复保持不可覆盖/不上传；此阶段 provider 调用 0，模型权重下载 0。

## 准确率边界

**NativePdfPipeline 官方定义为“model-free”：它提取 PDF 中已有的原生内容，不运行 Docling OCR、版面检测或表格结构模型。** <https://docling-project.github.io/docling/usage/advanced_options/>

所以它可以与 PyMuPDF 进行同输入的原生文字/图片/耗时覆盖对照，但**不能代表完整 Docling AI 解析质量**，也不能与 RapidOCR 或 MinerU 的 OCR 准确率直接排冠军。无人工 reference：OCR CER、布局 F1、节点/有向边 Graph F1 均 UNVERIFIED。独立 MinerU 4.0.3 的模型目录和命令行就绪状态仍须另行核验，不能因当前 Docling venv 中不含 MinerU 便宣称 MinerU 不可用。

## 执行

- 私有结果根目录：`D:\ai-cognitive-pdf-benchmark-data\semantic_gate\multibook_matrix_20261023`
- 新结果：`multibook_docling_native_24pages.private.json`，以及 `docling_native_single_pages\` 中 24 个仅供对照的私有单页 PDF。
- GitHub Ubuntu 8 组完整 synthetic test，用 6 本合成 PDF、24 页、伪 Docling 实例校验页完整性、源 SHA、失败优先、独占写入、旧证据不变。
- owner-only exact-head Windows Runner 不下载任何模型或依赖，不显示文本、源路径、哈希、真实节点、GLM 字符串，遇运行失败只公开匿名类别状态。继承并保护先前数十份 B15/B31 和跨书结果的 SHA 不变量。未经明确授权，所有 stacked Draft PR 不合并。

## 下一批

已完成首轮 PyMuPDF / RapidOCR 后，该 NativePdfPipeline 是第三个**真实运行的基线**，但不是三个完整的 OCR 引擎比较。下一批应核验离线模型资源和缓存路径，随后在相同页运行 **Docling StandardPdfPipeline（含 OCR/布局/表格）** 与 **MinerU 4.0.3**，按独立 reference 比较识别质量、耗时、资源需求和隐私成本。
