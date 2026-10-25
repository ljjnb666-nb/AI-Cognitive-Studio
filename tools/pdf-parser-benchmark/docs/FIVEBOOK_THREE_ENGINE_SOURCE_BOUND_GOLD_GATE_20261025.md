# 三引擎独立金标准评分门（Stage 1 → Stage 2 的准入接口）

## 为什么需要

现有五书 Benchmark 已实测并 SHA 冻结三条路径：**RapidOCR Standalone、MinerU Basic、Docling Standard+RapidOCR**。过去的 `ebook_fivebook_reference_gate.py` 有来源声明、整页九宫格和 CER 审核，但正式评分只对 RapidOCR 与 MinerU 进行计算；Docling 的第三条路径此前只有 agreement/Dice，不是准确率。

在未取得可信独立参考前，不能根据 Dice、OCR 字符长度、两页耗时或视觉初稿确定某个主引擎。

## 本 PR 的有限能力

1. **不修改历史参考**：将独立参考快照版本允许范围由 `v1–v8` 扩大为 `v1–v12`。所有 v1–v8 的已冻结文件保持原名、原字节、原 SHA 和 audit-only 语义；未来 v9+ 可承载独立核准参考。
2. 新增 `ebook_fivebook_three_engine_gold_grade.py`，首先读取并核验五书已冻结的 v8 三引擎真实来源报告，以及原生页和参考准入报告。
3. 若某书未核准，则它的三项分数均为 `null`，不允许取三引擎共识、OCR Markdown 或个人视觉草稿替代 gold。
4. 若未来存在正式 `verified.private.json`，除原有 `INDEPENDENTLY_APPROVED`、完整物理页九宫格、出版商/独立来源及 reference SHA 外，必须增加 `source_page_png_sha256_private` 与冻结 **物理页 PNG 文件真实 SHA** 对账。不通过则拒绝全部评分。
5. 只有在参考页、RapidOCR 行、MinerU Markdown、Docling worker 的来源/文件 SHA 和字符规范化长度全部一致时，才同时计算三引擎字符编辑距离。新报告标注的是**只针对 NFKC + Unicode 字母数字的 normalized alphanumeric CER**，不会覆盖标点、阅读顺序、图片保真、布局或图例到曲线的语义指标。
6. 评分报告是私有的新版本化文件，首次写入 O_EXCL，重放逐字节审计。Windows Runner 首次只运行 `--check-only --snapshot-version 1`，**零修改、零 OCR、零模型、零云调用**，严格限制向 Actions 输出仅五书通过与未通过数量。

## 当前真实能力与缺口

按最近一次 Windows 独立来源核验，正式金标准仍为 **0/5**。因此当前正常结果应该是 5 个 `reference_state=MISSING`、15 个引擎评分 `null`，不会输出排名。这不代表工具没有正确工作；只有拿到独立审核的五页参考，才存在合法的评分输入。

B03 p67 来源视觉 v3 和 B15 图例仍然 `NOT_APPROVED`；五书原图离线工作台 v12 已在 #179 的 Windows Runner 真正执行成功，但其 `DRAFT_UNVERIFIED` 导出不具备审批权。用户个人文件库原图与 D 盘字节同源 SHA 尚未独立验证，不能伪装为 gold。

## Stage 2 / Stage 3 的真正决策准入

即使三项 normalized CER 全部完成，也只能作为**文字准确率**维度。正式选择 PDF.js / MinerU / RapidOCR / Docling 的路由组合前，还必须分别核对：
- 原文图表/示意图是否保留真实像素与来源锚点；
- 表格、公式、标题和竖排旁注的顺序与可检索语义；
- B15 图例的实心/空心及独立曲线对应关系；
- 各引擎在完全相同硬件、图像预算和缓存策略下的速度、内存和调用成本；
- 覆盖不同书籍与页面类型的统计不确定性。五页样本也不代表全书库。

本 PR **只建立能拒绝伪 gold 的三引擎评测接口**；不自动审批参考、不切换生产路由、不生成播客、不上传版权图片、OCR 原文或任何私有完整来源 SHA。

所有 PR Draft / Open / Unmerged，不经用户明确授权不合并；Issue #161 保持 OPEN，ARCHITECTURE_NOT_FROZEN。
