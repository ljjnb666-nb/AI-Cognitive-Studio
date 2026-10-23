# 2026-10-23｜B31 第126物理页 RapidOCR 离线真实文字观察

## 真实前置事实

- 上游 Draft #134 HEAD `9674147458a5ad841b520370af1f9fd75544eb7b`：B31 原始扫描页的离线 OCR preflight 在真实 Windows Runner 检查出 `NO_OFFLINE_OCR_ENGINE / PACKAGE_NOT_INSTALLED`。合成20/20通过且 Windows私有安全门通过，但**没有运行任何 OCR**，日志里的0字不得解释为原图无文字。
- 这一次新增**隔离部署及真实 OCR 推理**。所有原始电子书、GLM 回复和 5节点4边暂定候选继续保存在 D:\ 私有，**不可上传 GitHub**；原先 B15 未知收费、B31 付费历史都不重复。

## 可复现离线架构

依照 RapidOCR 官方发行文档：统一包 `rapidocr` 接替长期停止维护的旧 `rapidocr_onnxruntime`；RapidOCR 3.9.2 与 ONNXRuntime CPU 1.22.1 + NumPy 2.2.6 在真实 Windows CPython 3.13 x64 环境可使用预编译 wheel。**仅在新建 D: 隔离虚拟环境中**安装：

`D:\ai-cognitive-pdf-benchmark-data\tool-env\rapidocr-3.9.2-onnx-1.22.1\Scripts\python.exe`

Windows 的 Docling 2.141.0 既有环境不得污染、升级或删改。安装时允许从官方 PyPI 下载 Python wheel（这是安装依赖，不是上传原书/调用模型），必须全量 `--only-binary=:all:`，固定 RapidOCR/ONNXRuntime/NumPy 三个核心版本。模型权重必须在已安装的 `rapidocr/models/*.onnx` 中，开始识别前检查 `det`、`rec` 至少各一个有效文件并计算 SHA；若包或权重缺失，fail-closed，**不允许运行会自动访问网络取模型的 API**。OCR 运行时封锁 HTTP/HTTPS/ALL_PROXY，并关闭任何云端 provider，使用预装 ONNXRuntime CPU。

注意：这里的“离线”指对用户 PDF 识别时**没有网络请求**。初次隔离安装 wheel 是允许联网的准备步骤，不能宣称从来没有网络访问。

## 输入、输出与认证

仅从 SHA 固定的源 B31 第126物理页 PNG 读取像素；使用统一包 `RapidOCR()` 的 `RapidOCROutput.boxes/txts/scores` 属性，验证真实文本行数、文字/置信度、四点坐标和页边界后保存：

`D:\ai-cognitive-pdf-benchmark-data\semantic_gate\b31_source_rapidocr392.private.json`

新报告名必须区别于 #134 的 `b31_source_offline_ocr.private.json`（该旧报告准确记载上一步模型缺失）；不可以修改或覆盖旧历史。所有具体 OCR 文字、图节点标签、坐标、源 PDF SHA、模型文件 SHA 均仅留在本机 D:\ 私有 JSON，CI 只能输出匿名**行数和字符数**。此工具从不读取 GLM 图 candidate/request/reply，不发起付费推理。

只读预览→O_EXCL 独占一次私有创建→审计回读；如果已有完整结果则只读审计，不得重复推理；若已有残缺证据则保留现场拒绝。对原始书页/元数据、所有像素判别、#134 缺少模型的真实探测，以及 B15/B31 历史请求回复与 GLM 暂定候选**至少 16 件私有文件**做前后 SHA 不变验证。

此 OCR 观察**不是 OCR CER 的独立 gold**，也不能判定图的真实箭头或方向。无论是否有字，`ocr_quality_gold=null`、`independent_graph_gold=null`、`arrow_direction_verified=false`、`certified_graph_f1=null` 必须保持。正式确定最优图文识别架构还需跨多书、多页、OCR/版面/图节点金标准及 Docling/MinerU 并排实测。

## CI 管控

- Linux仅对合成图/模拟 RapidOCROutput 跑新10+旧10测试，永不下载真实书或运行模型。
- Windows owner-only exact PR branch，先安装仅三个指定核心包的隔离 venv，再封锁 OCR 期间网络，确保 SHA 私有读写与文档里的可复现状态。
- 记录首次失败、网络 retry、依赖下载/资源 warning 和 Node20→24 Actions 弃用 warning。所有堆叠 PR 保持 Draft/Open/Unmerged，未经用户明确授权不得合并。

## Python 3.13 真实安装兼容性修复

Windows Runner 的 Docling 缓存解释器实际上运行 CPython 3.13，因此先前固定的 `numpy==1.26.4` 缺少 CPython 3.13 Windows wheel；在保留 `rapidocr==3.9.2`、`onnxruntime==1.22.1` 后，将全新隔离 venv 的 NumPy 固定为 `numpy==2.2.6`（官方 PyPI 已有 cp313 win_amd64 wheel）。仅 Ubuntu Python3.12 **合成测试**仍使用 NumPy 1.26.4。PySocks 引导 SHA 固定、所有首次失败与网络 warnings 继续在 PR #135 评论归档。
