# 五书独立参考答案完整覆盖门禁｜Stage 1 / FRG-01

## 为什么现在修这一项

当前多引擎 Benchmark 已经形成五书同源样本和 B15/B03 大量证据，但历史 `ebook_fivebook_reference_gate.py` 的 CER 计算仍有一个重大口径缺口：它验证了独立参考的来源、SHA 和审核声明，**却没有限定参考文本必须包含被测物理页的全部文字**。如果错误地给几段抽查文字填写 `INDEPENDENTLY_APPROVED`，旧算法也会将这些短句与整页 RapidOCR / MinerU 输出计算编辑距离，产生毫无意义的“整页 CER”。

本 PR 只修这个**评测完整性错误**，不引入 OCR 引擎、不更换正式路线、不额外下载模型或消耗云 API；不触动原书私有数据。

## 新增准入契约

在现有必需字段和真实 source-PDF SHA 之外，`*.verified.private.json` 必须额外包含：

```json
{
  "reference_scope": "COMPLETE_PHYSICAL_PAGE_TEXT",
  "full_page_coverage": {
    "coverage_scope": "COMPLETE_PHYSICAL_PAGE_TEXT",
    "reviewed_grid_cells": ["R1C1", "R1C2", "R1C3", "R2C1", "R2C2", "R2C3", "R3C1", "R3C2", "R3C3"],
    "sidebars_and_vertical_text_reviewed": true,
    "all_visible_text_and_punctuation_transcribed": true,
    "page_reading_order_reviewed": true,
    "unresolved_text_regions": []
  }
}
```

这是**核查覆盖范围的必要声明**，不是自动证明核对者真的看了全部文字。完整来源证明仍需要现有的外部审核；该门禁从不自动给自己签发 `INDEPENDENTLY_APPROVED`。若某一角落仍存在模糊文字，请保持其记录在独立私有草稿中，**不要创建已核准全文 reference**。

## B03、B15 的正确用法

- B03 物理第 67 页先前可目视核查的 8 段 46 字是**有选择偏差的局部抽样**，不能伪装成整页参考，更不能据此宣称 MinerU 是全书最佳。
- B15 物理第 109 页已确认图例所在 ROI 及形状候选，但 4 格里形态识别仍有弃判；图例符号、坐标曲线等需要单独结构/语义 truth。CER 仅用于经全部核查的页级文本，不能替代图像与图例语义的质量指标。
- 对比 Docling 的裁剪范围、右侧竖排漏提取、页面阅读顺序，也必须在**同一个已认证的文字范围**上测算；不能把 scoped samples 与整页字符串直接求 CER。

## 安全与不可变性

- 只有纯合成单元测试提交 GitHub；没有原书截图、OCR 文本、私人 SHA、审核者身份数据或私有 gold。
- 以前冻结的 `fivebook_independent_reference_admission.private.json` 与 v2…v8 不会被本 PR 重写。后续只能使用现有版本化 snapshot 机制写**全新**报告，旧档案先 audit-only。
- 旧 reference snapshot 中若存在未声明完整范围的已签收项，新门禁会 **fail closed**；需生成新版有证据的参考和验收，而不是静默补字段修改历史报告。
- 修复不会声称审核声明已经经过密码学验证。报告继续保留 `reference_provenance_truth_requires_external_audit=true`。

## 三阶段计划中的完成门槛

Stage 1 不以“代码门禁通过”为完成标准。真正的退出条件是：五书代表页分别有完整且同源的可信文字参考，B03 p67 整页、B15 p109 图中文字与图例符号具有可独立追溯的图像依据，并能在相同区域中比较 OCR 结果。此 PR 只是防止**在那之前产生伪 CER**。

Stage 2 才在相同金标准与样本覆盖上比较 PDF.js / MinerU / Docling / RapidOCR / 必要视觉兜底的准确率、图表保真、速度、内存与成本；Stage 3 输出 `ARCHITECTURE_V1` 决策并冻结。

保持 Draft/Open/Unmerged；Issue #161 保持 OPEN；未经用户授权不合并。
