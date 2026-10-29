# STEP6-2B-2 执行记录（未完成验收）

状态：`STEP6-2B-2_BLOCKED_WITH_EVIDENCE`。本分支打通真实 standard 调用，但没有完成用户要求的安全生产链路；不可合并、部署或开启生产 standard。

## 基线与实际变更

2026-10-30 核验 main 为 d6e058912442f3a0b48a53334897e4ca3cb63155；PR #215 仍为 Draft/Open，HEAD 4f9d975af11ea144fd9eaa169c061b13863db193。其 CI 40908016472 六项 SUCCESS。这是堆叠分支，base 为 #215 分支，不是 main。原工作树未修改。

根因修正：旧报告将 doclib 启动读取 mode 推断成只能重启服务。实际安装的 MinerU 4.0.3 `doclib/background/parse_server_health.py` 中 `run()` 每轮读取 mode，`_managed_parse_server_needs_restart()` 在没有 managed_proc 时允许启动 supervised engine。通过原有受限 PUT 配置入口开启 managed，再等待明确 standard readiness 即可；无需第二个 doclib 实例、伪造 hostClaimToken 或共享 daemon。

代码：`packages/ingestion/src/mineru/mineru-executor.ts`、`mineru-standard-server-setup.ts`。保持原有一 lease 一 doclib 身份、单次 parse 和 finally 停止路径。引擎独立回环端口、strict_port；fetch 禁止重定向，已取消的 signal 立即生效，探测和轮询等待受剩余预算约束。

## 真实执行证据

私有证据留在指定数据根目录的 `private/step6-2b2/`，未提交原文、PDF、凭据或权重。

- B03 p0015：既有 provenance 的 textlayer_chars=0；执行前核验 PDF SHA-256 `d844e86d4d74bc65349890a5806c4a107947afbbb41d324acaf78efdfe720314`。
- 实际 MinerU 回执：tier=standard、status=done、cache_hit=false、page_range=1。
- 输出 2084 UTF-8 字节、778 字符，SHA-256 `b862d8c9e6d9df4cec0e33e6db993ba024011cd3e219c44a495f6238d39f6278`。这些是输出存在性指标，不能视作 Gold 准确率。
- 独立 CLI 探测的 SQLite parses 行：standard done，created_at=1793291001832，done_at=1793291009743，差值 7911ms。这是预热后任务墙钟耗时，含调度和后处理，不能称为纯模型推理时间。
- 第一轮生产执行器 + PostgreSQL 真实门：4 PASS / 0 FAIL，130.21s 测试时间；standard 输出、内存拒绝后 flash、源哈希不符后 flash、模型和运行时校验。
- 加入独立引擎端口和重定向保护后的最终真实门：4 PASS / 0 FAIL，139.08s 测试时间。`production-executor-final.log` 留在私有目录。
- 冷模型加载时间、正式热运行性能、峰值 RAM/VRAM：UNVERIFIED。主机实测空闲 RAM 曾约 3.0GiB，启动 Docker 后低至约 0.82GiB，后恢复约 3.15GiB；这些是采样值，不是峰值测量。GPU 初始约 287MiB 已用、7670MiB 空闲，不能据此声称使用了 GPU 推理。

## 本地验证

- `pnpm --filter @ai-cognitive/ingestion test:unit -- --maxWorkers=1`：292 PASS、2 SKIP、0 FAIL。两个跳过项需单独审阅，不能记为通过。
- 新增 bootstrap HTTP 实测：3 PASS / 0 FAIL，覆盖先未就绪后就绪、重定向拒绝、超时及预取消。
- ingestion typecheck / lint / build：修复 RequestListener 类型后均通过。
- 初次离线安装缺少 xmldom 缓存；经本机既有代理完成 frozen-lockfile 安装，未改 lockfile。
- 初次单测：267 PASS，2 个 suite 因 Prisma Client 未生成而失败；设置测试 DATABASE_URL 后 generate，复跑见上。
- 测试 PostgreSQL 已有 53 个迁移，无待应用迁移。本分支没有新增迁移。
- 全仓构建、MinIO 来源/结果闭环、真实 Worker 和新 HEAD CI：待单独核验，不能用 #215 的 CI 替代。

## 阻塞完整验收的安全问题

以下是仍未实现的需求，不是环境不可用的借口，也不是已解决问题：

1. **B 未完成**：执行器仍主要比较调用者声明与收到字节的 hash，没有独立关联 SourceBlob、SourceDocument、当前 run/plan、page claim 和有效 lease 的前后核验。
2. **C 未完成**：现有 manifest 验证仍接受自报库存。没有固定批准摘要、完整实际加载库存和替换防护的全部证明。真实测试动态生成的 manifest 不能冒充受信基线。
3. **D 未完成**：actualTier/model identity 尚未按 page attempt claim fence 持久化；descriptor 仍保持 #215 的 modelRevision=null，避免把 flash 假记为 standard，但不等于完成正确持久化。
4. **E 未完成**：原 canonical 可用性检查不等于表格、图表、乱码、顺序和重复内容质量拦截；未实现要求的人工复核分类及发布拦截。
5. **恢复未完成证明**：不能仅凭普通成功后的 finally stop 宣称父进程崩溃、超时、取消及 managed engine 的回收全部通过。尤其需验证 MinerU managed process control 与现有 reconciler 的组合契约。
6. 保留 #215 Mimosa SSRF advisory 和历史风险记录。本分支修复 redirect 并不构成全仓安全审计通过。

## 后续优先顺序

先完成 B/C 的独立权限及固定库存门禁，再完成 D 的 fenced 持久化和 E 的质量发布控制；之后才可以把本分支真实 standard 成功调用计入安全生产链路验收。无需重做 OCR 选型或 Benchmark。

本记录明确不满足 STEP6-2B-2 的全部验收要求。Draft PR 应保持 WIP / NOT_MERGE_READY。
