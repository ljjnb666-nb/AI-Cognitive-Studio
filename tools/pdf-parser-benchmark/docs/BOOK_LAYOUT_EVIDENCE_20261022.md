# Windows PDF 版面证据：Docling × PaddleOCR（2026-10-22）

本次在选型 Benchmark 中新增匿名版面统计，所有私有 PDF、扫描图片、OCR 正文和框坐标均只在 Windows 私有 D 盘处理，不提交到 GitHub。

## 真实报告新增字段

- PaddleOCR 3.7.0：识别文字框数、检测多边形数、识别多边形数、识别置信度条数、低于 0.6 的框数、平均识别置信度（无对应输入时为 null）、框与识别文本数量是否一致。
- Docling 2.141.0：文本对象、图片对象、表格对象、分组对象数，以及具有来源定位信息的对象数。
- 两者均固定 `graph_relationships=0`、`graph_semantics=UNVERIFIED`：只说明**此统计器没有产生图关系**，绝不证明图中没有箭头或图表关系。

## 验证和安全界限

- 所有报告仍用来源完整文件 SHA-256 选取 B15@109、B16@53、B31@126。
- 在真实 Windows Runner 上运行已有 Docling/PaddleOCR 解析流程，逐页输出匿名版面计数、文字总量和时长；禁止输出原书文字与多边形具体坐标。
- 新增独立 Linux 合成单测，涵盖隐私剥离、缺失置信度、NaN、越界置信度、识别框数量错配、缺失可选 Docling 对象等。
- 实书版面证据用于判断后续需要哪些区域提取与箭头、坐标轴、曲线追踪步骤，不能用对象数、OCR 字符数或置信度直接证明语义正确。
- 与 `ebook_semantic_structure_gate.py` 的 L2 视觉参考比对必须等到某个候选引擎真实输出**有方向的结构关系**。此前继续标记 `UNVERIFIED`，不修改生产 humanVerified/graphVerified。
- 许可证、硬件开销与资源保护规则沿用原有 Benchmark；不调用付费模型。

## CI 注意事项

专项合成门禁通过并不代替 Windows 实书测试；所有状态必须采用准确 HEAD 的工作流结果。保留首次失败、重试、资源与 Node 版本警告。
