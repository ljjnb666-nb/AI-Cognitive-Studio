# PDF 同页正文 + 视觉图表只读审核数据包 v1

**2026-10-28 · Draft · 开发验收，不是生产功能**

## 本切片的唯一目标

在既有按需 `executeOnDemandPdfVisualReview` 中，把**同一原始 PDF 的原生正文摘要**与**视觉图表候选**放入一个来源明确、需要审核的数据包，使后续人工审核界面能够读取同页结构；不用重新设计 MinerU/RapidOCR/Docling，也不扩大五书 Benchmark。

已经存在的链路仍为：有权限的工作区用户明确同意后 → 私有 S3/MinIO 读取原书 → SHA256 + 大小校验 → 回放 write-once PDF.js route → 视觉 Gateway 受控候选 → 返回只读结构。新增的是 `reviewPacket`。

`reviewPacket` 包含：

- `schemaVersion=pdf-source-review-packet-v1` 和 `authority=SOURCE_BOUND_REVIEW_ONLY`
- 原书 SHA256、PDF 物理页号（与程序一致，为 **0-based**）、来源 PNG SHA256
- 该页 PDF.js 原生文字片段（**最多 4,000 字符／16 个非空 block**），明确 `EXTRACTED_UNVERIFIED`，并显示 `excerptTruncated`，不允许把片段视作完整全文
- 图表候选节点／边／方向或 `REVIEW_REQUIRED` 失败状态，始终保留 `UNVERIFIED` 性质
- `reviewRequired=true`、`approvedForBookIntelligence=false`、`approvedForPodcast=false`；整个 Packet 同样不允许被当成正式审核依据

## fail-closed 规则

- 图表页与 PDF.js 原生正文必须共用原书 SHA256、相同物理页，不允许混入另一本书的图表。
- 禁止把 `OCR_REQUIRED` 的页面假装是已经取到原生正文；OCR/扫描页仍需专门处理。
- 不批准 Gold，不修改 canonical SourceBlock、DocumentExtraction、PDF routing plan 或播客素材。
- 不把新增数据包写入 PostgreSQL、Redis job return value、公共 GitHub 或用户可见的生产数据。只有经过授权的按需 Worker 调用方能取得短暂内存结果；目前**还没有 UI、审核提交入口、已审核图谱持久化**。
- 视觉模型仍为 opt-in，受原 Gateway 鉴权和计费准入约束；测试仍以可控模拟 adapter 为主。不能声称调用了真实付费 GLM。
- 此数据包不等于独立 Gold。五书 Gold 仍为 0/5，CER=null，Docling 生产 OFF。

## 验收

1. worker 新增 7 项合成来源校验单测；
2. 扩展现有二页真实 PDFKit PDF → PDF.js → 图表 mock → Worker 集成测试，确认同页原文 + 有向图结构完整存在；
3. 现有 `@ai-cognitive/worker` typecheck / lint / unit 和专用 CI 检查；主 CI 按准确 HEAD 复核；
4. 只验收这一条内部只读数据通路。下一切片是审核 UI 与审核权限状态机；没有本切片证据前不跳过验收，但也不继续无限扩大 Benchmark。

**明确阶段状态**：这是“真实 PDF → 可审核结构化数据”的内部接口，不是用户已经可以在浏览器点击审核的完成品。所有变更保留 Draft，不合并。