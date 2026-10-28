# 五书私有 Benchmark v28 — 独立 Gold/CER 门禁

日期：2026-10-28。状态：仅合成测试已运行；真实五书 Gold 0/5，正式 CER=null。

基于独立 Benchmark 链 #198 而非视觉 Worker #205。原书、原页 PNG、来源全文、OCR 候选和真值只留在 D:\ai-cognitive-pdf-benchmark-data 的私有区域，绝不能推送到公开仓库或 GitHub Actions artifact / log。

## 固定样本

B03、B08、B15、B29、B31 五本 PDF，每本沿用已有来源 manifest 的 selected_physical_pages 四个物理页，全部合计 20 页；PDF 物理页从 1 开始。manifest 要包含 corpus_id、sources，书目记录至少需要 id、sha256、total_physical_pages、selected_physical_pages。本工具不会擅自变动所选页。

## 私有 v28 packet

一个 JSON 对象：schema_version=28、corpus_id 与来源 manifest 一致、rows 为已准备来源的数组，允许暂时缺页，但缺页必须显示待审核。每个 row 精确含：

- book_id、physical_page、source_pdf_sha256、source_png_filename、source_png_sha256
- bleedthrough：UNDETERMINED 或 FRONT_ONLY_VERIFIED
- candidates：最多 5 个；每个需包含 engine、text、source_pdf_sha256、physical_page。OCR 空文本必须作为删除错误计算，不能跳过
- reference：若无独立 Gold 则必须为 null；否则包含 text、text_sha256、authority=SOURCE_INDEPENDENT_APPROVED、review_origin=DIRECT_SOURCE_IMAGE、source_png_sha256、bleedthrough_verdict=FRONT_ONLY_VERIFIED 与 review_receipt
- review_receipt：status=APPROVED、source_png_sha256、reference_text_sha256、review_source=ORIGINAL_PAGE_IMAGE、engine_candidates_not_used_as_reference=true

严格图像文件名如 B08_p0064_FULL.private.png；脚本比对实际原图 SHA，不允许原页错位或更换。B08 相邻页不必然是背面：若透印归属未确认，不能出 Gold。

注意：代码只能验证审核声明与来源的绑定，不能仅凭这些字段证明审阅者真正独立观察过源页。因此仍需真实、可复核的直接原页审核事实；引擎一致绝不构成 Gold。

## 私有执行

调用 tools/pdf-parser-benchmark/scripts/ebook_private_gold_cer_gate_v28.py，参数：

--private-root D:\ai-cognitive-pdf-benchmark-data
--manifest D:\ai-cognitive-pdf-benchmark-data\private\corpus_manifest.private.json
--packet D:\ai-cognitive-pdf-benchmark-data\private\gold_packet.v28.private.json
--source-images D:\ai-cognitive-pdf-benchmark-data\private\pages
--private-output D:\ai-cognitive-pdf-benchmark-data\private\results\fivebook_gold.v28.private.json

上述文件是接口示例，并不声称已经真实准备完毕。输出路径必须属于同一私有根，只能创建一次，不会覆盖旧结果。

## 指标规则

使用原样 Unicode 字符 Levenshtein 编辑距离 / Gold 字符数；不私自删除标点或空格。20 个预选页都取得独立 Gold 且同一引擎覆盖全部 20 页，才能为该引擎提供 official_fivebook_cer。部分 Gold、缺任一物理页、缺引擎识别结果则保持正式 CER 为 null，另将局部结果标为 provisional_page_metrics。私有结果文件只存统计值，不存原文字节或页图；标准输出只包含固定状态标志和待审页数。

文字 CER 不能替代表格、图结构、公式、版面与阅读顺序的专项指标。真实五书尚未通过，Docling 生产开关 OFF，Issue #161 OPEN，不自动发布正文或播客。所有 PR 保留 Draft、未合并。
