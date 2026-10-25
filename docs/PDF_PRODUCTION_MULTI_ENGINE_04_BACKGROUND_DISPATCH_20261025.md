# 阶段二｜Docling 版面候选独立后台条件调度（PR #189）

本切片建立在 #188 的可审计候选快照之上：不是重新测试 OCR 引擎，也不触碰 PDF.js / RapidOCR 正文权威。

## 显式开启与运行条件

默认 `DOCLING_LAYOUT_ENABLED=false`。仅当设置为 `true`，且 `DOCLING_LAYOUT_PYTHON_PATH` / `DOCLING_LAYOUT_ARTIFACTS_PATH` 指向真实已安装的离线 Docling 2.141.0 和模型目录时，Worker 才会在启动时执行本地模型 SHA/version 探针，通过后构造独立队列。未配置或者关闭时不建立新队列、不引入任何模型依赖；关闭时若遗留这两个配置应拒绝启动。

正式 `OCR_PROVIDER` 不会被 Docling 覆盖，也不会因为新功能自动改成 MinerU。Docling 只生成 **NON_AUTHORITATIVE_LAYOUT_CANDIDATE**。

## 候选筛选与资源预算

Worker 每 60 秒使用 PostgreSQL 来源表按稳定游标扫描一次（每次最多 20 条、只看近 7 日 SUCCEEDED 且正式提取已 SUCCEEDED 的 PDF）。只对原有不可变 PDF 路由计划中 `OCR_REQUIRED` + `NON_TEXT_CONTENT` + 图像或矢量证据的物理页产生候选，每书最多两页；其他页面、空白页、未完成导入和被篡改的 plan 都不会触发 Docling。

Redis/BullMQ 只传入 `ingestionRunId`、`physicalPageIndex` 和已验证的 `modelSha256`，不传 PDF 原文、Markdown 或任何凭据。JobId 由 run + physicalPageIndex + modelSha256 确定，独立队列并发限制为 1，最多两次执行、固定回退 30 秒、终态失败保留（避免每分钟重新触发同一失败）。

执行器从原来的私有对象存储读取来源 PDF，读取前检查对象长度，流式限制总量 110 MB；正式持久化 API 再次独立检查源 SHA、租户、物理页、模型指纹和现有数据库快照。成功候选采用 SHA 寻址私有 Markdown 对象。模型失败不会改变 `IngestionRun`、`DocumentExtraction`、`CurrentDocumentExtraction`、`SourceBlock` 或任何书籍分析 outbox。

## 关闭与重复执行

进入关闭状态后清理调度计时器并等待当前 PostgreSQL/Redis 扫描完成，然后停止取新 Docling Job、终止已启动的 Docling Python 进程、等待 Worker 关闭。已有快照由 #188 依据数据库唯一页模型键与对象内容哈希复用，重新投递不会覆盖之前的候选。

## 已知限制与下一切片

当前是 **默认关闭的灰度候选后台队列**，不是已经启用的生产路由：

- 7 日游标扫描只用于近期自动发现；历史大批量回填另建受控任务。
- BullMQ 保留 FAILED Job 并使用模型页键去重，但 Redis 全损后仍可能重复计算；最终稳定生产需要 PostgreSQL 独立失败预算 / lease / crash-replay fence。本切片不能宣称已经解决 Redis 全损和多主机并行抢占。
- 独立 Docling Python 在 Windows 上处理两页合成 PDF 已通过上游 #187；这里的 PostgreSQL 集成测试注入非权威候选执行器，不等同模型和 DB 同次真实 E2E。
- 没有自动 MinerU 回退、图表语义仲裁、五书独立 gold/CER 准入；所有原始私有 PDF 内容继续留在 D 盘。
- 使用完整主 CI、单元测试、真实 PostgreSQL 集成和上游 Docling Windows 专项分别保留证据。生产不可默认启用。

保持 #161 OPEN、gold 0/5、CER=null，所有上游 PR 与本 PR Draft/Open/Unmerged，未经明确授权不合并。
