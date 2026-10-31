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
