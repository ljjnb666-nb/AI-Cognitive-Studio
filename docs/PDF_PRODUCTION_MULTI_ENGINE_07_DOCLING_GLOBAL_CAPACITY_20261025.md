# PDF Phase 2｜跨主机 Docling 并发容量准入（候选 PR #192）

## 范围

基于 #191 任务租约心跳，在 **同一 PostgreSQL 数据库** 下将 Docling 同时有效执行租约保守限制为 **1**。不开启生产功能，不修改 PDF.js、RapidOCR、MinerU 或正文发布路径，也不下载模型、上传私有书籍或引入新的租户数据。

## 不变量与实现

- 数据库是执行准入来源，Redis/BullMQ 仅负责通知与退避。所有 Docling 任务通过 `claimDoclingTask` 在 **同一个 PostgreSQL 事务** 中获取固定两整数事务级 advisory lock，统计所有尚未过期的 `RUNNING` 租约，再执行原有唯一行 CAS。不同页面、不同租户、不同 Worker 主机都必须共用此序列化准入。
- 全局容量为 1，当前保守固定，不开放任意环境变量；扩容必须先有真实 CPU/内存证据和完整容量测试。
- 满额的任务保持 `PENDING` 和未变化的 `attemptCount`；重复投递当前执行中的同页任务也返回暂时忙碌。不允许借容量拒绝吃掉两次持久推理预算。
- BullMQ 碰到 `SKIPPED_BUSY` 使用 **manual rate limit 30 秒** + `RateLimitError` 将原任务重新排队而不是认定完成或普通失败；BullMQ 自身 1/秒吞吐限流并非执行容量控制。
- 租约的 300 秒有效期与 60 秒心跳，以及 sidecar 快照事务的 owner 令牌屏障，继续由 #190/#191 提供。过期旧 owner 不得结算或持久化快照。

## 新增回归

真实 PostgreSQL 两个不同租户的独立页并行 claim，仅有一个拥有有效令牌；被拒绝页始终 attempt=0；续租期间禁止另一个页入场；完成释放后被拒绝页正常取得第一次预算；两次尝试预算仍有效。原有同页旧令牌/Redis 全损测试保持不变。

## 仍待验收

- 此容量约束针对 **PG 内有效租约**，不声称能物理杀停数据库不可达时仍运行的 Python 子进程；需要真实跨主机、故障注入和 S3/Redis/Docling/PG 同次 E2E。
- 运行时禁用 Docling：`DOCLING_LAYOUT_ENABLED=false`，禁止默认上线。
- 上游 #186–#191 与本 PR 均为 Draft/Open/Unmerged；不得擅自合并。
- 五书人工独立 gold 仍为 0/5，CER=null，Issue #161 保持 OPEN，架构 NOT_FROZEN。
