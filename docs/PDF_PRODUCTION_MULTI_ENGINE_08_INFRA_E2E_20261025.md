# PDF 新框架 Phase 2｜Redis / PostgreSQL / MinIO 联合验收

## 本切片目标

在 #192 的跨主机容量与租约屏障之上，补齐此前缺失的**真正基础设施集成**。这不是新的 OCR 引擎选型，也不改变生产默认行为。

- 使用真实 Redis 7 + BullMQ Queue / Worker / QueueEvents，随机前缀隔离，绝不执行 FLUSHDB。
- 使用真实 PostgreSQL 17 的 `DoclingLayoutTask` 与 `DoclingLayoutSnapshot`；保持事务型 owner fence、租约和重试预算。
- 使用真实 MinIO/S3 的原始 PDF 占位字节上传/读取，以及只读、非权威 Markdown sidecar 的写入、读取与 SHA256 校验。
- 使用**模拟的确定性 Docling executor** 注入版面候选，不启动 Python、不下载模型、不向云端发送任何书籍。
- 验证仅 OCR_REQUIRED 物理页 1 会投递，页面 0/2 不会被处理；回放不会再次运行模型或改写原生 PDF.js extraction。
- 验证第一轮模型失败、第二轮成功只消费两次持久预算、只发布一条快照。

## 测试入口

文件 `apps/worker/tests/docling-layout.integration.test.ts` 内新 `Docling infrastructure full-stack candidate acceptance` 组；包含在 `pnpm test:integration` 默认文件匹配中，现有 CI 的 `core-tests` 用 PostgreSQL / Redis / MinIO 真实服务执行。

## 准确范围与不可声称的结论

此回归验证的是**Redis 投递、PG 权威租约、MinIO 对象持久化和幂等恢复**。源字节是隔离的 `%PDF-` 占位素材，executor 是模拟器：**不等于真实可解析 PDF 的准确性验证，更不等于真实 Docling 2.141.0 模型 E2E 通过**。单机 CI 也不能证明跨两台 Windows 主机进程级 CPU 容量或崩溃后的物理子进程终止。

接下来仍需 Windows Runner 真实离线 Docling + MinIO/PG/Redis 联合验收，随后才允许评估 MinerU 条件回退、云端视觉兜底、五本书 Gold 与 CER。保留 `DOCLING_LAYOUT_ENABLED=false`、无外部调用，全部相关 PR 保持 Draft，未经用户同意不可合并。Issue #161 保持 OPEN。
