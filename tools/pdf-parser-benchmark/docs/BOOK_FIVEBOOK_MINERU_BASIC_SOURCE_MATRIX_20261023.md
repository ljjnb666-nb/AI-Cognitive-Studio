# 正式电子书识别 Benchmark：五本真实 PDF 同源 OCR 对照（2026-10-23）

## 严格复用既有来源

此前已确认的完整 Manifest 是 **27 本（6 PDF + 21 EPUB）**，其中 6 本 PDF 已固定 24 个物理页，OCR 标记页共 10 个。此切片在此批次中选用 **B03、B08、B15、B29、B31** 五本书，每本的**第一个已标注 OCR 页**，不再新增样本、不改变页码。

- #137：五个原始 PDF 页已运行真实 **RapidOCR CPU**，合计 142 行、2831 个原始输出字符；每页私有结果/毫秒数/SHA 已在 D:。
- #138：相同来源的 24 个单页原 PDF 已被真正 **Docling NativePdfPipeline** 读取；该管道无布局/OCR 模型，不能作为完整 Docling AI 的排名。
- #141：MinerU 4.0.3 的原有 **Basic ONNX** 权重通过官方 `models verify --tier basic --small-backend onnx`。
- #142：B31 物理第126页 **MinerU Basic OCR 真推理成功**，耗时 17.263 秒，私有 Markdown 原字符数 106990。
- #143：经独立结构审查，此 106990 字符中 **105815 个来自1个 Base64 编码图片 Data URI**，剔除可识别图片负载后的非空白 Markdown 结构残留为 **1144 字符**，不等于 1144 个正确 OCR 字符。

## 当前 PR 的真实新增执行

只对**另外四本 B03/B08/B15/B29**各一个正式已固定 OCR 物理页执行：

`mineru-kit parse <SHA固定的原始单页PDF> -o <新的D盘私有Markdown> --tier basic --ocr-mode ocr`

严格复用旧 MinerU 4.0.3 exe + 已缓存的8个 ONNX 权重，全部设置 local source、onnx、CPU table backend、断开的 HTTP/HTTPS/ALL_PROXY；**不安装/下载任何模型、不调用付费 GLM**。

执行之前，逐页复核三条来源证据：原 6 PDF/24页 Manifest 与单页真实 PDF SHA、RapidOCR 对同一物理页所使用 PNG/源 PDF SHA、Docling Native 裁切单页 PDF SHA；任何错页或缺书均不进入模型。

- **B31 的成功推理绝不重做**，只读复用它原来经 SHA 锁定的 Markdown 与结构审计。
- 新四本按固定 B03 → B08 → B15 → B29 逐本串行推理，每本最多 900 秒。一页失败立即停止，保留该页私有日志/部分输出；重跑遇部分失败必须拒绝覆盖，不自动继续或修饰首次失败。
- 每本第一次成功必须满足 CLI 退出0、非空 Markdown、原始单页/模型 SHA 前后相等、同源 identity 与私有只读复验。对每页计算 Markdown 原始字符、可识别 Base64 图片负载、非空白非图片残留、真实调用毫秒；**它们是输出量/结构数量，不是 OCR 正确字数**。
- 四本成功后生成私有五页对照表，记录每页 RapidOCR 行数/原字符数/毫秒数与 MinerU Basic 原字符数/Base64/残留/毫秒数。B31 项显式 `REUSED_PRIOR_SUCCESS_NOT_REINFERRED`，其余四项显式 `NEW_BASIC_ONNX_REAL_SOURCE_PAGE`，避免双重计费或错误样本扩张。

## 仅在私有 D 盘生成

`D:\ai-cognitive-pdf-benchmark-data\semantic_gate\multibook_matrix_20261023\`

每本独立 `fivebook_mineru_basic_BXX.private.{md,log,json}`，另有 `fivebook_mineru_rapidocr_comparison.private.json`。所有文件独占首建 O_EXCL，已有报告仅做身份与 SHA 校验；**绝不把原 PDF、图像、Base64 payload、OCR 原文、SHA、模型/用户路径、API Key 上传 GitHub、Actions artifacts 或 CI 日志**。

Windows CI 在四本运行前/后保留此前的 B31 两轮失败、成功 Basic OCR、结构审计、RapidOCR、Docling Native、源书及24个单页 PDF 的 SHA。新增 Ubuntu 合成测试应验证五本同源对账、四本恰好各跑一次、B31 不重跑、错页失败、部分失败日志不被覆盖、伪造质量 gold 拒绝、缺页不能创建汇总。

## 不能宣称的结论

- **不是五书 CER 排名**：RapidOCR 字符数与 MinerU Markdown 残留量仍是不同的观测量；没有独立原始逐字 reference，就不能算 OCR CER/WER/precision。
- **不是全面 MinerU/Docling 选型**：本阶段的五页 MinerU 是 Basic OCR，Docling 的24页仍是 Native 无模型管道，完整 Standard 版面/公式/表格模型尚未同页验证。
- **不是 PDF 全量完成**：24 页原生来源检测与五页 MinerU 不代表全部 10 个 OCR 重点页、21 EPUB 均通过。
- **图结构与箭头方向**依然无独立金标准，B31 的 V-tip 与文字框有显著混淆，Graph F1 必须保持 UNVERIFIED。

所有 PR Draft/Open/Unmerged，未经用户明确批准不得合并。保留 #137 apt 540 秒首次失败、#139 模型探测误报、#140 两轮 MinerU DocLib 真失败、Node20→24 Actions warnings。