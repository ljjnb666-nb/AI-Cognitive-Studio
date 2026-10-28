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
