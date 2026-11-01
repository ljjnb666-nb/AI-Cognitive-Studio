# PDF 同页正文＋图结构只读核验包（2026-10-31）

## 目标及范围
基于已经合并到 main 的 #225–#227，从当前已经成功发布的 DocumentExtraction、SourcePage、SourceBlock 和限时 PdfVisualReviewCandidate 构建**可被独立模型审核器消费**的同物理页、同源证据包。避免重复移植旧堆叠 Draft #208，也不创建新 OCR/视觉模型执行器。

新增：登录后 GET `/api/studio/pdf-visual-review/[sourceDocumentId]/review-packet?page=0`（0-based 物理页）；原有 Studio 书籍来源核对页增加“查看本页核验包 JSON”入口。浏览器和 API 均不调用外部模型。

## 契约与边界
- `pdf-source-graph-review-packet-v1` 只包含当前工作区、当前已成功解析记录、当前成功 ingestion run、generation、当前物理页和原书 SHA 的来源身份。
- 只读当前 SourceBlock（最多 **16 块／合计 6000 字**，超过必须显式设置 `sourceTextPreviewTruncated`）；绝不把截断片段当完整书页。
- Graph 来自已经持久化、未过期、摘要校验正确、当前 run/generation/物理页/原书 SHA 绑定的候选。缺候选返回 `NO_VISUAL_CANDIDATE`，不等于确认原书没有图表。损坏候选 fail closed。
- 每个包始终 `independentModelReviewStatus=NOT_REVIEWED`、`publishable=false`、`approvedForPodcast=false`；独立核验**必须另外读取原始 PDF 物理页图像**。这一接口本身不做模型审核、Gold 标注、质量评分、批准或播客发布。
- 严格禁用开发身份回退：Better Auth 每次获取 `disableCookieCache=true` 的真实会话，必须匹配当前 Workspace identity，实时核验 Membership；未授权用户不得看到正文或图结构。
- GET、no-store；没有 POST，不写入数据库、S3 或队列，不产生 API 费用；不用新迁移或新环境开关。

## 验收
- 真实 GitHub 代码分支在最新 main 的 merge commit 上增量开发，旧 PR #208 保留不合并。
- 纯投影测试覆盖同源图结构、缺图不误判、超限截断、损坏或过期候选拒绝、权限与只读 API 契约。
- 需要准确 HEAD 的 Lint、TypeScript、Web 集成、主 CI；仍待用私有五书 B03/B15 等真实书页和真实 Edge 进行效果验收，不应把这些测试说成完成。

## 下一切片
真正的“独立模型审核”需要在该包基础上新增独立的视觉来源比较、结果状态机、用量账本与自动发布禁止门禁；在真实来源和可度量质量没有证据前不允许把这个包送入 Book Intelligence 或播客。

## 独立视觉模型第二次判定执行器（仅开发集成，尚未启用）
- `packages/provider-gateway/src/vision/pdf-graph-model-review.ts` 提供 `createGatewayPdfGraphModelReviewer`，独立于生成图候选的请求。只有 **单独的第二次付费图像处理授权、独立 reviewRequestId、已校验原图 PNG/PDF 来源 SHA 和 graph candidate SHA** 齐全时才允许发送 Gateway。
- 仍复用受信的 `PDF_VISUAL_STRUCTURE` workspace 视觉路由以及模型/预算/成员鉴权；一次调用、8MB 图像、1800 输出 token，不私接 API Key，不自动 retry。输入为有界正文摘录与源图上的图结构；一旦正文被裁剪、图像关系无法判断或模型返回 UNKNOWN，就只能 `REVIEW_REQUIRED`。
- 模型仅能返回七个固定轴的 CLEAR/ISSUE/UNKNOWN，综合判定 PASSED/REJECTED/REVIEW_REQUIRED；通过不授权 Book Intelligence、播客、Gold 或发布，模型返回的越权字段直接拒绝。
- **重要**：本版只是实际可调用、已接入已有 Gateway 类型的第二次模型判定执行器；没有持久化第二次授权/模型审核决策、没有自动队列或生产 UI 按钮，不能用第一次图结构生成的同意暗中触发第二次付费。继续后续集成前保持无调用、不可发布。
- 新增 `pdf-graph-model-review.test.ts`，由现有 `test:phase8b` CI 脚本运行，模拟网关结果测试来源、预算、同意、未知、截断、模型自宣称批准拒绝等。

