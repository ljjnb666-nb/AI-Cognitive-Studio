# B15 第 109 物理页｜首次真实 Docling Standard 离线版面模型试跑

## 背景与已有证据

- #150：同源 PDF 中 RapidOCR 与 MinerU Basic 差异最大集中在原始页面下中部，九宫格 R3C2 为 8/9 条 OCR 行低/零匹配，但不能当成漏字证据。
- #151：Docling Standard + Tesseract 路线在当前环境下因中文/英文 OCR 依赖检查未满足而阻碍；这是就绪探针结果，不是 Standard 解析结果。
- #152：Docling Standard + RapidOCR 在**当前 Docling 虚拟环境**下缺少固定版本 `rapidocr==3.9.2`；即使另一套 RapidOCR 环境有权重，也不可宣称同一环境已准备好。
- 在 #152 就绪清单中，**有一个**候选本地布局模型目录包含权重/配置。候选不等于布局模型可成功装载。

本轮开始运行真正的 Standard 布局模型，将 OCR 单独关闭，以免混合解析模型与 OCR 依赖缺失。此举主要确认当前离线布局 pipeline 是否可用，**不提供第三引擎 OCR 输出或准确率**。

## 运行协议

新增 `ebook_b15_docling_standard_layout_real.py`。

1. 完整只读审计 #152 RapidOCR fallback v2 已冻结报告和六书 24 页 Docling Native 源 SHA；锁定 B15 第 109 物理页的**同一个原始 PDF SHA / 已切单页 PDF SHA**。
2. 从 #151 固定四个私有候选模型目录中选一个唯一含候选权重和配置的目录；若为零个则 BLOCKED，若有多个则拒绝隐式选取；拒绝任意符号链接或路径逸出。
3. 只执行一次 `Docling StandardPdfPipeline` 转换：`PdfPipelineOptions(artifacts_path=<固定目录>, do_ocr=False, do_table_structure=False, enable_remote_services=False, allow_external_plugins=False)`。固定 CPU 2 线程，输入只有 B15 单物理页 PDF，严格禁用远端下载（HF_HUB_OFFLINE、TRANSFORMERS_OFFLINE、坏地址代理），实际转换最多 150 秒。
4. 通过单独 Python worker 捕获 Docling 的所有标准输出、错误，**仅写回 D: 私有日志文件**，不在公开 CI 打印模型路径、stacktrace、书名或识别内容。
5. 如实际 Standard 解析成功，保存全量 Markdown 仅在 D: 私有 worker 文件中；公开只展示状态、OCR=0、耗时、字符数、版面文本/图片/表格对象计数。注意 `do_table_structure=False` 只表示禁用表格结构模型，并不保证不会出现表格对象。
6. 如模型不足、API 不兼容或超时，**保存原始异常到 D:**，公开返回 `BLOCKED_STANDARD_LAYOUT_RUNTIME_PRIVATE_ERROR` 或 `BLOCKED_STANDARD_LAYOUT_RUNTIME_TIMEOUT`，不能在此时宣称 Standard 模型可用。
7. 报告 `b15_docling_standard_layout_real.v3.private.json` 首次 O_EXCL 独占创建，后续 `--audit-only` 不再次推理，只核验来源身份、已存 worker 文件 SHA 与报告完整性。因模型推理有非确定性/运行耗时差异，禁止把重新运行得到的报告逐字对比视为自动通过。
8. 正式验收必须是 exact-head Ubuntu synthetic + owner-only Windows 真实试跑 + 原主 CI。**CI 通过表示执行协议成功，不表示一定成功装载模型**；必须进一步检查 `ACS_B15_LAYOUT_STATUS` 为真实成功状态才能对外称“实际布局模型已运行”。
9. 不覆盖任何 #148～#152 私有回执，不自动安装依赖，不下载模型/源电子书，也不合并任何 Draft PR。

## 后续

如果实际布局模型成功，下一片才讨论建立**单独隔离环境的 Docling Standard + RapidOCR**；先确认版本/API 兼容、独立权重 SHA、内存与 CPU 预算，再在完全相同的单页上运行真实 OCR 和版面。若版面模型失败，则根据**保存在 D: 而不是公开日志中的异常**提出针对性安装或权重修复，不继续无意义的元数据诊断。
