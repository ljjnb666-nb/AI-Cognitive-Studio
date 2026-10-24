# AI Cognitive Studio｜五本 PDF 独立 OCR 参考文本准入与 CER 计算协议

**基线**：Draft #145（五书同页 RapidOCR／MinerU 文本一致性）之上；严格使用 B03 物理67、B08 物理64、B15 物理109、B29 物理72、B31 物理126 的 SHA 固定 PDF 页。不得用原模型输出自举“金标准”。

## 为什么必须分开“模型一致性”和“准确率”

三字符片段的 Dice/双向覆盖率，只比较两个模型产出的文本，一致不等于正确。要计算 CER（Character Error Rate），必须持有**未从 RapidOCR、MinerU、Docling 或旧 GLM 结果导出的独立参考文本**。此工具不生成、猜测、伪造、自动从 OCR 结果复制 reference；不存在参考时 CER 保持 JSON `null`。

### 独立参考从何而来

可以是经来源核对的出版社原文，或根据**原始 PDF 物理页**独立完成并确认的文字转录。它需要绑定：

- corpus_id、BXX 书 ID、**真实物理页码**、上游已固定的**单页原 PDF SHA256**（不是引擎新生成的 Markdown SHA）。
- 独立来源种类：`PUBLISHER_ORIGINAL_TEXT` 或 `INDEPENDENT_PAGE_TRANSCRIPTION`；相匹配的 `PUBLISHER_SOURCE_VERIFICATION` 或 `MANUAL_SOURCE_PAGE_REVIEW`。
- 独立来源证据 SHA、外部审核记录 ID、`reviewed_source_page=true`、`not_derived_from_rapidocr_or_mineru=true`、`reviewer_approval=INDEPENDENTLY_APPROVED`。
- 私有 `reference_text` 与其 UTF-8 SHA。所有标记均必须具备；缺一或页号、SHA、文本改动将拒绝该参考，不允许输出 CER。

**重要的工程事实**：上述程序可以检查元数据格式与哈希**完整性**，但无法密码学地证明“审核人实际独立比对了图像”这一现实行为，亦不能只根据 `reviewer_approval` 的自我声明把数据认证为绝对正确。执行真实准确率报告前仍须独立检查来源证明。本 PR 的报告显式标记 `reference_provenance_truth_requires_external_audit=true`。

## 私有格式

在 D 盘旧 Benchmark 私有根目录下单独放置参考（**不要提交 GitHub，不上传 Actions artifacts**）：

`D:\ai-cognitive-pdf-benchmark-data\semantic_gate\multibook_matrix_20261023\independent_reference_v1\B03_p0067.verified.private.json`

示例结构（**纯占位符，不可直接作为真实参考写入**）：

```json
{
  "schema_version": 1,
  "corpus_id": "ACS-EBOOK-20261022-A",
  "book_id": "B03",
  "physical_page": 67,
  "original_page_pdf_sha256": "<private staged PDF SHA256>",
  "reference_origin": "INDEPENDENT_PAGE_TRANSCRIPTION",
  "verification_method": "MANUAL_SOURCE_PAGE_REVIEW",
  "reviewed_source_page": true,
  "not_derived_from_rapidocr_or_mineru": true,
  "reviewer_approval": "INDEPENDENTLY_APPROVED",
  "reviewer_record_id": "<external review identifier>",
  "independent_source_sha256": "<publisher/source reference SHA256>",
  "reference_text": "<independently established private page text>",
  "reference_text_sha256": "<UTF-8 SHA256 of reference_text>"
}
```

上面值没有引用任何真实书本内容或 SHA；`<...>` 必须按真实、可信审核资料填写，不得由两套待比较 OCR 的结果或模型投票生成。

## CER 定义与边界

用与 #145 **完全相同**的文本比较规范：Unicode NFKC、大小写折叠、仅保留文字和数字，再以完整最小编辑距离计算

`CER = LevenshteinDistance(reference_normalized, prediction_normalized) / len(reference_normalized)`

- **精确编辑距离**，不是 SequenceMatcher、不把超过 1 的 CER 强行裁成 1。
- 计算预算：单页规范化文本最多 5000 字符，最大 6000000 记忆节省型比较单元；越界 **拒绝计分** 而非截断、猜测结果。
- 参考文本为空或不合规不计分；五本中部分参考合法时仅计对应书页，其余保持 `null`。
- 两个待比较结果来自既有私有 RapidOCR 行级文字和剔除图片的 MinerU Markdown，而非重新推理。
- 输出的 CER 是相对于这个独立*声明已审核*参考的字串误差；公式语义、表格二维结构、图方向和图节点都不是 CER 所能评价，仍需其他分层金标准。

