# B03 原书身份与物理页只读核验

本阶段只在 Windows 私有数据目录识别 B03 原始 PDF，并核查来源 SHA256、总物理页数和第 67 页可否渲染。**不执行 OCR/模型、不安装依赖、不上传私有原书。**

- 脚本路径：tools/private-pdf-review/verify_b03_source_readonly.py。
- 默认只扫描 D:\ai-cognitive-pdf-benchmark-data；可用 --root 指定经过确认的私有原书根目录。
- 固定 B03 文件长度 151,495,200 字节和已归档的完整 SHA256；不按猜测书名推断身份。拒绝多份完全匹配、超宽扫描、软链接及 Windows Junction/reparse 路径。
- 使用 4 MiB 流式 SHA；若本机预装 PyMuPDF (fitz)，验证总页数 271 和第 67 页小尺寸渲染，最长边限制 768 像素。**渲染后再次完整计算 SHA，核对修改时间与大小**，防止首次 SHA 校验后原书在另一次按路径打开期间被替换；不会导出像素或扫描内容。通过时将对同一 151.5 MB 原书至少做两轮顺序读取，需考虑本机磁盘 I/O。
- 输出固定的 ACS_B03_PRIVATE_SOURCE_PROOF JSON，只包含安全枚举与 PASS/NOT_VERIFIED；**不输出私有路径、书名、原文、图片或任意异常内容**。
- 即使完整 PDF SHA 和第 67 页渲染均成功，仍不能证明此前上传的 Library 单张 PNG 与当前 PDF 密码学同源。uploaded_library_png_identity 始终为 NOT_ATTESTED。
- 完全验证 PASS 返回退出码 0；任何缺库、未测、找不到或校验失败均返回 2。
- GitHub CI 只用合成字节运行 unittest，不在 self-hosted Windows Runner 读取私有材料。未经代码审查，不能让 PR head 在 Windows Runner 自动执行。

## Windows PowerShell 示例（须先审查并同步受信任脚本）

    python -I -B .\tools\private-pdf-review\verify_b03_source_readonly.py --root D:\ai-cognitive-pdf-benchmark-data

如原书不在默认数据根目录，工具只报 B03_SHA_NOT_FOUND；不要为了测试绿灯篡改期待 SHA。

本轮的 Windows SHA、271页及页面渲染**尚未实际执行**，上传 Library PNG 的同源性、全页 Gold/CER 和生产验收仍为未验证。

## 私有同页 OCR 对比：先检查同源，再讨论准确率

新增纯本地、只读的 `compare_ocr_candidates_offline.py`。用户将原书 PDF、同一物理页的 MinerU / Docling / RapidOCR 文本和 JSON manifest 放在 **Windows 私有 Benchmark 目录**；脚本不联网、不调用 OCR、不复制书页、不写输出文件、不在 GitHub 中保存书籍文本。

示例（仅演示字段，**绝对不是有效 B03 元数据**）：

```json
{
  "schema_version": 1,
  "source": {
    "book_id": "B03",
    "pdf": "original-book.pdf",
    "sha256": "<由已核验 B03 原书身份给出的完整 SHA256>",
    "size_bytes": 151495200,
    "page_count": 271,
    "physical_page_1_based": 67
  },
  "candidates": [
    {
      "engine": "mineru", "revision": "pinned-version",
      "text": "private-candidates/mineru-page67.txt",
      "source_sha256": "<与上述完全相同的 SHA256>",
      "physical_page_1_based": 67
    },
    {
      "engine": "rapidocr", "revision": "pinned-version",
      "text": "private-candidates/rapidocr-page67.txt",
      "source_sha256": "<与上述完全相同的 SHA256>",
      "physical_page_1_based": 67
    }
  ],
  "reference": null
}
```

将此 JSON 保存在私有根目录下 `review-manifest.json`，替换占位符、确保原书和候选文本真实存在，再从已审查的项目副本中运行：

