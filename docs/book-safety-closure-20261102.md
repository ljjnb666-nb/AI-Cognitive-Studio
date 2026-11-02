# Book 安全闭环验收记录（2026-11-02）

本次仅处理授权身份、取消与落库竞态、历史 27＋1 恢复；不调用真实付费 API，不证明 GLM 1301 已解决。

## 基线及保留范围

- main 基线：`02893afb2fe72b783488ba9c90f6133a8af3eeec`，包含已合并 #233。
- 原整合基线：`00f53633d20fc2f322f275972f9c2ed2be4b117e`。
- 原整合分支及七个已登记 worktree、既有私有备份均保留。
- 本 PR 从 main 提取 Book 白名单文件；不包含原分支的五个界面文件或旧版阻塞报告。不修改数据库结构。
- 最终提交 SHA 由 PR head、CI 的 Assert exact-head checkout 及私有验收记录绑定，不将提交前测试冒充准确 HEAD 测试。

## 三个 P0 的实现与验收

| P0 | 实现 | 证据 |
|---|---|---|
| 授权身份绑定 | 复用 Job 中的授权账本；显式绑定 Run/执行 Job/dispatchGeneration/书籍与提取版本；发送前核对工作区、用户、成员权限、凭据版本、Claim Token、Lease | book-paid-authorization.integration：历史未绑定拒绝、跨主体拒绝、旧 Job/Token/Generation 拒绝、双 Claim |
| 取消与落库竞态 | 锁序 Run → 执行 Job → 授权 Job；发送准入、取消、业务落库使用真实 PostgreSQL 锁；取得锁后按数据库时间重查 Lease；完成原子更新授权状态 | 发送前取消/过期零请求；已发送后取消保留预留并隔离响应；回执保存后取消/过期/换主不产出业务结果；锁等待期间 Lease 过期拒绝写入 |
| 历史 27＋1 恢复 | 141 块合成来源夹具，在真实 PostgreSQL 中通过现有恢复入口创建新 Job；先复用27块，再恢复28块，并模拟 Lease 失效由另一执行者接管 | phase8c-production-runtime：141块及后续阶段完成；旧失败调用/用量/授权记录不变；前27块不再调用供应商；来源分块与偏移全量不变 |

关键代码：execution-authority.ts、ownership.ts、pipeline.ts、gateway-materialization.ts、worker 的 book-paid-authorization.ts、provider-gateway-runtime.ts、Book 队列作用域与消费端检查。

## 27＋1 演练的边界

- 模型使用模拟适配器，数据库和恢复事务是真实 PostgreSQL；Redis 测试运行真实 Worker/队列。
- 第28块旧请求继续返回 TERMINAL_FAILED；同一旧幂等键配新正文返回 IDEMPOTENCY_CONFLICT，不会重新发送。
- 恢复创建不同执行 Job，dispatchGeneration 增至1。并发恢复只有一个当前执行版本。
- 第28块落库后暂停旧执行者、使其 Lease 过期，第二执行者继续完成；旧执行者不能覆盖结果。
- 前27块不可变内容、来源、标识、时间等投影哈希不变；parentId 会按既有后续归并阶段建立，另行验证其指向同 Run 的合法上级产物。不能声称整行没有任何变化。
- 全部分块及 sourceSpans 与演练前完全一致。旧 Invocation、Usage、失败 Job、旧授权账本保留。
- 此夹具不包含私有电子书，也不是对真实历史库的改写。真实历史1420条偏移的既有核验不能由合成演练替代为新一次真实核验。

## 账务、取消及信任边界

- 授权模块不在默认 Worker 中自动启用；可信本机操作者需显式 bind/activate，并通过现有 Gateway resolver 注入。不是新增公共 HTTP 授权入口。
- 新增执行上下文仅在进程内传递；不进入供应商正文、语义指纹或持久化请求快照。接管 Claim Token 不会改变请求的语义身份。
- 请求发送前先提交费用预留，再取得 Run/Job/授权锁完成发送准入；取消先取得锁则不启动 HTTP，准入先取得锁则请求可能已发出。
- 供应商响应等待不持有上述事务。取消不承诺退款；未知网络结果记 REMOTE_OUTCOME_UNKNOWN，迟到且失权的响应记 RESPONSE_QUARANTINED。
- 数据库与外部 HTTP 无分布式原子提交：若发送已启动但准入事务提交异常，已有预留仍保留，操作去重阻止重发；RESERVED 不能作为“必定未发送”的退款依据。
- 预留不等于实扣；不清零未知费用。无效重复请求不新增预留，不覆盖成功竞争者授权。
- 已保存加密回执在取消后可以保留为审计证据，但不能消费成业务产物；不会将未知结果认定成功或伪造退款。
- 历史未绑定授权可读取保留，无法激活或继续发送。恢复失败 Job 需要新的明确绑定授权；不能复用旧授权绕过失败即停约定。

## 测试与独立复核

最终回归范围：Worker 三文件71项、Book PostgreSQL五文件93项、Book单元24项，共188项；最终执行结果以同一代码提交后的私有记录与 CI 为准。类型、ESLint、包构建另列。Worker/Book包 build 脚本本身为 tsc --noEmit。

审查覆盖授权绕过、跨工作区、任务重放、指纹冲突、取消、迟到写入、重复费用、历史兼容、外部调用与原门禁。保留 #233 的原文去重、证据偏移、1301及 sensitive 归类；没有更改审核政策、放宽质量门禁或引入新全局系统。

Git HTTPS 连接不可用时，可通过 GitHub Git Data API 上传逐文件校验过的对象；必须比对完整 tree/commit SHA 后才创建远端开发分支。主分支不改写、不强推。

## 状态与后续

本地门禁通过后方可标记 BOOK_INTEGRATION_VERIFIED / SECURITY_BOUNDARY_VERIFIED / DATABASE_INTEGRATION_PASS / HISTORICAL_RECOVERY_COMPATIBLE。
DRAFT_PR_CREATED、EXACT_HEAD_CI_PASS、READY_FOR_FINAL_REVIEW 必须按真实 PR 与最终 CI 结果判断，不能从本文件推断。

真实 GLM 1301 及全书质量仍需单独授权的真实模型复测；本轮没有进行。完成本轮 Draft PR 验收后停止扩展。
