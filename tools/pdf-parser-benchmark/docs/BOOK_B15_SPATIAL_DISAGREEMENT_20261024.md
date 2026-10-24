# B15 物理第 109 页：源页 3×3 粗网格识别分歧诊断

## 已有真实证据

在 #145 中，B15 PDF 物理第 109 页的相同原始来源 SHA 被 RapidOCR 和 MinerU Basic 比较：规范化字符分别 226 和 105，三字符 Dice 0.605505，**不是准确率**。#148 Windows 已证明 RapidOCR 的 32 个识别行中有 14 行无 trigram 匹配、2 行低匹配、8 行过短、8 行高匹配。#149 Windows 的精确 LCS=105，字符多重集合交集=105，顺序差距=0，**MinerU 整个规范化字符串是 RapidOCR 字符串的保序子序列**。

因此本轮不再纠缠文本排列顺序，而利用 RapidOCR 本地已保存的四点坐标，只对**空间分布**进行调查；不能将上述判断升级为 OCR 准确率或“MinerU 漏 121 字”。

## 源页与数据保护

新脚本：`tools/pdf-parser-benchmark/scripts/ebook_b15_spatial_disagreement.py`

1. 先只读重新验证 #148 与 #149 的原始冻结报告，包括所有原始文档、单页 PDF、RapidOCR 行级 SHA 和 MinerU Markdown 源码 SHA；任何改变直接拒绝。
2. 从 #139/#140 历史数据管线中同源生成的 24 页 native 审计报告抽取 B15 **物理第 109 页**的 OCR PNG SHA 和像素高宽；与五书 RapidOCR 私有收据的原 PDF SHA、PNG SHA 和 OCR 行级 SHA 三重对照。
3. 使用 RapidOCR 既有四点文本框的中心坐标，将每条 OCR 行唯一归属到原页 3×3 粗网格区域，共 9 个单元。网格以已验证源页图像坐标为准，而不是 #149 的 OCR 行索引顺序；纯数字诊断不需要重新运行 OCR。
4. 每个单元只存匿名汇总：行数、低/零匹配行数、过短/空行数、中/高匹配行数、规范化字符数。九宫格合计必须与 #148 的全页 32 行和类别统计完全一致；四点越界、NaN、错误源页或不完整元数据全部 fail closed。
5. 默认只读；仅首次 `--write` 用 O_EXCL 在 D: 私有目录创建 `b15_spatial_disagreement_heatmap_3x3.private.json`，后续必须 `--audit-only` 重算检查。旧报告、旧 OCR、Markdown、PNG 不得覆盖或更改。

## 什么不能作为结论

- 网格内 RapidOCR 有 OCR 行，**不等于文字一定存在或 OCR 一定正确**；MinerU 文本没有匹配，亦不等于 MinerU 没有识别文字或存在模型 Bug。
- 粗网格只能指定优先核对的图像**区域**，没有识别图像中的实际文字、图片、表格或图结构。文字框也可能跨越多个网格，本协议仅按框中心归入一个单元。
- 多个引擎一致性、共同字符集合与空间对应均不能替代独立参考材料，CER、公式、表格、图表评价仍为 UNVERIFIED。
- GitHub 只能看到公开代码、合成测试和粗网格数量；不上传真实电子书内容、四点精确坐标、截图、OCR 行或词片段、不输出私人绝对文件路径及来源真实 SHA。
- 全程零新推理、零云端调用、零模型权重下载；合成 CI 与 Windows 原源真机 CI 使用 owner-only exact-head 门禁，任何未完成或失败不得声称验收通过。

**后续**：按 3×3 实测低/零匹配分布识别最可能有争议的区域，再在私有环境核对该区域的原始 PDF 图片/表格内容；然后考虑对同源原始页跑公平的 Docling Standard OCR 比对，**不得把不相关页或仅 Native 模式当 Standard OCR 结果**。