## 第二次独立付费审核的持久化授权（新增）

- 新增 PostgreSQL `PdfGraphSecondReviewRequest` 与追加迁移 `20261031180000_pdf_graph_second_review_request`。模型源图 SHA、候选图 SHA、原书 SHA、workspace、run、routing generation 与物理页都固定保存；不保留页面图像、提示词或全文。
- 新的独立 POST/GET：`/api/studio/pdf-visual-review/[sourceDocumentId]/second-review`。POST 必须完成真实登录、canonical Origin、OWNER/EDITOR 成员资格、已绑定视觉 Gateway、当前成功 extraction/run/page、未过期图结构及 SHA 校验；必须另行同时同意独立二次复核、图像外发与供应商费用。
- 数据库 UNIQUE(ingestionRunId,routingGeneration,physicalPageIndex)，防止并发多次授权；发生冲突直接返回 409，**不允许重试产生另一次付费申请**。
- `PDF_GRAPH_SECOND_REVIEW_REQUEST_ENABLED=false` 默认关闭；即使显式打开，当前只能创建 `AUTHORIZED_NOT_DISPATCHED` 状态。没有注册 Worker、没有发送图像或实际调用模型，也不生成已核验的播客事实。后续必须新增安全 claim、消费加密回执与模型判定的事务，才能执行第二次调用。
- 添加 Web 严格同意/权限合约回归和 Worker 真实 PostgreSQL 唯一性/复合外键/SQL CHECK 测试。

## 仍需下一步
独立审核任务必须复核未过期授权、当前成员角色及来源绑定；使用已有 Gateway 的加密调用回执（不确定响应绝不重试）及一次性结果消费，在 PostgreSQL 写入审核决定，再经完整原书质量门禁评测确认是否可用于播客。以上尚未完成，不得视为自动审核闭环。

## 新增：一次性 Worker 执行与数据库结果存档（独立手动运行）

- `apps/worker/src/pdf-graph-second-review.ts` 增加 `processNextPdfGraphSecondReviewRequest` 与 `createOnDemandPdfGraphSecondReviewRuntime`。**没有被 `startWorkerRuntime` 注册**、没有 Redis 自动调度、没有重试、没有真实付费调用。只有显式设置 `PDF_GRAPH_SECOND_REVIEW_REQUEST_ENABLED=true` 并由受信运维代码手动调用 `executeOnce` 才会取出一项申请。
- 原子 CAS：`AUTHORIZED_NOT_DISPATCHED → RUNNING` 后永不重置为可计费状态，进程崩溃保留 `RUNNING` 待审，杜绝不确定结果自动重计费。过期未认领申请只可变 `EXPIRED`。
- 付费前再次检查当前 `CurrentDocumentExtraction`、成功 `IngestionRun`、workspace 成员不是 VIEWER、视觉 Provider 已连接、候选图结构/原书/物理页/PNG/candidate SHA、来源正文非空。读取 MinIO 原 PDF 验证大小与 SHA，然后从已有 PDF.js 隔离器重新渲染，要求 PNG 的 SHA 与用户独立授权一致；图像不持久化。
- 复用 `createGatewayPdfGraphModelReviewer` 作第二次 Vision 调用；只记录审核三个安全状态及七个轴、Provider invocationId、snapshotId 到申请表。重新确认身份、来源、成员与路由；失效降级为 REVIEW_REQUIRED。所有状态保持不可发布，不写入 Book Intelligence、播客或 Gold。
- worker PostgreSQL 集成测试覆盖：成功落库、撤权后的零模型调用、进程重启残留 RUNNING 禁止重试。必须以新 HEAD CI 验收。
- **限制**：此版本尚未通过真实私人电子书/付费视觉模型进行端到端验收，也没有实现 Provider 加密结果的跨进程补取/消费确认、独立人工 Gold 与播客发布质量门禁；有争议的远端结果只能交由人工/运维核对，不得自动重新调用。
