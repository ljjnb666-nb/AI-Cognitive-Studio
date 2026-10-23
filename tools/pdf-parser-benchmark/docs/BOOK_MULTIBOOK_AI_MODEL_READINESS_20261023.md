# 正式 PDF Benchmark｜Docling Standard 与 MinerU 离线模型核查（2026-10-23）

## 已验收的真实基线

- 上游 Draft #138 exact HEAD `e77b1856d222a2fabd9e7c43bfb5a9ecfa89fa0e`：六本真实 PDF 的 24 个固定物理页已运行 **Docling NativePdfPipeline**，产出 99 个原生文字单元、20 个图片单元，24 次转换调用计时约 2003ms。该管道是**无模型的原生读取**，不等于完整 AI 解析。
- Draft #137 在相同语料上完成 24 页 PyMuPDF 统计、五本各一页 RapidOCR 纯本地识别 142 行 / 2831 字符。这些是输出量，**不是**有可信金标准的正确率。
- #137 最终完整 CI **FAILURE**：Ubuntu `quality-performance` 安装真实媒体/Redis CLI 工具时，`apt` 官方源下载耗尽 540 秒预算（exit 124），最终 `validate` 失败；其他核心与 Windows 真实 benchmark 通过。该失败未擦除、不得假称全 CI 通过。

## 本阶段目标与诚实边界

只读核查 **Docling Standard 和 MinerU 的本地模型资源**，为同一 24 页上的 AI 解析实测建立可证实的运行条件。

- Docling 官方 `PdfPipelineOptions.artifacts_path` 可指定**提前准备的本地**模型权重。未指定时可能自动从远端下载。故正式离线 Standard 试验必须先明确模型缓存完整性、锁定目录、禁远端服务与插件，才能真正调用。
- MinerU 4.x 使用 `MINERU_MODEL_SOURCE=local` 和独立 `MINERU_HOME` 配置，且工具、模型与 VLM 均有单独资源条件。只检查当前 Docling venv 是否安装 MinerU 不足以判断全机准备情况。
- 该阶段**不会启动 AI 模型推理**，也不会把观察到的一个权重文件冒充 “全部模型就绪”。只有下一阶段完成真实同页转换、确认来源和网络禁止，才能标为对应的 `VERIFIED`。

## 核查和隐私设计

1. 复核既有六书/24页私有来源 Manifest + SHA 证据，避免离开正式语料。
2. 在有限且明确的 D 盘私有目录（`tool-env`、`models`、`model-cache`、`hf-cache` 等）以及用户默认的 `~/.mineru`、`~/.cache/huggingface/hub` / 指定环境变量目录下**只读**查找疑似模型权重文件。最多递归五层、2200 个目录、4500 个文件；超界明确 `BOUND_EXCEEDED`，不把部分扫描冒充完全覆盖。
3. 仅汇总按引擎类别的模型疑似文件**数量与大小**，不上传文件名称、真实路径、原始书页、PDF SHA、模型文件 SHA、真实 OCR 原文、节点内容或缓存数据。
4. 当前解释器已安装包版本仅存于私有 JSON。即使搜出模型候选文件，也固定 `MODEL_COMPLETENESS_NOT_ATTESTED`，不能当作已通过 Standard/MinerU 的实机推理。
5. 只写一次私有 `D:\ai-cognitive-pdf-benchmark-data\semantic_gate\multibook_matrix_20261023\multibook_ai_model_readiness.private.json`，严格 `O_EXCL`，已存在时只读审核。完全不改现有 PDF、RapidOCR、Docling Native、B15/B31 原请求回复及候选等历史记录，Windows CI 对全部源文件及所有单页 PDF/PNG 做执行前后 SHA 对账。
6. 不安装模型和软件、不发起 HTTP 模型下载、不注入任何付费 API Key。

## 交付结果的解释

可能的状态只有：扫描范围内未发现权重候选，或发现候选**但完整性尚未验证**。这不意味着真正的 MinerU/Docling 模型已经运行，更不能排名工具。

未来依次推进：真实权重内容与版本锁定 → 离线 Standard/MinerU 同页实测 → 多书 OCR、表格、图形与公式的独立 reference → 准确率、吞吐、CPU/GPU、成本和错误恢复综合评估。

全部 stacked PR 保持 Draft/Open/Unmerged，未经用户授权不合并。已知 CI 首次失败、retry 和 Node20→24 弃用 warning 必须保留。
