# STEP6-2B-2 工程验收报告

状态：`STEP6-2B-2_IMPLEMENTED_WITH_PENDING_VERIFICATION`。实现、真实整链和生命周期已通过本地验证；本次资源保护改动后的最终回归、准确 HEAD CI 和统一复核尚在进行。PR #216 保持 Draft / Open / Unmerged；没有合并、部署或开启生产 standard。

## 实现与安全边界

1. standard 启动沿用既有 claim-scoped doclib。MinerU 4.0.3 的 health loop 每轮读取 mode；通过受限配置入口启用 managed，再等待明确 standard readiness，无需重启 doclib、伪造 hostClaimToken 或共享 daemon。HTTP 只允许 IPv4 loopback，禁止 redirect；修改配置前核对 pid/server_id/running，就绪时绑定同一身份与生成的 strict managed 端口，状态响应最多 256 KiB。
2. 来源授权独立读取 PostgreSQL 的 SourceBlob、SourceDocument、run、Job、plan 和 page claim。顺序为 run → Job → document → blob → page，锁后用 clock_timestamp() 核验有效租约。执行前后、checkpoint 恢复/提交和 canonical 发布均重查来源；实际 PDF 字节在异步边界前复制并计算 SHA。撤销、过期、换源、旧 generation、跨 run 和迟到提交均拒绝。
3. 固定外部模型库存为 MinerU 4.0.3 ONNX registry 的 13 项模型/配置资源、2 项 GGUF 和必需的空 completion sentinel，共 16 项、2,098,681,010 字节。批准摘要 `3382d142ef28eeeda138fd13786ec41e591007c852aca1487b424850f8c179ad`，revision `mineru-4.0.3-onnx-llamacpp-q8-v1`。验证版本、库存、路径、大小、SHA 和物理路径；先验证 operator cache，再复制批准文件到 claim 私有副本、只读并重验，识别后再验。standard 清除继承的 MinerU 配置并固定 onnx/llama-cpp。
4. 资源控制保留启动准入与单 host lease，standard 子进程内 parse/ingest worker 和 VLM 请求并发各为 1。250ms 轮询系统可用 RAM，固定至少 1 GiB 运行时应急储备，低于储备中止自身 claim，记 `SOURCE_OCR_MEMORY_PRESSURE`，不会伪装成 flash 成功。此保护不能保证操作系统绝不出现瞬时压力。
5. 新增 OcrPageExecution 历史及 OcrPageAttempt 的 proposed/admitted/actual tier、模型/清单、源/claim、执行状态、fallbackReason 和质量字段。未调用 parse 时 actualTier=NULL；flash 不带 standard 模型身份；成功写入还须持有有效 host lease。失败重试保留历史，触发器拒绝 UPDATE；租户级删除仍可级联清理。
6. 质量分类为 ACCEPTED / REVIEW_REQUIRED / REJECTED，覆盖空输出、乱码/控制字符、重复块、异常块、阅读顺序、表格/图表、轴标签及页码风险。Markdown 不足以证明结构，因此所有 standard 提案结果强制 STRUCTURE_UNATTESTED 复核。保留私有 OCR artifact 和真实成功执行回执，但不生成正式 extraction/current extraction，run 为 OCR_REQUIRED、错误为 SOURCE_OCR_REVIEW_REQUIRED；不新增人工批准或正式发布权限。

核心位置：`packages/ingestion/src/ocr-source-authority.ts`、`ocr-execution-receipt.ts`、`ocr-quality.ts`、`ocr-durability.ts`、`pdf-run.ts`，以及 `src/mineru/` 下 executor、approved-inventory、model-snapshot、standard-server-setup。

迁移为 `20261030010000_ocr_execution_receipts`、`20261030011000_ocr_receipt_immutability`。增量 nullable 字段保留历史未知状态；独立测试库已部署全部 55 个迁移。`docs/operations/step6-2b2-rollback.sql` 已进行 BEGIN/ROLLBACK 演练：事务内移除新增结构，回滚恢复，不改迁移历史。实际回滚须先停新版 worker 并导出证据。

