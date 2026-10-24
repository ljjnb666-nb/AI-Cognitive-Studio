# B15 物理第 109 页｜Docling Standard + RapidOCR 真实联合执行门禁

## 背景事实

上游 Draft #153 已在 Windows 本机成功初始化 **Docling StandardPdfPipeline** 的本地版面模型；关闭 OCR 时，B15 p109 输出文字对象 0、图片对象 2、表格对象 0、Markdown 30 字符，布局转换 13,003ms。此事实是**真实版面试验成功**，**并非 OCR 成功**。

#152 在当前 Docling Python 虚拟环境检测到 RapidOCR 3.9.2 不满足固定版本要求。但过去另一隔离 RapidOCR 已在相同来源书页工作过。本阶段尝试**不安装新的软件、不下载权重、不修改已有虚拟环境**地复用 D: 本地已存在的 RapidOCR 与 ONNXRuntime 软件及其随包权重，组合成真正的 Standard + RapidOCR 一页离线试验。

## 执行方案

- 代码：`ebook_b15_docling_standard_rapidocr_real.py`。
- 先审核 #153 成功的冻结 v3 Standard layout 私有记录，校对 B15 物理第 109 页单页 PDF SHA 与所有 #152/#151/#150 旧来源；任何输入变化一律拒绝。
- 仅扫描私有 `tool-env` 目录直属前 64 个候选 Python venv 的 `Lib/site-packages`；找到某个环境的 **`rapidocr==3.9.2`、`onnxruntime==1.22.1`** 和包内 det/rec ONNX 权重才能采用。所有路径必须在 D: 私有根内且不得是符号链接；多套匹配的环境返回歧义拒绝。只取必要 SHA 保存在本地私有报告。
- 通过已成功运行 Docling 的 Python 解释器启动**新的子进程**，通过仅作用于该子进程的 `PYTHONPATH` 注入独立 RapidOCR 目录；**不向任何虚拟环境安装/写入包**，也不改全局环境变量。
- 使用与 v3 相同的本地布局模型路径，`PdfPipelineOptions(do_ocr=True,do_table_structure=False,enable_remote_services=False)`，明确 `RapidOcrOptions(lang=['ch'],backend='onnxruntime',force_full_page_ocr=True)`，最多一页、CPU 2 线程、165s 子进程超时。
- 强制 HF/Transformers/Datasets 离线，代理指向本机不可用端口，禁止调用远端服务或下载权重。如果跨 venv 的动态库/依赖不兼容，运行状态必须是 BLOCKED，并将异常**只保存私有 D: 日志**，不能冒充 OCR 成功。
- 真正转换成功时才写 `REAL_STANDARD_PLUS_RAPIDOCR_SUCCESS`，并在本地保存完整 Markdown；GitHub 只打印是否成功、识别对象数、规范化字符数、耗时、零云端调用。**规范化字符数量不是 CER、不是正确率、不能选出赢家**。
- 新 v4 记录 `b15_docling_standard_rapidocr_real.v4.private.json` 首次使用 O_EXCL，不允许覆盖。后续 `--audit-only` 只核验 SHA，不重复推理。私有 worker JSON 和运行日志也单独冻结。
- 对完全不存在可复用环境、多套候选、模型加载错误、运行超时，明确保存失败状态；CI 可以证明协议执行正确，**只有实际状态 `REAL_STANDARD_PLUS_RAPIDOCR_SUCCESS` 才意味着第三路 OCR 真正执行**。

## 限制和后续

新工作流要求准确 HEAD 的 Ubuntu 合成测试及 Windows Owner-only 单页真机运行，还需主 CI 完整通过；现有 Draft PR 不得擅自合并。本轮不用云端 API，不上传电子书、不安装依赖、不下载模型。

如无法跨环境导入 RapidOCR，下一阶段才在独立 D 盘新目录构造 SHA 固定的版本兼容环境，不能直接破坏已经验收的 Docling venv 或复制未知来源权重。如真正成功，应再与现有 RapidOCR、MinerU 原页字符串做盲式私有数值对比，并据此选择是否引入独立参考文本进行 CER 评估。
