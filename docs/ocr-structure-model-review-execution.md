# 结构证据与模型审核闭环：执行记录

当前：开发中，目标仍 active，尚未形成完整产品验收，不宣称完成。

## 基线与集成决策

- #216 仍为 Draft/Open，HEAD 43a55ecfca01b2a63261bc82a500d60cf3b9ff31；原 OCR 执行链保持不变。
- #209～#212 仍是另一条未合并链，#212 HEAD 51493aeb1f4ac47eeec54f76d0dff431e24eceac。没有 merge、rebase 或改写历史。
- 复用当前干净 managed worktree，在新分支 codex/ocr-structure-model-review 开发，不创建重复 worktree。
- 原审核链仅接受 SUCCEEDED + currentExtraction，且视觉候选仅针对 native/mixed 页面；standard 被质量门保留为 OCR_REQUIRED，因此不能直接复用其状态判断或为展示而发布 canonical extraction。
- 选择按文件移植必要已有能力：#209 的相同审核路由及只读投影，#212 的 SHA/ETag 受控 Range 预览，既有 Gateway 视觉能力与端点/身份/预算校验。未搬入 Docling/RapidOCR、Benchmark 工具或自动后台视觉调度。
- pending OCR 从现有不可改写 execution receipt 与 content-addressed artifact 读取；不新增另一份 SourceDocument/SourcePage/SourceBlock 或发布权威。模型判定独立于原人工事件；持久化与显式一次性授权仍在接入。

## 当前代码与证据

- ingestion/ocr-structure-review-evidence.ts：核对当前最新 run、OCR_REQUIRED、源 document/blob 身份、plan 摘要、page claim、actual standard 回执、模型摘要和 artifact SHA；跨对象 IO 重新核验。没有复活执行租约或写 canonical。
- 原审核路由对 pending OCR 显示来源、物理页号、actualTier、模型身份及输出片段；受控原书 URL 额外绑定 SHA。阅读顺序仅标输出序列；bbox/表格/图表/公式细节明确 UNKNOWN。未完成真实 Edge 验收。
- Gateway 复用 PDF_VISUAL_STRUCTURE；独立 OCR review 请求同时包含原始 PNG 和 OCR 输出，绑定 PDF SHA/物理页/文本 SHA/receipt ID。六个维度 text/readingOrder/tables/charts/formulas/hallucination 必须逐项给证据理由；ISSUE→REJECTED，UNKNOWN→REVIEW_REQUIRED，全部 CLEAR 才是 PASSED。任何模型判定均无播客发布权限。
- 当前模型调用器尚未接到产品动作。未发送私有 PDF/页图/正文至外部模型，未消耗付费审核授权。

已执行：

- Gateway 视觉协议及独立模型结果验证：19 PASS / 0 FAIL。
- 新 evidence PostgreSQL 集成：8 PASS / 0 FAIL（真实数据库，合成 execution receipt 和存储流，不冒充真实 OCR/MinIO）。覆盖跨书/页/工作区、换源、对象替换、后继 run。
- 复用原页 Range/展示门：12 PASS / 0 FAIL。
- ingestion/provider-gateway/web/storage typecheck，通过；ingestion/provider-gateway/web lint，通过。
- 初次移植漏导出导致视觉测试 6 FAIL，补齐既有 export 后 8/8；新 PostgreSQL 后继 run 夹具误复用 unique jobId 导致 1 FAIL，改为独立 Job 后 8/8；测试存储流需 Promise<AsyncIterable>，修正类型后 typecheck 通过。没有降低断言。

## 接下来完成同一个纵向切片

1. 一次性、来源/页/receipt 绑定的授权与费用边界；独立模型事件、Gateway invocation/snapshot/usage 关联；并发、重复、权限撤销和过期来源提交 fence。
2. 复用原有视觉 Worker、页面动作和审核机制，避免图表抽取成功冒充 OCR 质量通过。
3. 导入真实私有 PDF，重新执行已验收 standard，从产品页查看原页与结构、触发获授权的真实模型审核、保存证据并验证零未经授权播客素材。
4. PostgreSQL/MinIO/Worker 和真实 Windows Edge 验收；全仓回归/构建/准确 HEAD CI；单个完整 Draft PR。

保留生产 standard 默认关闭。不要把本记录或接口/字段当成交付完成；本轮结束条件仍是用户要求的完整产品闭环。尚未创建新 PR，避免提交仅有脚手架的独立 PR。
