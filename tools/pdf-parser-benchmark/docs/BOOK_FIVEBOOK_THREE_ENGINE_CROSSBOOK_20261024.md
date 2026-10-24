# 五本真实 PDF 的三引擎同源文本一致性比较（v8）

## 基线

上游 [Draft PR #159](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/pull/159) 准确 HEAD `bbe933030127d2055fbc9eda9633c1fa008b84c7` 已完成 **五本五页真实 Docling Standard + RapidOCR** 的专项 Windows 验收，包括 B15 冻结 v4 复用、B03/B08/B29/B31 新执行。五本书的同源原始 PDF 焦点页：B03 p67、B08 p64、B15 p109、B29 p72、B31 p126。

## v8 目标

使用已冻结三种真实 OCR 文本：
- 独立 RapidOCR 原始行级文字。
- MinerU Basic 4.0.3 输出 Markdown，必须先去掉内嵌图片 Base64。
- Docling Standard + RapidOCR 原始 worker Markdown（B15 v4、另四本 v7）。

每页先核验上游五本 RapidOCR↔MinerU 已冻结一致性报告及 B15 三引擎 v5 官方冻结回执，逐页对齐**相同原始 PDF 单页 SHA、OCR 行 SHA、MinerU Markdown SHA、Standard worker SHA**。每份输出经过同一 NFKC/大小写折叠/字母数字保留规则，然后才做对比。

输出每页三对：

1. 独立 RapidOCR ↔ MinerU Basic。
2. 独立 RapidOCR ↔ Docling Standard + RapidOCR。
3. MinerU Basic ↔ Docling Standard + RapidOCR。

每对返回实际字符数、3-gram 数及两侧覆盖比例、3-gram Dice、最长公共子序列 LCS、无序字符袋交集和顺序差距。绝不把相似度当作 CER、识别正确率或真值。尤其独立 RapidOCR 与 Standard+RapidOCR 采用共同 OCR 系列，**不是两次独立的模型投票**。

新脚本：`ebook_fivebook_three_engine_crossbook.py`，新私有 O_EXCL 汇总 `fivebook_three_engine_crossbook_consensus.v8.private.json`。首次生成后只能 `--audit-only` 依据完整源 SHA 独立重算；公有 GitHub 仅输出每页匿名数值，不输出真实 OCR 字串、章节、原图片、坐标和私有路径。

## 验收与下一阶段

- 新 5 项 synthetic + 上游 56 项回归；完整主 CI 与独立 owner-only Windows 源私有真实统计均需 exact-head SUCCESS。
- **无任何 OCR 重推理、模型安装、下载或云端调用**；v7 页面模型结果保持不可变。若五页来源缺一、B15 v5 Dice/LCS 漂移，立即拒绝生成报告。
- 通过之后优先检查 B15 是否为五页中异常离群点，分析其下中 R3C2 与其他书页的版面类型差异；最终解析器选型仍须有独立 OCR gold、图表/公式结构评估、页面耗时和内存峰值证据，不以模型一致性直接排名。
- PR 保持 Draft/Open/Unmerged，未经用户明确授权不得合并。
