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

## 显式用户申请与受控执行回收
- 增加独立开关 `PDF_MIXED_GRAPH_REVIEW_REQUEST_ENABLED=false`，不复用最新主线已经用于 OCR 结构复核的 `PDF_VISUAL_REVIEW_ON_DEMAND_ENABLED`。默认无扫表、无模型调用、无自动授权。
- 前端两个独立同意：私有原书混合页图片发送至 Workspace 视觉 Provider，及可能发生 API 费用；一次申请只处理本书最前一张混排页，非当前任意页。
- POST 需要同源 Origin、OWNER/EDITOR 身份、当前 PDF 提取与视觉路由；以 PostgreSQL 唯一键和 15 分钟窗口拒绝重复申请。GET 只读取当前授权书籍对应的申请状态。
- Worker 默认不启动图表模型扫表；独立开关显式启用后，5s 有界扫描、CAS 领取与权限二次确认；一次性执行、失败或崩溃绝不自动重试未知付费结果。复用 #227 已验收的无像素候选持久化与 Gateway 账本。
- 资源管理新增单飞运行与停止时 drain，避免关闭 Gateway 时尚有付费在途。
- 新增实际 PostgreSQL/MinIO 加模拟 Gateway 加密回执与付费幂等的集成证明；不消耗任何真实供应商额度。
- 图结构候选仍然非 Gold，不能进入 Book Intelligence/正式播客。

## 独立审计 P0 修复：API 路径隔离
CI 曾在覆盖主干原有 `POST /api/studio/pdf-visual-review/[sourceDocumentId]`（OCR 结构审核）的情况下全绿。正式集成前必须恢复该 OCR 原路由到主干完全相同的 blob，并把双重同意的图结构申请迁移到独立的 `POST/GET /api/studio/pdf-visual-review/[sourceDocumentId]/mixed-graph`。该隔离由回归测试锁定；生产开关保持独立且默认 OFF。这说明静态/现有 CI 不能替代 API 合约审计与真实浏览器验收。

## 认证门禁修复
混合图表图片会发送第三方模型且可能产生费用，因此用户显式勾选仍然**不能替代实时登录认证**。`/mixed-graph` 的 GET 和 POST 都先向 Better Auth 获取禁用 Cookie 缓存的真实会话，并核验 session.user.id 与工作区身份解析结果相同；没有会话、身份回退或二者不一致时以 401 拒绝，绝不读取私有 PDF 候选或写入付费申请。原 OCR 路由保持原状。增加纯身份判定测试与接口合约隔离回归。
