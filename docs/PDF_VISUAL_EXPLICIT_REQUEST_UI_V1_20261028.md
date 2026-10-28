# PDF 视觉识别用户主动申请闭环 v1

2026-10-28｜Draft / 默认关闭 / 仅代表首张混排页的付费识别申请，不代表生产发布准入

## 用户可执行的功能

`/studio/library/[sourceDocumentId]/review` 显示「按需视觉识别」控制区域。**必须同时勾选**「外部图片处理」和「可能产生 API 费用」才可提交。明确告知当前只会尝试本书最前面的 **一张**图文混排页，**不是用户当前页**。

- 前后端及 Worker 均使用 `PDF_VISUAL_REVIEW_ON_DEMAND_ENABLED=true` 显式开关；默认关闭。
- 提交服务：`POST /api/studio/pdf-visual-review/[sourceDocumentId]`，严格 JSON 请求体、同源 Origin、现有用户/工作区权限、当前成功解析 run 与 PDF SHA、已绑定的有效 `PDF_VISUAL_STRUCTURE` Provider 路由。
- PostgreSQL `PdfVisualReviewRequest` 通过 `@@unique([ingestionRunId,routingGeneration])` 限制每份源文件解析版本只能提交**一次**；即使并发浏览器请求或网页重开也不能重复排队。
- Worker 只在明确打开开关时每 5 秒扫描最多一项 PENDING，采用条件 `updateMany` 原子领取，执行现有受控 `executeOnDemandPdfVisualReview` 并开启 `persistReviewCandidate`。重启/崩溃后不自动重试已领取的任务。
- 状态读取：`GET /api/studio/pdf-visual-review/[sourceDocumentId]`，读取自身当前来源 run 的 `PENDING/RUNNING/SUCCEEDED/NO_FIGURES/FAILED`，过期请求标 `EXPIRED/INTERRUPTED`；网页只在请求结束后重新读取页面。
- 原视觉候选表保存经过验证的节点、边和方向，永远 `NOT_REVIEWED`，不能成为正式 Book Intelligence 或播客依据。未设置开关或视觉路由时拒绝新申请。

## 审慎边界

- **付费风险**：一次申请仍可能实际调用一次远端视觉模型；这个切片没有现金金额预算阈值、账户额度分层或退款保障。一次提交不代表一次模型响应肯定有效。
- **任务回收**：15 分钟 PENDING 过期；已 RUNNING 发生崩溃则视为中断，**不能自动重试**，避免不确定付费调用重放。当前没有运营人员手动核销/恢复接口。
- **安全**：视觉内容可能含用户的书籍片段；候选 JSONB 按工作区权限访问，保留 24 小时可读有效期，不等于自动物理删除。仍无独立字段加密。
- **目前没做**：原图图片展示/逐页指定，真正人工审批、完整交互式图文审核、真实私有书页 Gold、真实付费模型调用、用户浏览器操作 E2E，以及生产发布。运行时默认 OFF。
- Docling 生产 OFF、Issue #161 OPEN，所有 PR Draft，未经授权不合并。

## 测试出口

本 PR 只验收一次性申请 + 条件领取 + 原有视觉保存和读取；已在真实 PostgreSQL + MinIO 的原测试中增加一段“创建申请→Worker 领取→完成→再次扫描不重试”的链路。专项 exact-head 验证这些真实后端测试、网页 DTO、TypeScript 和 ESLint；主 CI 独立核验。

不再在此切片上扩展引擎选型、Gold 工具链或生产级审核审批。