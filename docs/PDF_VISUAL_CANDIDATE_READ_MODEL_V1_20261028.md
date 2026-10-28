# PDF 图表候选短期保存与来源页可读 v1

日期：2026-10-28。**Draft / 非生产自动化 / 视觉候选没有获得事实权威**。

## 真实功能变化

基于 #209 真实 PDF 来源核对页面，新增一条有限的“已授权 Worker → PostgreSQL → 同书同页 Web 只读展示”路径：

1. `executeOnDemandPdfVisualReview` 除已有 `enabled:true` 和 `allowExternalVisualModel:true` 外，**额外**要求 `persistReviewCandidate:true` 才可保存候选。未提供有效保存依赖则在 S3/Provider 访问前拒绝。
2. 经原书 S3 SHA、解析路由回放、视觉图格式验证后，**仅**把最多两页的图表候选（节点、边、方向、caption、bbox）写到 `PdfVisualReviewCandidate`，不保存 PDF 字节、PNG 像素、源正文摘录、请求提示词、凭证或未审阅人工结论。未识别成功的页不伪装成空图或已审核图。
3. PostgreSQL 中记录 `workspaceId`、`sourceDocumentId`、`ingestionRunId`、`routingGeneration`、物理页号、PDF/PNG SHA 和候选的规范化 SHA。复用同一 SHA 时不覆盖历史候选；内容变化拒绝，而非重写；过期时间 24 小时。
4. Web `/studio/library/[sourceDocumentId]/review?page=N` 先通过 `sourceDetail` 权限验证；再根据当前提取记录的 `ingestionRunId`、工作区、原书 SHA、`routingGeneration`、物理页和有效期查询候选。图 JSON 结构和完整性再校验一次后，才展示模型识别的节点与箭头；无候选/过期/损坏就如实显示。
5. 始终显示 `UNVERIFIED_VISUAL_CANDIDATE`、`NOT_REVIEWED`、`approvedForPodcast=false`。无批准按钮，不变更 canonical blocks、当前 extraction、Book Intelligence、播客和 Docling 生产配置。

## 范围限制

**这并不是“用户点一下就自动识别”的完成品。** 原 Worker 依然仅供显式受信任调用，生产自动队列未注册，本 PR 不新增用户触发付费视觉识别的 Web API。页面只能读到已经**明确授权并成功保存**的候选；此时仍需要人工与原始 PDF 图像对照。

**数据隐私说明：** 本次只排除了原图、正文和提示词的复制；图节点/标签本身也可能含书中片段，因此属于敏感的工作区数据。当前和现有 SourceBlock 相同，存放在后端 PostgreSQL，**并非独立列加密**。正式生产前需评估额外加密、到期清理任务、授权接口和审计日志。有效期用于拒绝读取，**不能等同于到期自动物理删除**。

## 验收

- 运行准确 HEAD 专项，在真实 PostgreSQL17+MinIO 上验证迁移、Gateway mock、Worker 显式 opt-in、真实写入、再次执行不重复写。
- 单测验证来源错位、重复页、图边无效、输出伪造、文本不进入候选行。
- Web 校验 JSONB 排序不影响 SHA；过期／跨页／跨源／篡改图结构拒绝。
- 通过 TypeScript/ESLint 后仍需单独核验完整 CI；不声称已经通过登录浏览器 E2E、真正 GLM 质量或五书 Gold。
- 只完成这个“安全可读候选”切片，不再扩张 Benchmark。下一切片为浏览器显式授权触发、受控预算与人工审核状态；应先做真实 UI 交互验收。

不合并，PR 保持 Draft；Issue #161 OPEN；五书 Gold 0/5、CER=null，Docling 生产 OFF，生产 UNVERIFIED。
