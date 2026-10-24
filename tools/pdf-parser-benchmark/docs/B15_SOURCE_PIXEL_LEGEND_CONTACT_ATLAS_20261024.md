# B15 p109 图 1-4-16｜逐行来源像素对照图集（v6）

## 目的与新增价值

既有 #170 的 v5 四点框和 #171 的统计已经确认 19/19 条 OCR 行主要处于同一个候选图像区域。**空间覆盖本身无法证明图例、标记或曲线语义正确**。继续增加交集计数没有意义。

这次不重跑 OCR，不调用云模型，而是从**同一份冻结的原始 PNG** 中，为 19 条候选分别提取三个原始像素邻域：左侧、OCR 文字框本身、右侧。生成源图局部对照板，帮助实际复核图内形状、候选文字与邻近标记的关系。

## 冻结的三件私有交付物

全部只存在 `D:\ai-cognitive-pdf-benchmark-data\semantic_gate\multibook_matrix_20261023`：

1. `b15_legend_source_context_atlas.v6.private.json`：固定 B15 第 109 物理页、图 1-4-16、19 条源行、每行三处原始页面像素切片框、完整来源 SHA 与全部未审核标记。
2. `b15_legend_source_context_atlas.v6.private.png`：19 行 × 左/中/右三列原图局部像素对照，仅使用 R01–R19 作为编号，没有模型生成的图例标签。
3. `b15_legend_source_context_atlas.v6.private.html`：离线中文来源审核页面，显示对照板以及私有 RapidOCR 文字候选；启用本地 CSP，并对识别结果做 HTML 转义。文字仅展示在私有 HTML，不进入公共仓库、日志、Issue 或 Artifact。

## 权威和安全边界

- 从冻结的原 PDF 同源渲染 PNG、MinerU Markdown 和 v1/v3/v4/v5 回执重算 v5 的几何对象，并验证 v5 叠加 PNG 完整一致，拒绝任何来源或 authority 变更。
- 对处于候选 ROI 外的行，只提供实际的 OCR 行像素，不凭空合成左右“标记邻域”。
- v6 报告中 `marker_shape_verified=false`、`ocr_text_verified=false`、`label_to_symbol_verified=false`、`symbol_to_curve_verified=false`、`independent_gold_available=false`、`cer=null`。
- 三件文件均 O_EXCL 首创，随后执行完整重算并按字节校验。检测部分交付、不受支持的图像、篡改回执与软链接；**绝不覆盖历史 v1–v5**。
- GitHub 只保留 Python 源代码、没有原书数据的合成测试、Windows 精确 HEAD 验收工作流和固定匿名状态。原书像素、OCR 文字、完整 SHA、行四边形与 HTML 仅存在 D:。
- 本阶段仅形成**可用于独立审核的证据视图**，而不是独立审核本身；当前 ChatGPT 未从本机 D: 获取到这张真实私有原图，不得声称已经读对四类图例符号。

## 准入

合成测试、真实 Windows v6 创建 + audit-only + 上游 SHA 不变及准确 HEAD 完整主 CI `validate` 均成功之后，才能标记工程交付通过。真正的图例/曲线核对需要后续独立视觉解释与来源证明；独立 gold、CER 和生产识别路由继续 UNVERIFIED / NOT_FROZEN。

本 PR 只做证据能力；不合并任何 Draft、不关闭 #161。
