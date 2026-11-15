# Book AI 故障切换：持久化操作账本与保守结果对账

## 交付范围
承接已合并的 PR #248（冻结主备模型身份），新增一张有数据库复合外键与 CHECK 约束的 BookFailoverCheckpoint 表。按 `(analysisRunId, routeSlot, operationHash)` 逐操作记录候选序号、已切换次数、执行状态、前次调用/尝试 ID、结果归类、失败原因与修订版本。

Worker 进入新书分析阶段前，复核已冻结计划和当前 Book 执行 Claim（工作区、用户、Job ID、dispatchGeneration、claimToken、运行状态和租约）。首次遇到配置了备用模型的操作时建立检查点；重复消息不重置候选序号或计数。发生失败时，通过同工作区、同幂等键关联 ProviderInvocation 与最新 Attempt，重新核对主模型、连接 ID 和凭据版本，原子记录观察结果。

## 保守对账原则
- 任何已进入远端尝试阶段的记录均为 `UNKNOWN`，包括 TIMEOUT、REMOTE_FAILURE、SUCCEEDED 与 REMOTE_OUTCOME_UNKNOWN，不能凭错误字符串宣称免费；`RUNNING` 且没有尝试行也按 UNKNOWN。
- 仅完全不存在 Invocation，或仍为 `PENDING` 且无远端尝试的 Invocation 可标记 `NOT_SENT`。两者都不是允许收费重试的授权。
- 内容审查拒绝单独记录为 `CONTENT_POLICY_REVIEW_REQUIRED`；未知远端结算为 `UNKNOWN_BILLING`。
- 所有检查点维持 `state=HOLD`、`candidateIndex=0`、`switchesUsed=0`，从不触发备用 Provider 请求；这一步没有后台付费调用。
- 不改现有 Book 当前产物、Embedding 向量空间、播客/TTS/短视频运行行为，也不修改现有 UI。

## 后续真正执行切换的必要条件
必须有额外的服务端真实付费授权、剩余预算、对原 Invocation 的可验证结算证明、无其他活动 Claim、原子预留下一个 Candidate、新的幂等键与调用血缘，以及关机重投、租约失效、跨租户、旧凭据撤权的确定性测试。未经这些门禁不允许把仅表示用户偏好的 requestedEnabled 当作执行授权。

## 验收
新增纯单测覆盖不确定收费与内容拒绝；原有 PostgreSQL durability 集成测试新增首建、重复投递、幂等观察、不同操作独立计数、过期/错误租约和计划篡改验证。需要准确 HEAD 的 Schema/Migration、Typecheck、单元/集成、容器、产品与 Beta 全部通过之后才能合并。