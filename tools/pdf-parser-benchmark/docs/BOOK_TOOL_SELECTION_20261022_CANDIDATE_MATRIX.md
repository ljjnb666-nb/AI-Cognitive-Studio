# ACS 2026-10-22：电子书识别工具筛选矩阵（实测状态与许可分离）

> 本文件为**选型调查**，不是用户书页上的实测排名。查询日期 2026-10-22；正式部署应锁定版本/权重 digest 再复查相应许可证。

| 候选 | 测试角色 | PDF / EPUB 关系 | 用户本次样本同页实测 | 许可证/商业部署提示 |
|---|---|---|---|---|
| PDF.js | 原生 PDF 提取基准 | PDF 优先 | 本轮**未运行 PDF.js**；已有 PyMuPDF/pypdf/Poppler 等近似用途基线不能替代 | 核验实际集成版本 |
| PyMuPDF / pypdf / Poppler | 原生文字、页面/阅读顺序 | PDF | **已实测** 24 页 × 4 文本引擎（包含 pdfplumber） | 各引擎及二进制授权独立复核 |
| EPUB OPF spine + lxml | EPUB 原生结构快速路径 | EPUB | **已实测** 21 本、974 个 XHTML spine 项 | 保留原始 EPUB 章节/图片引用 |
| **Docling** | PDF/EPUB 综合结构基准 | 官方支持两者；布局、表格、阅读顺序 | 未运行新书同页 | 主仓库代码 MIT，模型授权按模型包独立检查 |
| **MinerU 4** | 中文复杂 PDF / OCR / 布局 | PDF 重点；是否支持更多格式按精确版本核实 | 有历史独立 MinerU Benchmark；**未运行本轮新书同页** | 2026-04 起 MinerU Open Source License：以 Apache-2.0 为基础**附带条款**，包括在线服务标识和部分商业许可条件；不是无条件标准 Apache |
| **Marker** | PDF→Markdown/JSON 结构综合基准 | PDF 优先；附加依赖可能扩展文档格式 | 未运行 | 代码 Apache-2.0，模型权重为附加条款的 OpenRAIL-M；官方 README 对部分商业使用设置门槛。其 `--use_llm` 可触发额外远端模型调用，必须默认关闭 |
| **PaddleOCR / PP-StructureV3** | 中文扫描、表格、公式、可选图表解析 | PDF/图片重点 | 未运行 | 官方代码 Apache-2.0；具体下载权重仍需逐项核验 |
| **PaddleOCR-VL** | 轻量文档视觉语言解析对照 | 图片/PDF文档 | 未运行 | 官方提供新版本 VL 模型；应单独测 8GB VRAM/CPU 资源需求，不要仅凭参数量宣布可本机运行 |
| **Surya 2** | OCR / layout / table / reading order 专项 | PDF/图片 | 未运行 | 代码 Apache-2.0，权重 modified OpenRAIL-M，商业门槛见官方 README；新版可能依赖 vLLM 或 llama.cpp 服务 |
| **olmOCR** | 扫描复杂版面专项 | PDF/页面渲染 | 未运行 | 许可证、模型大小/本地安装仍待精确版本复核 |
| Tesseract 5 `chi_sim+eng` | 免费离线 OCR 控制组 | PDF 先渲染成图 | 10 页 × 3 个 PSM，**30 次运行、0 错误** | 当前仅测试引擎自身一致性，不是人工 CER |

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

**禁止提前获胜宣告**：当前用户实际书页数据只支持既有原生/EPUB/Tesseract 基线；真正最佳组合仍待其他引擎同页执行。后续自动审查由 ChatGPT 完成，不要求用户逐页人工核验，且不修改生产审核权威状态。