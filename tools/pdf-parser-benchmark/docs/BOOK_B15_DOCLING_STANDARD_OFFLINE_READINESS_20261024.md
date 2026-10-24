# B15 第 109 物理页｜Docling Standard 模型与中文 OCR 离线试验前置条件

**目的**：真正将现有 PDF 识别架构扩展到第三组可比较候选：Docling **StandardPdfPipeline** + 中文 OCR（优先本地 Tesseract CLI）。与已完成的 Docling **NativePdfPipeline**（无 OCR、无布局/表格模型）严格分离；**不能把 Native 24 页历史完成结果算成 Standard OCR 验收**。

## 本轮预检不做的事情

- **不初始化 StandardPdfPipeline，不运行其 OCR/布局/表格模型、不下载任何 Hugging Face 或其他模型权重。**
- 不在用户 Windows 上静默 pip install，不装 Tesseract，不花费云端 API 额度，不修改历史任何一个电子书/页面样本，不输出源文、页面坐标或私有模型路径到 GitHub。
- 不以 3×3 热区的识别分歧判定 MinerU 漏字，也不宣称 OCR 准确率/CER。

## 精确原始页门禁

1. 只读审核 #150 的真实 3×3 私有报告，并沿其依赖追溯 #149/#148/#145 的匿名回执。
2. 只读审核已存在的六书 24 页 **Docling Native** 私有原始来源报告。
3. 从该报告查找唯一 B15 物理页 **109**，核对其原始书 PDF SHA 与 #150 同源 SHA，核对 `docling_native_single_pages/B15_p0109.private.pdf` 与已冻结的单页 SHA。
4. 仅在来源被证明为同一个物理 PDF 页面之后，才探查 Standard 的可用性；缺失与篡改一律 fail-closed。

## 正确的离线模型就绪定义

官方 Docling 说明：Standard 的 PDF Pipeline 需要本地布局模型文件；`artifacts_path` 可以指定预下载目录。OCR 还必须有可用的引擎及所需语言包。参见 [官方离线 FAQ](https://docling-project.github.io/docling/faq/)、[官方 Pipeline Options](https://docling-project.github.io/docling/reference/pipeline_options/)、[官方 OCR 文档](https://docling-project.github.io/docling/concepts/OCR/)。

预检检测以下证据：

- 在本机已使用的 Docling 专属 Python 环境中，包的实际版本是否与本次固定的 `2.141.0` 一致。
- Tesseract CLI 二进制与 `chi_sim`、`eng` 语言数据是否存在。
- D: 私有目录内四个**固定相对路径**有无模型权重及配置文件；对符号链接（包括路径中间父目录）、文件异常以及上限进行拒绝，不扫描其他盘、不访问网络。

**重要限制**：即使发现模型权重和配置文件，也只能得到 `CANDIDATE_ASSETS_ONLY_RUNTIME_UNVERIFIED`，绝不能假装完整的 Docling Standard 管线已初始化或成功解析。下一阶段必须实际加载固定的离线 Standard layout 权重并在同一个 B15 页解析，且保留运行版本、耗时、Markdown 私有 SHA、布局/文字/图表结构证据，才能加入三引擎横向对比。

预检报告私有位置：
`D:\ai-cognitive-pdf-benchmark-data\semantic_gate\multibook_matrix_20261023\b15_docling_standard_offline_readiness.private.json`

首次 `--write` 为 O_EXCL，后续 `--audit-only` 再验；已安装模型状态若后续发生变化，旧快照不得覆盖，应新增版本化回执。CI 公共日志只打印 `BLOCKED_*` 或候选未认证状态、B15 页码、是否冻结、`ACTUAL_OCR_PAGES=0`、零下载/零费用。

## 有效结论边界与后续操作

`BLOCKED_DOCLING_VERSION`、`BLOCKED_TESSERACT_CHINESE_ENGLISH_OCR`、`BLOCKED_STANDARD_MODEL_ARTIFACTS`：说明这次**固定探查路径/环境**的某一前置条件未满足，不代表机器其余目录不存在可用资源，不代表 Docling 引擎无法使用。

若资产只是候选而非证明完整，应在下一阶段补齐**完整权重来源目录证明、内存硬门和真实启动回执**，再做单页真实 OCR。若本地资源不足，可以在固定独立工作环境中，后续单独经预算核定的下载和模型固定流程准备；不能把离线预检当作下载授权。

本阶段新模型推理 0、下载 0、付费调用 0，所有 stacked PR 仍 Draft / Open / Unmerged。
