# 书籍理解：人工追加费用授权入口（只记账，不发送备用模型）

## 交付范围

在 #251 的一次性备用预留事务上补齐真实的**OWNER 授权签发入口**。

- `GET /api/studio/book-failover-grants`：只显示当前工作区、当前 RUNNING 书籍理解任务的候选故障记录摘要；只读，无费用动作。GET 返回的候选 **不等同于可安全收费**，实际 POST 还会按数据库状态逐一核验。
- `POST /api/studio/book-failover-grants`：需要真实登录 Session（不能使用开发环境自动 bootstrap）、同一工作区 OWNER、同源浏览器 Origin、显式 `AUTHORIZE_ONE_ADDITIONAL_MODEL_CALL` 字符串，并提供精确任务 ID、操作哈希、冻结计划哈希、预期账本 revision、资源单位上限和有效期（1–60 分钟）。
- `authorizeOneBookBackupCall`：在 Run→Job 事务锁保护下，核验任务租约、权限、冻结候选、源文档版本、操作当前 revision、已记录故障及原 Gateway 的 PENDING / 零 Attempt / 无活动 Claim 证明。UNKNOWN 远端费用、内容审核拒绝、跨工作区、过期任务全部拒绝。
- 成功时只创建一个额外授权凭据 `BookFailoverPaidGrant` 和一个无原文/密钥的 Audit Event；数据库唯一约束阻止第二次签发相同操作同一候选。
- #251 的 `reserveFirstBookFailoverSwitch` 后续仍独立核验权限、预算、model/credential、旧调用状态，CAS 消费 grant 并预留一次新的幂等键。两层校验都必须通过。

## 请求示例（仅示意协议，不在这里执行）

```json
{
  "analysisRunId": "<real-book-analysis-run-id>",
  "routeSlot": "BOOK_CHUNK_ANALYSIS",
  "operationHash": "<64-hex-digest>",
  "planHash": "<64-hex-digest>",
  "expectedRevision": 3,
  "maxAdditionalUnits": 5000,
  "expiresInMinutes": 15,
  "approval": "AUTHORIZE_ONE_ADDITIONAL_MODEL_CALL"
}
```

授权的 `maxAdditionalUnits` 是文本/Token 资源单位上界，不等于美元或人民币。它**不是货币成本预测**。调用发生前仍须通过 WorkspaceResourcePolicy 和后续 ProviderGateway 的收费预算门禁。

## 默认关闭与现有限制

- `FrozenBookFailoverPlan.executionEnabled` 保持 `false`。
- 没有备用模型的真实网络发送、自动生成费用授权、生产数据库迁移或生产部署。
- 当前接口只能对仍在 RUNNING、且首次调用证明未发送的单操作签发授权。**它不是已经打通的用户交互闭环**：必须继续实现用户可见授权控件、运行前额度预批准与可恢复的独立后备模型 Worker 调用。不能将 API 已存在解释成自动降级已可用。
- 审核拒绝、远端未知、超额费用、旧模型/凭据撤销不允许借授权绕过。
- POST 的浏览器 Origin 检查是额外保护，不代替既有 Session / Owner / Workspace 校验。

## 验收

真实 PostgreSQL 回归涵盖跨工作区拒绝、未经批准字符串拒绝、非 OWNER 拒绝、内容审核拒绝、一次性签发及重复签发拒绝、Audit 事件、后续一次性备用预留和原始主调用封禁。无外部 AI / 付费模型调用。
