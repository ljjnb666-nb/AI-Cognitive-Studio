# ACS 2026-10-22：电子书识别工具筛选矩阵（实测状态与许可分离）

> 本文件汇总**当前真实书页实测与待验证候选**，不是生产算法最终排名。更新日期 2026-10-22；正式部署需锁定代码版本与模型权重 digest、核验许可。扫描 OCR 字符数量不等于图表语义正确率。

| 候选 | 测试角色 | PDF / EPUB 关系 | 用户本次样本证据 | 许可证/商业部署提示 |
|---|---|---|---|---|
| PDF.js | 原生 PDF 提取基准 | PDF 优先 | 本轮**未运行 PDF.js**；已有 PyMuPDF/pypdf/Poppler 等近似用途基线不能替代 | 核验实际集成版本 |
| PyMuPDF / pypdf / Poppler | 原生文字、页面/阅读顺序 | PDF | **已实测** 24 页 × 4 文本引擎（包含 pdfplumber） | 各引擎及二进制授权独立复核 |
| EPUB OPF spine + lxml | EPUB 原生结构快速路径 | EPUB | **已实测** 21 本、974 个 XHTML spine 项 | 保留原始 EPUB 章节/图片引用 |
| **Docling** | PDF/EPUB 综合结构基准 | 官方支持两者；布局、表格、阅读顺序 | **Windows 真实 3 页通过**；2.141.0 + RapidOCR CPU，详情见下表 | 主仓库代码 MIT，模型授权按模型包独立检查 |
| **MinerU 4** | 中文复杂 PDF / OCR / 布局 | PDF 重点；是否支持更多格式按精确版本核实 | **Windows Flash 原生路径 3 页通过；Basic/ONNX `models verify` 仍失败；扫描 OCR 未运行** | 2026-04 起 MinerU Open Source License：以 Apache-2.0 为基础**附带条款**，包括在线服务标识和部分商业许可条件；不是无条件标准 Apache |
| **Marker** | PDF→Markdown/JSON 结构综合基准 | PDF 优先；附加依赖可能扩展文档格式 | 未运行 | 代码 Apache-2.0，模型权重为附加条款的 OpenRAIL-M；官方 README 对部分商业使用设置门槛。其 `--use_llm` 可触发额外远端模型调用，必须默认关闭 |
| **PaddleOCR / PP-StructureV3** | 中文扫描、表格、公式、可选图表解析 | PDF/图片重点 | **PaddleOCR 3.7.0 + PP-OCRv6 CPU，同页 3 页已实测**；PP-StructureV3 未测试 | 官方代码 Apache-2.0；具体下载权重仍需逐项核验 |
| **PaddleOCR-VL** | 轻量文档视觉语言解析对照 | 图片/PDF文档 | 未运行 | 官方提供新版本 VL 模型；应单独测 8GB VRAM/CPU 资源需求，不要仅凭参数量宣布可本机运行 |
| **Surya 2** | OCR / layout / table / reading order 专项 | PDF/图片 | 未运行 | 代码 Apache-2.0，权重 modified OpenRAIL-M，商业门槛见官方 README；新版可能依赖 vLLM 或 llama.cpp 服务 |
| **olmOCR** | 扫描复杂版面专项 | PDF/页面渲染 | 未运行 | 许可证、模型大小/本地安装仍待精确版本复核 |
| Tesseract 5 `chi_sim+eng` | 免费离线 OCR 控制组 | PDF 先渲染成图 | 10 页 × 3 个 PSM，**30 次运行、0 错误** | 当前仅测试引擎自身一致性，不是人工 CER |


## 2026-10-22：真实 Windows 同页测量（仅限样本页）

对照样本固定：B16 物理第 53 页是**原生文字 PDF**，B15 第 109 页是**扫描统计图**，B31 第 126 页是**扫描流程图**。所有输入用来源文件 SHA-256 匹配，正文和图片均保留本地私有 D 盘，公开 Actions 日志只有脱敏统计。不同引擎的任务含义不同，故不能把纯原生抽取的延时当成等质量 OCR 的胜负。

