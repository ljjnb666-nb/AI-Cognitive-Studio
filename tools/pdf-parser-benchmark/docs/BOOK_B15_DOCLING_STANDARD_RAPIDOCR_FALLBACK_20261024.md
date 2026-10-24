# B15 第 109 页：Docling Standard + RapidOCR 备用离线候选

## 背景与真实证据

在 #151 的 Windows 真机预检中，已冻结并重新验收同一 B15 原始 PDF 第 109 物理页；Tesseract 路线返回 **`BLOCKED_TESSERACT_CHINESE_ENGLISH_OCR`**。这不代表 Docling Standard 不支持中文，也不代表必须下载另一份 OCR 识别模型。

Docling 官方支持通过 `RapidOcrOptions` 为 StandardPdfPipeline 选择 RapidOCR / ONNXRuntime，并允许显式指定 `det_model_path`、`rec_model_path`、`cls_model_path` 等本地模型路径。参见 <https://docling-project.github.io/docling/reference/pipeline_options/>、<https://docling-project.github.io/docling/getting_started/installation/>。

## 本切片只调查本机兼容性，暂不运行模型

新增 `ebook_b15_docling_rapidocr_fallback.py`：

1. 重新 `--audit-only` 验证 #151 冻结的 B15 同源页面与本机依赖清单；Docling Native 依旧与 Standard 严格区分。
2. 在实际运行 Docling 的**同一个 Python 环境**里验证 RapidOCR 3.9.2 和 ONNXRuntime 1.22.1 的包版本；不会凭另一套隔离环境已运行过 RapidOCR 就假定当前虚拟环境可直接导入它。
3. 只读取安装包中已经存在的 `det`、`rec` ONNX 权重**数量与有无**，不能复制模型、自动下载或初始化 OCR 引擎。
4. 从 #151 的本地快照中取出 Standard 布局模型文件候选数量，独立判断布局前置条件；候选权重、配置齐全仍**不能自动视为缓存完整、Standard 已成功启动**。
5. 状态分级：Docling/ RapidOCR/ONNXRuntime 版本不符、缺包、缺 OCR det-rec 模型、缺布局候选或仅存在待实测候选。`CANDIDATE_ONLY_STANDARD_PIPELINE_RUNTIME_UNVERIFIED` 也**不是成功识别**。
6. 独立 v2 私有报告 `b15_docling_standard_rapidocr_fallback.v2.private.json` 使用 O_EXCL 首次创建、audit-only 重算，旧 #151 回执绝不覆盖。
7. GitHub 仅输出公开数值的候选状态和 Standard layout **候选数**，不泄漏原始书页、模型绝对路径、private SHA、OCR 文字与图片。

## 后续真实对比准入

当本次预检确认 RapidOCR 与布局模型候选条件具备后，方可开启受限的实际 StandardPdfPipeline 同页转换实验。需要在 D: 私有目录固定 layout 权重、启用离线环境、限制内存和运行时间，并记录单页 Standard 的真实耗时、布局对象数量与规范化文字差异（不是 CER）。未取得独立人工或可核对出版社原文之前，不能判定哪套引擎更准确。

本轮：**零模型推理、零下载、零付费调用**。用户未授权合并前，所有堆叠 Draft PR 保持未合并。