## 真实链路和可靠性证据

- 私有扫描页 text layer=0。真实 PDF → 私有 MinIO → PostgreSQL 来源/claim 核验 → 批准模型副本 → standard/done/cache_hit=false → fenced 回执与 checkpoint → REVIEW_REQUIRED。
- 输出 2084 UTF-8 字节、778 字符；这是输出存在性指标，不是 Gold 准确率。执行及持久化 actualTier=standard，模型摘要如上；正式 extraction 和 current extraction 数均为 0。重复处理不重新执行 OCR。
- 真实整链文件：**10 PASS / 0 FAIL / 0 SKIP**，465.34s。包含模型/运行时核验、两条 standard 成功（直接执行器及完整服务链）、两条真实 flash fallback、取消、parse 超时、doclib 异常退出、运行时内存保护、Node owner 被杀后的 reconciler 恢复。
- 四类故障均无成功 checkpoint，失败回执不带成功文本 hash；取消等待 readiness 不会虚构 flash 调用。进程身份不再存活，host lease 释放。Node owner 被杀后，仅过期 host lease 不足以清理仍有效 run；run/page 也过期后 reconciler 停止残留 doclib/engine，删除 home，第二轮无待清理对象，host 容量可重新取得。
- 内存保护故障测试在真实引擎就绪后只提高测试储备，不分配巨量 RAM、不降低生产底线。parse 超时测试的 1ms 预算仅用于故障注入。
- HTTP 实测使用本地协议测试服务，覆盖错误实例不写配置、错误端口不就绪、redirect 拒绝、取消/超时和超大响应；不是把协议测试服务冒充真实 MinerU。

## 冷启动、热运行和资源

本地机器单次测量，无统计显著性或性能 SLA 声明。生产仍是每 claim 启停；独立冷/热测量会话不向生产 Job 提供共享 daemon。

| 测量 | 时间 |
| --- | ---: |
| 完整服务处理，含清理 | 69.548s |
| claim 模型 snapshot | 2.773s |
| doclib start | 2.707s |
| managed engine 就绪 | 44.599s |
| 该服务 parse | 9.368s |
| 独立会话 snapshot | 2.865s |
| 独立会话 engine 就绪 | 44.099s |
| 引擎就绪后首次强制 parse | 14.359s |
| 同引擎第二次强制 parse（热） | 6.208s |

独立测量 **1 PASS / 0 FAIL / 0 SKIP**，77.92s；两次均 --force、cache_hit=false、输出 2084 字节，同一 doclib 身份及 engine PID，结束后 engine 不存活。through-second-parse=70.304s，不含最终清理。

engine-ready 含启动、模型加载、health loop 和轮询；parse 含 CLI、队列和后处理。纯模型加载/纯 GPU kernel 耗时未独立 instrument，不能把上述数字称为纯模型推理时间。OS 文件页缓存未清空，“冷”指新 engine 进程。

| 采样 | 10 项真实门 | 独立冷/热门 |
| --- | ---: | ---: |
| RSS 合计峰值（字节） | 3,366,043,648 | 3,740,000,256 |
| 系统可用 RAM 最低（字节） | 1,985,474,560 | 1,703,464,960 |
| 全设备显存基线/峰值（MiB） | 108 / 2020 | 108 / 2020 |
| 退出后可用 RAM（字节） | 5,241,737,216 | 5,237,493,760 |
| RSS 采样数（0.5s） | 883 | 149 |

RSS 合计可能重复计算共享页；显存约每 2s 采样，属于全设备读数而非进程归因，不能作为连续峰值上界。标准成功与冷/热会话均无非预期 fallback；整链中两次 fallback 和四次失败是明确断言的故障注入。

私有 PDF、输出、MinIO 数据与原始日志仅留指定私有数据根；公开脱敏汇总为 `docs/evidence/step6-2b2-standard-chain.json`。

