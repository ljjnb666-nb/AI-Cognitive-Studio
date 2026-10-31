# PDF 混合页图候选持久化与网页核对（2026-10-31）

## 基线
基于新主线堆叠 PR #226 @9e157884eff1575a5652ae27b90f40594347a8c4，复用历史 #210 的数据库存储约束与网页 read model，**只移植适配当前主干的文件**，不覆盖最新 OCR 复核流程，也不合并过时分支。

## 端到端能力
- 只有通过受控的 `executeOnDemandPdfVisualReview` 且调用方另外传入 `persistReviewCandidate:true`，才保存有限的来源绑定图候选；仅含物理页、PDF SHA、PNG SHA、经过严格 JSON 验证的图节点/关系及摘要。
- PostgreSQL `PdfVisualReviewCandidate` 追加表和只增加的 Prisma schema，唯一组合键确保同来源/页/版本/PNG 的写入可重放但不可被静默覆盖；独立 24h 的读取有效期不等于物理自动删除。
- 当前 `/studio/library/[sourceDocumentId]/review` 先复用来源所属工作区鉴权，只读查询当前提取关联 run、generation、SHA、页号，校验候选摘要、来源一致性、未过期，展示候选图结构和方向。
- 原来的 OCR 待审分支及模型审核、源 PDF 页面不变。新界面无授权申请按钮，也不自动触发外部模型；候选是 `UNVERIFIED_VISUAL_CANDIDATE`，不改变 canonical text、Book Intelligence 或播客。
- 使用合成图与自动化测试校验过期、篡改、错误页、未知关系、重复来源以及付费调用前明确同意。

## 验收标准
必须在本 PR 准确 HEAD 完整执行 Prisma generate、数据库迁移可应用/回滚检查、worker unit、web integration、types、build 和 CI 六项；独立真实 PostgreSQL/MinIO 回执与 Windows Edge 浏览器验收另行复核。没有运行私有原书视觉模型，不得将 CI 通过冒充真实准确率。**Draft、默认关闭、不合并、不部署、无付费调用。**

## 下一步
在既有 Studio 上传流程接入可审核的**用户显式同意申请**，受控 Worker 领取后生成候选；然后实现独立模型结构核验和 B03/B15 Gold/质量门禁。不能因为只是打开页面就调用视觉模型。
