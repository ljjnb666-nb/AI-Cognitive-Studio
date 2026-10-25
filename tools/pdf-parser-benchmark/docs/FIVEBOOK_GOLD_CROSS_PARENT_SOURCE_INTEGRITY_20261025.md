# Stage 1｜三引擎金标准评分前的跨回执来源一致性加固（#181）

## 实际问题（与 #180 的能力边界不同）

五书 gold 评分依赖四路在 D: 私有域冻结或重新核验的记录：独立参考、三引擎同页回执、原始六书 24 页 / 五张来源 PNG、RapidOCR 行回执。此前 #180 在确认 `book_id` 字典集合一致后才逐页关联，但 Python 字典构造会静默覆盖重复记录；若上游某处出现多余的重复行，其键集合仍可能完整。与此同时，只检查相同 book/page，不显式同时对账参考、三引擎、RapidOCR 和 native PDF 的四条来源 SHA，可能使形式上合规的评分跨过错误的同书不同版本来源边界。

这并不声称真实 D: 既有原始回执已损坏；原本的各层独立审计也已有不少源校验。这里增加的是**四路资料组装后的最后一道强制交叉核验**。

## 已实施的准确行为

- **记录完整性：** reference、three-engine、RapidOCR 各要求准确的五本记录且 book_id 无重复；native 要求完整六本（含不参与 OCR 焦点的 B16），任何重复、遗漏、额外记录都拒绝。
- **同 corpus：** RapidOCR 与 reference 的 corpus_id 必须相同；crossbook 和 native 的 corpus 已由 #180 校验。
- **同 PDF：** 每一焦点页的 reference `original_pdf_source_sha256_private`、three-engine `same_original_single_page_sha256_private`、RapidOCR `source_document_sha256` 与 native `source_document_sha256` 四者必须全等且具备规范 SHA-256 形态。
- **同物理页与同 PNG：** 三引擎、RapidOCR、reference 页号一致，并与 native 对应物理页焦点 PNG 对账；RapidOCR `render_png_sha256` 必须是 native 原渲染来源 PNG 的 SHA。
- **同 RapidOCR 行来源：** 三引擎回执内 `rapidocr_rows_sha256_private` 必须与 RapidOCR 冻结回执一致。
- 这些校验在**没有任何已核准独立 gold** 的情况下也执行；既不打开任何金标准批准后门，也不继续使用不可信的来源集合进行评分。

## 覆盖与验证

仅添加合成安全回归：重复/多余 gold、three-engine、RapidOCR、native 行；缺失 B16；corpus 错配；四种 PDF SHA 差异；PNG SHA、OCR 行 SHA、页号错配，以及原有缺 gold 时全部 CER=null、正常获批合成 gold 三引擎评分。不得把合成获批样本理解为真实审核通过。

精准 HEAD Linux synthetic、owner-only Windows `--check-only` 与主 CI 必须分别通过方可宣称此切片工程验收。Windows 仅读取原先 D: 来源并确认 SHA 未改变，公开 CI 不展示任何原图、OCR 文本、完整私有 SHA、原始路径、裁切坐标。

## 不变的产品和金标准边界

- 私有电子书原文、OCR 识别结果与原图字节都不进入 GitHub 或公开 Artifact。
- **五书独立金标准仍为 0/5，全部真实 normalized alphanumeric CER 仍为 null；不选择主备 OCR 引擎**。
- #180 的分数不涵盖标点、段落阅读顺序、图片、图表、公式和图例/曲线关系；需要另行独立准确性与覆盖范围审核。
- 此次纯 Benchmark 一致性防线，无生产解析改动，无新 OCR、云端视觉、模型下载或视频/播客作业。
- 本 PR 为 Draft、Open、Unmerged，基于 #180；Issue #161 继续 OPEN；生产识别架构维持 `ARCHITECTURE_NOT_FROZEN / ACCURACY_UNVERIFIED`。
