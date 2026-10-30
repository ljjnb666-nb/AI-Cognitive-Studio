# STEP6-2B-2 持续开发验收记录

当前目标仍为 active，尚未通过全部验收。以下是 2026-10-30 的最新实现进度；后附上一轮历史记录，不把历史未完成状态当作本轮最终结论。

## 本轮已经接入的处理链

- 来源授权：执行前、结果返回前、checkpoint 提交事务内核验 SourceBlob / SourceDocument / run / Job / plan / page claim 与有效租约。提交事务持有权威行锁，租约使用 clock_timestamp()；完成 checkpoint 的恢复也重新核验当前 run 与源身份。
- 模型库存：项目固定的 4.0.3 ONNX + llama-cpp 清单含 15 个模型/配置资源及必需的空 VLM completion sentinel，共 16 项。批准摘要 `3382d142ef28eeeda138fd13786ec41e591007c852aca1487b424850f8c179ad`。该摘要是本项目的版本准入基线，不是上游签名或全供应链安全证明。
- 实际加载隔离：standard 读取 claim 内复制并校验过的模型副本，不读取运行期间可变的模型缓存；固定 onnx/llama-cpp 后端并清除继承的 MinerU 配置覆盖。复制前后和识别后检查模型文件。权重未进入 Git。
- 执行事实：新增 OcrPageExecution 历史表和 checkpoint 的 proposed/admitted/actual tier、模型与清单、源身份、claim、执行状态和质量状态字段。未启动解析时 actualTier=NULL；flash 不拥有 standard 模型身份。失败与重试历史分别保留。数据库触发器拒绝改写历史回执。
- 质量拦截：空输出、控制字符、乱码、重复块、页码不符和结构风险分为 ACCEPTED / REVIEW_REQUIRED / REJECTED。Markdown 没有独立结构证明，因此所有 standard 提案的结果需人工复核；不将非空文本视为结构准确。待复核 checkpoint 不进入正式 extraction 或 current extraction。
- Prisma 增量迁移：`20261030010000_ocr_execution_receipts`、`20261030011000_ocr_receipt_immutability`。历史字段保留 NULL，表示未知；回滚脚本在 `docs/operations/step6-2b2-rollback.sql`，应停新 worker、先导出回执证据，再由操作员决定执行。测试事务回滚演练结果待补。

## 最新真实证据（本地，不等于新 HEAD CI）

- PostgreSQL / MinIO / MinerU 真实门 **5 PASS / 0 FAIL / 0 SKIP**，201.97s 测试耗时。包含真实私有 B03 PDF 经服务处理到 standard 回执、fenced 持久化、REVIEW_REQUIRED 状态及正式发布计数=0；重复调用不重新执行 OCR。
- 私有 MinIO 仅绑定 127.0.0.1:19000，数据绑定到指定私有数据目录，不写公共 Docker 数据卷。实际源对象、识别对象及 proof 均保留私有；公共报告不含正文。
- 来源授权 / checkpoint / routing 组合测试最近 **50 PASS / 0 FAIL**；新增 checkpoint 恢复来源替换用例尚待本轮复跑。
- 单测最近 **307 PASS / 2 SKIP / 0 FAIL**。两个旧 symlink 专项在 Windows 跳过；另新增 Windows junction 逃逸测试已通过。
- ingestion typecheck/lint 已通过。整链新增分段计时及资源采样正在复跑，最终数字待补，不能把先前 RAM/显存快照当峰值。
- 保留失败证据：首次真实授权门因低内存降级造成 1 FAIL；固定模型副本首次遗漏 MinerU 必需 completion sentinel，导致 managed 配置被 HTTP 400 拒绝，整链门 2 FAIL。已根据实际 registry/download 源码补齐固定 sentinel，之后真实门 5/5 通过；不是跳过引擎门禁。

最新补充：来源/checkpoint/routing 组合测试已达 **52 PASS / 0 FAIL**，覆盖恢复 checkpoint 和最终 canonical 发布时的源替换拦截。ingestion build、worker/shared typecheck 通过。迁移已在独立测试库进行 BEGIN/ROLLBACK 演练：事务内移除新增结构，回滚后恢复，未改写迁移历史。

带资源采样的整链复跑 **5 PASS / 0 FAIL / 0 SKIP**，186.91s 测试时间。服务总时间 72.058s，snapshot 4.024s、doclib start 2.739s、engine-ready 44.200s、parse 12.116s。engine-ready 含进程启动和轮询，parse 含 CLI/调度，不作为纯模型耗时。RSS 合计采样峰值 3,614,621,696 字节（共享页可能重复计数）；全设备 VRAM 采样峰值 2236 MiB、基线 321 MiB；退出后系统可用内存 5,446,496,256 字节。热引擎复用尚未验证。

公共脱敏证明见 `docs/evidence/step6-2b2-standard-chain.json`；不包含原文、私有路径、source fingerprint 或 claim token。

CI 修复记录：`a1f3600` 的 CI `40922239516` 失败。web/Next 的 ProcessEnv 合并声明要求 NODE_ENV，过滤环境对象后类型丢失；另有 CLI-double 夹具将 storage key 哈希误记为 PDF SHA，触发新增来源拒绝。已显式保留原 NODE_ENV，并让夹具记录实际字节 SHA；没有降低来源门禁或修改原断言。对应 17/17 回归及 web typecheck 在本地通过。新增 doclib PID/server_id、managed 端口绑定与 256 KiB 状态响应上限；HTTP/准入组合测试为 24 PASS / 2 SKIP，新真实门正在复核，不能提前算作通过。

## 仍需完成的完整目标

managed engine 的真实取消、超时、父进程崩溃、恢复和资源回收矩阵；HTTP/端口与进程身份绑定的独立验证；冷启动及热运行与峰值 RAM/VRAM 的明确测量；全仓相关回归、真实 Worker、准确新 HEAD 的 CI；统一代码复核及最终验收报告。

PR #216 保持 Draft，base 仍为未合并的 #215。未经授权不合并、部署或开启生产 standard。旧 HEAD `8f537d9` 的 CI `40912790553` 现已六项 SUCCESS；这不证明未提交的新改动通过 CI。

---

## 上一轮历史记录（截至 8f537d9）

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
