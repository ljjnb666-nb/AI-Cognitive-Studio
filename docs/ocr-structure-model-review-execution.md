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

## 后续执行进度（2026-10-30）

- 已复用 Job 唯一 idempotencyKey 实现每 OCR receipt 一次显式授权请求，未另建任务调度系统。创建前校验 OWNER/EDITOR、receipt/原书/页/text SHA；固定一次调用和 15 分钟授权期限，并固定当时工作区视觉路由与 credential version。重复点击返回原 Job，不重置失败或不确定任务。
- 新增 OcrModelReviewEvent 及 reportedModelId 增量迁移，关联 Job、OCR receipt、Gateway invocation/snapshot，用量账本与六维判定理由；模型事件 UPDATE 被数据库触发器拒绝。当前费用标为 UNPRICED，只保留真实用量关联，不编造人民币金额。
- Worker 已接入现有 runtime dispatch/drain 生命周期，仅在 PDF_VISUAL_REVIEW_ON_DEMAND_ENABLED=true 且具有 Gateway keyring、私有临时目录时启动；默认关闭。角色/来源/期限前后重查，Job claim token fence；通过 consumeTextResult 事务消费加密回执并落库，不修改发布权威。RUNNING 不自动重试，失败/不确定结果需账本核对。
- 同一审核路由已添加带明确发送页图+OCR文本同意框的按钮，POST 必须有真实会话、相同 Origin 和来源身份；支持展示通过/拒绝/仍需复核，均无播客发布权限。尚未完成真实浏览器验收。
- 本机独立测试库已部署两个增量迁移，现共57迁移。相关 web/worker/ingestion/provider-gateway 类型检查、ingestion/worker/web lint通过。
- PostgreSQL evidence/consent 合并门11 PASS/0 FAIL，覆盖并发一次任务、撤权、错误页/text/receipt、换源和后继run；Gateway判定门19 PASS/0 FAIL。新增测试曾因把完整请求对象展开到 ORM 导致2 FAIL，已改为只提取来源四元组，原断言保持。
- 已确认完整 B03 原书在本地指定数据根，大小151,495,200字节，SHA与既有私有原书记录一致。复用 #212 的 pdf-local-range.mjs，以限定子进程内存与本地分段读取完成原书物理索引14的页图生成：715×1015、387844字节，原书SHA回执匹配；PNG仅留私有数据目录。不得把旧单页样本d844...的SHA或页号当作原书身份。
- canvas 离线直接安装遇到陈旧 registry metadata（缓存声称最新0.1.96，而锁中已有1.0.5），没有改依赖/lockfile或降版；改用此 PDF.js 已安装依赖所解析的 canvas。已实测解析与真实原书页渲染成功。

下一步最大集成问题：当前 #216 的普通导入/解析路径仍有旧的大 PDF 字节载入边界，需要精准复用 #212 已实现的 file-backed 解析/导入支持，保留现有 standard、来源 fence 和质量门禁，不能整文件覆盖不同开发链。随后完成真实原书目标页的 standard→模型审核闭环、Worker/MinIO与事件并发/重复测试、实际 Windows Edge 验收及统一CI。

外部模型调用仍未执行；必须在页图/OCR证据及账户路由可审阅后取得具体授权，不能把本轮目标文字当作原书云端发送的无限授权。目标继续active，未创建脚手架PR，未合并/部署/启用生产standard。
