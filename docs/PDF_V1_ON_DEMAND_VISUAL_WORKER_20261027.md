# PDF 识别架构 v1：Worker 端到端视觉审阅任务（2026-10-27）

状态：**ON_DEMAND_REVIEW_ONLY / Draft**。本开发切片不在 `startWorkerRuntime` 中注册新的自动任务，不创建生产队列，不修改成功书籍的 canonical blocks、CurrentDocumentExtraction、图表或播客数据。

## 已接通的真实功能

`apps/worker/src/pdf-visual-review.ts` 实现 `executeOnDemandPdfVisualReview(task, deps)`：

1. 仅接受显式 `enabled: true` + `allowExternalVisualModel: true` 的受信任任务，不存在定时任务或历史扫描。
2. **先做用户/工作区权限校验**，再查询 `IngestionRun`，要求工作区、SourceDocument、已成功 PDF 解析、write-once routing generation 和合法来源 SHA 匹配。
3. 从 SourceDocument 的私有 S3/MinIO 读取真实 PDF，先按 `sizeBytes` 和 `HeadObject` 限额（最大 110MB）、流累计长度与 SHA256 验证。
4. 在付费模型前，以原始 PDF 字节再跑原生 PDF.js 路由并 `assertRoutingPlanReplay` 比对历史 `pdf-routing-plan-v1`；不允许历史任务在视觉过程中悄然换页、换路由。
5. 使用已验证的 `inspectPdfMixedPageVisualStructure` 和 `createGatewayPdfVisualExecutor`：只对选中的 **最多一页（显式上限可为两页）**真实渲染 PNG，走受控 Gateway 的 `PDF_VISUAL_STRUCTURE` 视觉路由，校验图表区域、节点/边及方向。
6. 返回只在内存中存在的 `UNVERIFIED_VISUAL_CANDIDATE` / `REVIEW_REQUIRED`，保留输入来源、页号与图像来源 SHA 供调用方确认。**不写用户可见正文、图谱或生产 DB 表；不把图表候选放进 Redis Job return value。**

`createOnDemandPdfVisualWorkerRuntime(environment, source)` 是显式资源组合接口：按现有凭证读取和工作区路由创建真实 Provider Gateway 与私有 S3；调用者必须主动创建、执行并关闭，重复 `close` 幂等；没有应用启动时自动实例化。生产 Docling 开关和当前 Worker 运行计划不变。

## 验收

- 无版权合成二页 PDF 的真正隔离 PDF.js 解析、私有流读取 SHA 和图像渲染。
- 模拟 `ProviderGateway` 返回图结构，验证 Worker 能完成 PDF 字节 → 带 provenance 的图表候选，且不会重复调用纯文本页。
- 在**读取存储之前**的权限拒绝、工作区/原书身份不匹配、错误解析状态、SHA 篡改、对象大小不匹配、历史路由不一致的拒绝测试；这些情况下提供商调用数严格为 0。
- 快速专项刻意不依赖真实 MinIO/PostgreSQL/付费 GLM，这些是下一项高价值验收，而**非**此 CI 的通过内容；全量主 CI 仍必须核实。

## 保留的生产门槛

当前不是用户可点击的完整界面功能，也没有真正给 B15、B31 私有书页调用模型；它是 Worker 级可调用任务入口，**自动派单、持久化图候选、审阅 UI 都未打开**。

Gateway 的持久化调用机制由现有实现复用，但此次新增 Worker 测试仅模拟 Gateway，未证明视觉调用的真实 PostgreSQL 持久化回执消费。后续不能在没有一致性保证的情况下将图候选直接上架到书籍或播客。

生产 Docling OFF；五书独立 Gold 0/5，CER=null；所有相关 PR Draft/未合并。