| 引擎及固定路径 | B16@53 文字/耗时 | B15@109 文字/耗时 | B31@126 文字/耗时 | 关键证据边界 |
|---|---|---|---|---|
| PyMuPDF 原生文字层 | 596 / 约 7 ms | 0 / 约 0.4 ms | 0 / 约 0.1 ms | 无扫描 OCR |
| Docling 2.141.0 + RapidOCR/ONNX CPU | 594 / 4.46 s | 110 / 2.89 s | 1,075 / 9.96 s | B16 相对 PDF 原生文字层参考 CER 0.34%；统计图/箭头语义未认证 |
| PaddleOCR 3.7.0 PP-OCRv6 CPU | 596 / 79.23 s | 222 / 30.97 s | 1,099 / 119.10 s | B16 同口径参考 CER 0.00%；纯 OCR 结果未证明阅读顺序/曲线含义；两轮页级时间基本一致 |
| MinerU 4.0.3 Flash + `--ocr-mode txt` | 596 / 2.03–2.81 s | **0** / 约 2.6–3.1 s | **0** / 约 2.6–3.3 s | B16 同口径参考 CER 0.00%；B15/B31 是不执行扫描 OCR 的负对照，**不能算扫描识别失败** |

**已审计的错误计数**：MinerU Flash 在 B15 曾把约 382,755 个 Base64 图片编码字符、B31 约 1,446,530 个编码字符误计为正文。修复后两页真正的 Flash 文字数都是 **0**，各自带有 1 个 Markdown 内嵌图片 data URI；4 项无电子书回归测试通过。旧数字不得继续引用为 OCR 文字量或模型优势。

**MinerU Basic/ONNX 状态**：4.0.3 CLI 和 `models show --small-backend onnx` 在两套模型根目录配置下可正常运行，但 `models verify --tier basic --small-backend onnx` 都退出 1；已检查的目录下未发现完整 `MinerU-4_models_onnx` 包。因此 **Basic/ONNX 模型就绪与扫描 OCR 均为 UNVERIFIED**，不准把 Flash 通过升级为 Basic 通过；后续使用离线诊断定位缺失路径，不自动下载权重或调用外部模型。

**证据链接与首次失败**：
- [同页 Docling 成功（Windows）](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39726996721)
- [同页 PaddleOCR 成功（Windows）](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39726996841)
- [MinerU Flash 字符污染修复验收](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39726060789)
- [MinerU 4 模型状态双路径诊断](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39730413995)
- [最新完整 CI 首次失败（Phase 14 移动端内容遮挡断言；单独重跑需独立核验）](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39730414173)

**选型暂定方向（假设，非正式冻结）**：保留 EPUB spine 原生结构和 PDF 原生文字的廉价快速路径；针对扫描、布局或复杂结构再按页面及证据门禁触发重量级解析；图表、表格、公式和流程关系需独立的结构化验证，不用字符数推定正确性。生产 `humanVerified` / `graphVerified` 不得由 AI 自评或合成样本替代。

## 高优先级实际比较

1. **真实中文扫描书**：MinerU vs Docling vs PaddleOCR/PP-StructureV3 vs Marker；在 `B15@109` 重点比较统计图语义、`B31@126` 比较方向/箭头关系。
2. **原生文字 PDF**：快速抽取 vs Docling/Marker 等复杂工具，看结构提升是否值得高成本。
3. **EPUB**：OPF spine 原生解析 vs Docling EPUB，重点检查目录、阅读顺序、图片锚点、脚注与引用。
4. **资源与费用**：同页冷/热耗时、系统 RAM、显存、失败、网络下载依赖、外部模型 API 次数。不得把一次端到端耗时同毫秒级纯文本层抽取硬排名。
5. **商业使用**：**代码许可 != 模型权重许可**。最终生产选型需保留具体版本、完整条款和在线服务署名要求。

## 最新官方依据（2026-10-22 查询）

- Docling 输入支持和模型许可：
  https://github.com/docling-project/docling/blob/main/docs/usage/supported_formats.md
  https://github.com/docling-project/docling
- MinerU 最新许可：
  https://github.com/opendatalab/MinerU/blob/master/LICENSE.md
- Marker 官方 README 商用与模型说明：
  https://github.com/datalab-to/marker
- Surya 2 README 与模型/商业条件：
  https://github.com/datalab-to/surya
- PaddleOCR 最新 PP-StructureV3 配置与 OCR-VL：
  https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/pipeline_usage/PP-StructureV3.en.md
  https://github.com/PaddlePaddle/PaddleOCR

**禁止提前获胜宣告**：当前用户实际书页数据只支持既有原生/EPUB/Tesseract 基线；最终组合仍需扫描 CER 真实标注、表格/曲线/箭头结构评测与部署成本。后续自动审查由 ChatGPT 完成，不要求用户逐页人工核验，且不修改生产审核权威状态。