```powershell
python -I -B .\tools\private-pdf-review\compare_ocr_candidates_offline.py --root D:\ai-cognitive-pdf-benchmark-data --manifest review-manifest.json
```

- 严格校验 PDF 完整 SHA256、大小、PyMuPDF 物理页数、目标页与 SHA 复验；B03 额外要求匹配仓库中的已知 151,495,200 字节 / 271 页 / 固定 SHA。缺 PyMuPDF、混用页码、SHA 不一致、软链接、越界、文件超限均拒绝。
- 引擎声明的 `source_sha256` 仅是候选**自报元数据**，不是模型执行来源的独立审计证明。脚本会明确标记 `candidate_lineage=DECLARED_NOT_INDEPENDENTLY_ATTESTED`。
- `reference: null` 或未覆盖整页的视觉草稿时，**只生成引擎间编辑距离**，不是 CER、Gold 或引擎排名。输出无书页原文、无文件路径。
- 如本地 manifest 自报 `coverage=FULL_PAGE`、`review_status=APPROVED`、`independent_review=true` 且包含 `reviewer_approval_id`，可得到 `provisional_cer`；但标记仍是自报参考，`official_cer=null` 且 `engine_ranking=null`。后续必须完成独立来源审查后才能作正式质量结论。
- 当前阶段不能借此声称 B03、B08/B15 整页 OCR Gold 已验收，也不能以候选间相似度替代准确率评测。正式来源同源证据、人工审核意见和引擎版本记录保持在私有目录，禁止提交真实书页和候选全文。


## 单页 RapidOCR 真实运行 + 私有执行收据（候选产出，不是正式 Gold）

`run_rapidocr_candidate_offline.py` 可在已配置 **RapidOCR 3.9.2、ONNX Runtime 1.22.1、PyMuPDF** 的本机 Python 环境运行。它会复用仓库内的 `packages/ingestion/src/rapidocr/rapidocr-child.py`，执行真实模型识别（不是 Mock），**不会自动安装模型或依赖、不会请求云端 API，也不把书页传到 GitHub**。请在审阅脚本后手动在受信任的私有 Windows 环境中运行。

先在私有 Benchmark 根目录准备 `b03-source.json`（仅原书声明；原书必须已存在且精确匹配 SHA，注意 67 是 PDF 物理页码，而非书中印刷页码）：

```json
{
  "book_id": "B03",
  "pdf": "original-book.pdf",
  "sha256": "5be652d2066b680f1242bf358979c549aaf8a1588d9648926ecd8b6c30697440",
  "size_bytes": 151495200,
  "page_count": 271,
  "physical_page_1_based": 67
}
```

示例中的文件名仅为占位符，必须替换为私有根目录内实际 PDF **相对路径**。在私有根目录内预先建立 `private-candidates` 子目录；不允许符号链接、路径穿越、复用同名输出：

```powershell
python -I -B .\tools\private-pdf-review\run_rapidocr_candidate_offline.py --root D:\ai-cognitive-pdf-benchmark-data --source-manifest b03-source.json --output-dir private-candidates --stem rapidocr-B03-p67
```

成功后私有目录内生成 **两份文件**：

- `private-candidates/rapidocr-B03-p67.txt`：真实 OCR 候选文本，仅留本地；
- `private-candidates/rapidocr-B03-p67.receipt.json`：本地运行收据，包含原书 SHA/大小、物理页、RapidOCR 版本、ONNX 模型权重 SHA256、候选文本 SHA256 和字符数，不含原文。

再将主比较 manifest 中 RapidOCR 候选字段设置为：

```json
{
  "engine": "rapidocr",
  "revision": "3.9.2",
  "text": "private-candidates/rapidocr-B03-p67.txt",
  "receipt": "private-candidates/rapidocr-B03-p67.receipt.json",
  "source_sha256": "5be652d2066b680f1242bf358979c549aaf8a1588d9648926ecd8b6c30697440",
  "physical_page_1_based": 67
}
```