## 运行及隐私

脚本 `tools/pdf-parser-benchmark/scripts/ebook_fivebook_reference_gate.py`：

- 默认只读预览，`--write` 仅 O_EXCL 写一次 D 盘 `fivebook_independent_reference_admission.private.json`，`--audit-only` 只读重算并完整比较；
- 没有任何可核验独立 reference 的首次运行可以记录 **五个缺失、全部 CER=null**，这是事实不是失败，也不是所谓“5/5 准确”；
- 参考新增以后已冻结的不可覆盖报告会明确拒绝 mismatch，新的参考版本必须启用**后续新版本 snapshot**，不可覆盖旧的门禁结果；
- stdout 仅显示匿名页 ID、是否已提供独立参考、数量，不打印原文、文字差异、源 SHA、模型秘密、路径或“金标准”内容。
- 本阶段零 OCR 推理、零权重下载、零付费 API 请求；既有 B15/B31 旧云端费用不重试。
- Windows owner-only 按准确 HEAD 运行；原 24 PDF、所有 RapidOCR/MinerU/Docling 输出、旧两次 MinerU 失败日志、五本结构与一致性证据执行前后 SHA 不变。

## 防滥用与已有未完成任务

- 没有独立参考的页**不可输出 CER**，即使两套 OCR 完全一致。参考来源与模型生成来源有冲突、SHA 不一致、含重复 JSON 键/非数值常量、危险符号链接，均拒绝。
- 不建立百分比“谁最好”的结论；若真实参考暂缺，继续把五书一致性测量作为质量诊断，**不转化为正确率或最终架构选型**。
- #145 Windows 仍需看真实是否通过；如果被 Runner 队列阻塞，不把合成测试成功视为同源真实文本对比已完成。
- 保留 #137 Ubuntu 540s apt 下载失败、#139 模型分类误报、#140 两次旧 MinerU 失败和 Node20→24 警告；全部 PR Draft/Open/Unmerged，未经授权不得合并。


## 独立参考持续更新：不可变 v1→v2 快照协议（后续 Draft）

首次 v1 报告可能如实记录五本均没有独立参考，因此五页 CER 全部为 `null`。这是初次准入检查，**不是最终准确率结论，也不是将来不能补充参考**。

之后在独立完成来源核对、具备合法审核依据时：

1. **绝不覆盖** `fivebook_independent_reference_admission.private.json`，也绝不向旧 `independent_reference_v1` 添加/改写资料。旧报告仍能按原始输入重算并核验。
2. 将新取得的、与固定书 ID/物理页/SHA 匹配的独立参考 JSON **单独**置于 D: 私有 `independent_reference_v2`。文件名仍使用 `B03_p0067.verified.private.json` 等格式。不从 RapidOCR、MinerU、Docling 或 GLM 的输出派生。
3. 首先只读确认旧快照：`python ebook_fivebook_reference_gate.py --private-root <D盘私有根目录> --manifest <已固定清单> --snapshot-version 1 --audit-only`。
4. 新版 **只读预检**：把命令中的版本改为 `--snapshot-version 2`，先不带 `--write`。程序重新验证 v1，评估 v2 参考，只有独立参考合格才计算条件 CER。
5. 经过来源与独立审核事实复核后，才对 v2 运行一次 `--write`，随后 `--audit-only`。新报告为 `fivebook_independent_reference_admission.v2.private.json`，附上前一快照 SHA256、版本号及上一报告重验事实；第 3 版同理继承第 2 版。版本号限定为 1～8，不接受任意路径。
6. 未满足审核条件时，不写 v2。**新版合成 CI 故意不运行 Windows v2 创建动作**，避免在没有独立参考时提前冻结无信息快照。

**关键边界**：哈希链能检测快照与来源变动，不能从数学上证明现实审核的独立性；外部审核真实性仍需独立核验。此机制也不代替公式 F1、表格 F1、图结构 F1 或最终多引擎择优。所有来源书页、参考文本、模型输出、哈希与 CER 明细仅保存在 D: 私有目录，不上传到公共 GitHub。