## 回归与准确 HEAD CI

- `pnpm --filter @ai-cognitive/ingestion test:unit -- --maxWorkers=1`：**310 PASS / 2 SKIP / 0 FAIL**。Windows 跳过两项旧 symlink 专项；新增 Windows junction 逃逸测试通过。
- PostgreSQL 来源/checkpoint/routing 组合：**52 PASS / 0 FAIL**。包括真实行锁等待后换源拒绝、过期/撤销/跨 run、并发唯一回执、历史不可改写、恢复 checkpoint 与最终发布换源拦截。
- 原执行器 CLI-double 回归：**17 PASS / 0 FAIL**。Worker 容量延迟/启动屏障/关闭清理：真实 BullMQ/PostgreSQL/MinIO + CLI double，**3 PASS / 0 FAIL**；不作为真实 OCR 证据。原生文本、默认 flash 及未启用 standard 的兼容性由相关集成和 CI 回归验证。
- ingestion typecheck/lint/build、worker/shared typecheck、web typecheck 已通过；本轮全仓 lint/typecheck/build 仍在核验。
- PR #215 复核：Draft/Open/Unmerged，HEAD `4f9d975af11ea144fd9eaa169c061b13863db193`，六项 CI SUCCESS。main 基线 `d6e058912442f3a0b48a53334897e4ca3cb63155`。
- PR #216 base 为 #215 分支。`7cb0b8f1dfda5f4859afbbb0229012db940889c2` 的 core-tests/product-acceptance/quality-performance/stability-beta 均 SUCCESS，static 失败、validate 随之失败。static 为两个夹具旧哈希辅助函数未使用，已删除并本地 lint 通过；新提交 CI 尚待核验，不能用旧 HEAD 绿色替代。

## 保留的失败及残余风险

- 初次真实门低内存降级造成 1 FAIL。遗漏 VLM completion sentinel 导致 HTTP400、2 FAIL；按实际 registry/download 源码补齐固定项，后续通过，没有跳过引擎门禁。
- 512 MiB 储备实验：10 项中 9 PASS / 1 FAIL，最低可用 RAM 约 53 MiB，说明该储备不足；1 GiB 旧并发配置下正向门也触发保护失败。保留失败日志，改为 1 GiB 固定底线与单页内部串行后整链 10/10 通过。最新用户已解决主机内存问题，资源测量仍以实际采样为准。
- CI `a1f3600`：Next ProcessEnv 的 NODE_ENV 类型及 17 个夹具错误来源 SHA 失败；显式保留 NODE_ENV 并按实际 PDF 字节修夹具，原断言不变。`e0147b5` 的 3 个 Worker 夹具同类问题在 `7cb0b8f` 修复，core-tests 已通过；未使用辅助函数的 lint 续修如上。
- 模型摘要是项目批准基线，不是上游签名或整个 Python 运行时供应链认证。外部 model root 被逐文件验证/隔离；MinerU 包内 OCR 字典 `model/ocr/data/ppocrv6_dict.txt` 属于受信任的已安装 runtime，版本检查不等于整个安装目录逐文件证明。具有相同 OS 账户写权限的恶意进程不在隔离威胁模型内；只读属性不是操作系统沙箱。
- 保留 #215 的 Mimosa SSRF advisory 和历史安全记录。loopback/redirect、local model 和代理环境是受控边界及纵深防御，不是 kernel 网络隔离或全仓安全审计通过。
- 质量门禁是保守分流，没有证明漏表/阅读顺序的完整检测率；所有 standard 提案仍要求人工复核。没有授权生产启用，也没有 Gold 准确率、跨平台实际 MinerU 或大批量吞吐保证。

待完成：最终改动回归、统一代码复核、全仓静态/构建结果、最新准确 HEAD 六项 CI、提交证据对齐。下一步产品工作应是独立结构证据与人工复核流程，不应自动放开发布。
