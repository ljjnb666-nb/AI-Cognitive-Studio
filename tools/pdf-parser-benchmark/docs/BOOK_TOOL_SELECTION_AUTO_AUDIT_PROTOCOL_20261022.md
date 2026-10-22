# AI Cognitive Studio｜电子书识别工具选型：自动审查协议（2026-10-22）

## 用户授权与适用边界

用户明确要求：**Benchmark 的电子书样本选取、识别结果审查与差异归因均由 ChatGPT 完成，不再要求用户逐页手工审核。**

这项授权适用于 **离线解析器选型评测**，不等于允许把生产系统已有的 `humanVerified`、`graphVerified`、CAS 审核门禁直接改成 `true`。任何测试输出、模型推断或多数表决均不能自动伪装为经过独立人工确认的真值。

## 自动审查的证据分层

| 级别 | 取得方式 | 可做的结论 | 不得声称 |
|---|---|---|---|
| L0 实际执行证据 | 原始 SHA、工具/模型版本、耗时、异常、可重复日志 | 工具在指定页能否运行 | 识别正确 |
| L1 稳定性/一致性代理 | 同页多解析器结果交叉比较、文本/结构 hash、confidence、页码和引用完整性 | 可识别分歧和高风险页面 | CER/WER、人工真值准确率 |
| L2 AI 视觉审查 | ChatGPT 直接阅读**私有原页图片**，检验 OCR 丢字、图表坐标/箭头/标签、阅读顺序 | 有具体原图支持的定性故障与局部结构判断 | 全书完全正确、独立人类标注 |
| L3 真值可复核证据 | 公开许可/自制合成页面或具有独立已知答案的测试集 | 有依据的 CER、结构 F1、公式指标等 | 把 AI 自己输出再当无误真值 |

**不要求用户提供人工标注**：优先 L0–L2；对于需要正式 CER/F1 的结论，自己生成并验证**自制合成测试素材**或寻找可再分发的公开许可数据集，明确真值的来源。不能得到可信真值的项目写“未验证”，而非写 100% 或通过。

## 本轮实际实测

样本见 `../corpus/ebook-20261022.manifest.json`，本轮 30 次扫描 OCR 模式对照见 `../corpus/ebook-20261022.ocr-consistency-summary.json`。

- 5 本扫描 PDF，合计 10 个物理页；Tesseract 5 `chi_sim+eng`，PSM 3 / 6 / 11 各运行 10 次，**共 30 次，执行错误 0**。
- 引擎平均置信度：PSM 3 = **88.7**，PSM 6 = **84.5**，PSM 11 = **88.3**。仅为引擎自身信号，不是准确率。
- 两两全文去空白相似度平均：3 vs 6 = **0.906**；3 vs 11 = **0.944**；6 vs 11 = **0.887**。属于同一 Tesseract 模型的模式一致性代理，**不是不同 OCR 引擎间的独立验证**。
- B15 文件物理第 109 页：AI 直接查看原始图像，存在多个统计图及曲线。仅输出文字无法获得图线/坐标对应关系。
- B31 文件物理第 126 页：AI 直接查看原始图像，存在有向客户端/服务端关系图。必须识别箭头方向与连接对象；平面 OCR 不能替代图关系结构化输出。
- B15@109 同页 PSM 3 vs 6 文本相似度仅 **0.768**，PSM 3 vs 11 **0.822**：列为高优先级分歧页，不可按 OCR 平均置信度直接认证。
- 当前云执行环境中未安装 Docling、MinerU、Marker、PaddleOCR、Surya；Python 包安装源连接失败，**未运行**，不能给它们填写“失败/零分”或宣称胜出。

## 已验证的可复跑脚本

`../scripts/ebook_ocr_consistency_runner.py`

```powershell
python tools/pdf-parser-benchmark/scripts/ebook_ocr_consistency_runner.py `
  --root "D:\ai-cognitive-pdf-benchmark-data\books" `
  --manifest "tools/pdf-parser-benchmark/corpus/ebook-20261022.manifest.json" `
  --output "D:\ai-cognitive-pdf-benchmark-data\reports\ebook-ocr-modes.private.json"
```

先安装 PyMuPDF 并确认 `tesseract` 及 `chi_sim+eng` 已在本机可用。支持用 `--archive` 代替 `--root` 读取私有 ZIP。脚本不会导出原始 OCR 正文，只输出每页统计、哈希及比较值；只处理哈希匹配的文件。2026-10-22 已在 Linux CPU 沙盒**按 3+2 本分组复跑 10 页/30 次，0 错误**；**未声明 Windows 已运行**。

## 未来最佳架构评测门禁

1. Docling、MinerU 4、Marker：同页综合解析对比，先通过版本/许可证/内存资源预检，不预先指定胜者。
2. PaddleOCR/PP-StructureV3、Surya、olmOCR：中文扫描、两栏、图表及公式专项；记录有无预加载模型、下载和资源限制。
3. PDF.js/PyMuPDF/Poppler/LiteParse + EPUB 原生 OPF：保留低成本原生路径，评价阅读顺序/章节/页码/图像锚点。
4. 图形语义独立考核：图表轴、曲线、箭头、节点和关系，不允许以纯 OCR 的字符数量替代。
5. 每页必须保留 SHA、真实物理页、执行器版本和实际失败；自动结论应带 L0–L3 标签。
6. 云端付费识别 **默认关闭**。未经单独预算/调用授权，不调用 GLM 或其他计费接口。
7. 进入产品集成前需至少完成两个**不同技术路线**在同样页面上的真实比较；任何候选缺席，应保持选型待定。

## 审核状态

`BENCHMARK_AUTO_AUDIT_ACTIVE`；`HUMAN_GROUND_TRUTH_NOT_REQUIRED_FROM_USER`；`BEST_PARSER_UNDECIDED`；`PRODUCTION_VERIFICATION_GATES_UNCHANGED`。