比较器会额外校验 receipt 的原书 SHA/大小、页码、引擎名称/版本、模型 SHA 格式、文本字节 SHA 和字符数。如果有人更改原文本或交叉复用收据，会直接拒绝，而不是悄悄统计差异。旧候选没有 receipt 仍可进入**未核验候选**列表，但不会被升级为可信运行证据。

**证据边界**：本地收据不包含独立签名，也不能证明声称的其他引擎确实运行过；它只能证明当前私有文件/收据字段自洽。参考文本未完整独立审核前，`official_cer` 与 `engine_ranking` 始终为 null。不能以模型烟测、文本相似度或收据一致性代替真实 B03 准确率。

## RapidOCR 3.9.2 模型完整性与分发门禁

当前固定的 `rapidocr==3.9.2` 发行版自带三个小型 ONNX 权重。项目现已在 Python 子进程 `--probe` 和真正的 `--pdf` 路径上逐个检查权重名称、数量与 **每个文件的固定 SHA256**，不再只检查版本号或计算任意模型自报摘要。文件被替换、缺失、增加或通过符号链接代入时拒绝继续识别。请勿为了让 CI 变绿而删除模型哈希核验。

上游安装文档：https://github.com/RapidAI/RapidOCRDocs/blob/main/docs/install_usage/rapidocr/install.en.md

v3.9.2 三权重的发行文件哈希记录与许可证讨论：https://github.com/RapidAI/RapidOCR/discussions/736

**许可边界：** 仓库只记录已公开的哈希，不上传/镜像/重分发 ONNX 权重。上游项目代码许可证与模型权重的商业使用、分发授权不应直接等同；未经许可证材料核实，不得将“技术可运行”视为商业生产分发许可已通过。

**验收边界：** 这些检查只证明本地权重与固定发行文件一致，既不代表已实际完成 ONNX 推理，也不能证明原书 B03 的 OCR 准确率。真实模型 smoke、源文件 SHA、私有来源收据与独立 Gold/CER 必须分别验收。


## B03 第 67 物理页：单命令真实识别入口

无需人工查询原书文件名、手写 source JSON 或手动计算 SHA。已审查仓库代码并在**你自己的 Windows 私有数据环境**预装好固定版本 Python/RapidOCR/ONNX Runtime/PyMuPDF 后，运行：

```powershell
python -I -B .\tools\private-pdf-review\run_b03_page67_private.py --root D:\ai-cognitive-pdf-benchmark-data
```

入口自动完成：

1. 在私有 Benchmark 根目录递归查找**完整 SHA256 精确匹配**、长度 151,495,200 字节的唯一 B03 原书；若同一个文件有多个副本，拒绝擅自选一个。
2. 将物理页固定为 **67（从 1 开始）**，与印刷页码严格区分。
3. 在源文件通过核验后自动创建私有 `private-candidates` 子目录（拒绝符号链接和 Windows reparse point），调用既有真实 RapidOCR 子进程。子进程先核验三个固定 ONNX 权重 SHA256，再对 PDF 第 67 物理页推理。
4. 子进程返回后再次确认完整 PDF SHA256 及修改时间，才独占写入 `rapidocr-B03-p0067.txt` 和 `rapidocr-B03-p0067.receipt.json`。如果已有同名文件，拒绝覆盖；如需再次生成，先人工审查已有候选，避免无意损失证据。
5. 标准输出只包含固定状态码、页码和安全布尔结果；**不包含原书 PDF、路径、原文、识别全文或任何密钥**。不会自动上传或提交私有数据。

该入口只产出**一个真实 RapidOCR 候选和自签收据**，不是 MinerU/Docling 全引擎同页评测，也不是正式 Gold/CER。其余引擎必须由各自的真实执行器生成同源同页文本后才能加入比较。GitHub CI 中的对应 unittest 仅使用合成文件和 mock，不执行用户原书 OCR。运行命令需要用户私有 Windows 环境实际可访问原书和安装好模型；未在用户电脑上执行之前不得宣称已完成 B03 实测。
