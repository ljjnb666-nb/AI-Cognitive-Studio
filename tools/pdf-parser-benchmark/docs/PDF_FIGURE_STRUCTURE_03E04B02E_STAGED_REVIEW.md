# PDF-FIGURE-STRUCTURE 03E-04B-02E｜可信来源隔离待审（2026-10-21）

## 状态与前提

本切片从 PR #100 HEAD `283ab9cd92ef13c9259546f6a35e2a8501546028` 派生。
本文件记录代码边界与待验收事项；**提交代码不等于 CI 或 Windows Edge 已通过**。
截至分支创建时，主 CI `39597507144` 的 core-tests/validate 失败；PDF 专项 `39597507115` 成功。
不得因为新切片 PDF 专项绿灯而掩盖上游播客集成失败。

## 目标

对已经由标准 Python 云端 adapter 产出、留下事前尝试回执的 **canonical INITIAL_ATTEMPT** 图结构结果，
以现有私有本机循环地址自动完成来源校验和候选整理，显示可进入的隔离未认证审核。
无需以后为每个这样的初始结果人工修改永久 `TRUSTED_GRAPH_RESULTS` 代码列表。

**不读取任意目录**：仅支持当前固定的 RB-PDF-12/13 manifest、裁剪路径和严格 canonical 输出。
历史 P127 仍只允许旧版独占草稿路径，不允许另建第二条待审记录。
现有正式 `/api/private-graph/registry` **绝不添加自动条目**。

## 数据流程及边界

```text
本机已存在裁剪和来源 manifest
       ↓ 验 manifest / crop、物理页、区域与文件安全
事先保留的云端请求 receipt + canonical 单区域结果
       ↓ reconcileCloudEvidence + inspectCanonicalGraphResultForRegistration
       ↓ JSON 契约 / 三份 SHA / 坐标及声明字段核验
临时内存 SHA-pinned registry (仅一条请求)
       ↓ readRegisteredGraphBundle 再次按 SHA 读取
STAGED_REGION / WAITING_FOR_REVIEW（不是永久登记）
       ↓ 人工在受 token 保护的 loopback UI 操作
private-region-reviews-v1 中的 SHA 命名草稿
       ↓ 跨进程 O_EXCL + expected revision + 原子 rename
REVIEW_DRAFT_UNATTESTED（不代表人工正式核准）
```

关键路由：`GET /api/private-graph/intake/overview` 已有分类新增 `stageState`、`stagedAvailable`，
分别显示 `WAITING_FOR_REVIEW` / `REVIEW_DRAFT_UNATTESTED`。
`GET /api/private-graph/intake/staged/bundle?item=...` 与
`GET/PUT /api/private-graph/intake/staged/draft?item=...` 必须携带本机 token，
符合固定 Host、Origin、Fetch-Site 限制和单一 canonical item ID。
`privateGraphReadOnly` 禁止 PUT。所有 GET 与 PUT 都重新计算来源证据，服务器
不得采信浏览器自行提供的 path、SHA、fixture、账单或认证标志。

隔离草稿文件名包含书籍 / 区域 / 结果 SHA；重放同一结果不会生成第二个身份；
同一结果并发 PUT 仅一个通过 revision CAS；跨进程加锁。
崩溃留下锁需要人工调查，**不能自动清理**。
模型结果和草稿均不会设置 `graphVerified=true` 或 `humanVerified=true`。

## 明确不覆盖范围

- 不发起额外 14 个 GLM 请求、无支付入口、无授权提升、无自动重发未知计费请求。
- 不导入 PDF 私有原书到 GitHub、公开测试日志或 GitHub Actions Artifact。
- 仅本机持有访问凭据的操作者可查看。**这不是云端多租户工作区授权**，未来转成生产 API 必须另做账号会话和 workspace ACL。
- 来源字节的 SHA 和合同检查并不证明模型语义正确；审核草稿也不是正式可信入库。
- 当前仅认可 canonical 初始尝试；非标准重试目录必须经单独审计，不能泛化扫描。

## 代码与风险审计

- `graph-result-staged-review.mjs`：所有操作重新获取当前证据并构建临时 SHA 登记；
  禁止 P127 和已永久登记 ID；独立于付费执行。
- `server.mjs`：新增两个 staging API，复用 token/同源/CSP/JSON 长度/写入串行队列。
- `graph-result-intake-queue.mjs`：复用已存在的安全分类，增加未认证待审状态。
- `graph-review-app.mjs`：重用已有浏览器 SHA 校验、图结构契约、原子草稿保存、切换 epoch 防跨图覆盖。
- `private-graph-local.test.mjs`：合成双书、P127 保持、只读/鉴权、来源篡改、跨区域、并发 CAS、恢复草稿。
- 尚未完成真实私有 15 区域与 Edge 验收，不能以合成测试替代。

## A2 集成测试独立追踪

`core-tests` 首次失败记录不能删除。2026-10-21 `39597507144` 的
`tests/phase3-durability.integration.test.ts`，`A2 claim/rearm authority races`，
`A2_PODCAST_CLAIM_DID_NOT_REACH_PROVIDER_RESOLVER`。
当前测试 `waitForSignal` 使用上限 10,000 次 `setImmediate` 循环，
该上限不是有保证的墙钟等待时间；它可能在异步 claim/provider 真正到达前耗尽，
但这只是一个**待证实的定时假设**，并未排除 worker 失败、数据库锁竞争、
lease/rearm 非预期胜出等根因。
应检查 PG 的 claim/rearm 时间线、提供者 resolve 标记、Worker 提前退出，
以及首次失败和准确 HEAD 重现。不可仅重复运行获取绿色门禁或删除断言。
Redis overcommit warning 属于保留的资源诊断，不是已证明的根因。

## 验收要求

执行 `tools/pdf-parser-benchmark/tests/private-graph-local.test.mjs` 及完整 PDF synthetic，
并在真实 Windows Runner 的私有 D 盘验证 15 区：P127 登记 1、14 未授权无模型结果；
再用**合成的第二书 canonical 结果**走 staged -> 草稿 CAS -> 重载恢复，
在无明确新付费授权前 **0 GLM 调用**。
精确 SHA 的完整 CI 若未全绿，PR 必须继续 Draft/Unmerged。
