# 统一供应商降级：跨流程安全模型（2026-11-07）

## 目标

未来按用户配置的优先级为 **所有 AI 工作流** 提供故障恢复；不把 GLM → MiniMax → DeepSeek 误用到 TTS、Embedding、PDF 视觉模型上。

本次提交是 **阶段 A：纯决策策略与测试**，**尚未执行自动切换 API 请求**。保留所有现有任务冻结身份、Gateway 用量账本和发布门禁；没有任何数据库迁移或付费调用。

## 12 个执行槽的分级

| 槽位 | 降级候选 | 不变量 |
| --- | --- | --- |
| BOOK_CHUNK_ANALYSIS / BOOK_REDUCTION_ANALYSIS / BOOK_SYNTHESIS | 文本链 | 冻结各次执行身份、已完成分块不可被覆盖 |
| PODCAST_SCRIPT | 文本链 | 幂等脚本段落与每段模型回执独立 |
| SHORT_VIDEO_SCRIPT | 文本链 | 分镜内容 schema 和下游渲染身份可追溯 |
| THINKING_SESSION | 文本链 | 会话消息和归属不可跨用户泄漏 |
| TEACH_BACK_ASSESSMENT | 仅严格 JSON Schema 文本模型 | 评分引用与 rubric 保持不变 |
| BOOK_SEMANTIC_REVIEW | 独立文本审校模型 | 不可自动放松与分析模型的独立性 |
| EMBEDDING | 不允许逐条自动换供应商 | 不同向量空间需重新建索引并切换整套身份 |
| PODCAST_TTS / SHORT_VIDEO_TTS | 有明确音色映射的语音模型 | 声音、格式和媒体片段语义身份必须重新冻结 |
| PDF_VISUAL_STRUCTURE | 独立视觉模型 | 每个外部图像提供者仍须单独授权 |

## 错误处理

- `CONTENT_REJECTED`：**强制停止自动切换**，保留安全审核结果；不能用备用模型自动规避内容审核。
- `TIMEOUT` / `TRANSIENT_UPSTREAM` / `RATE_LIMITED` / `QUOTA_EXCEEDED`：仅当已证明未调用或由供应商证明不会收费，且上一执行完成后，才可能自动选择已授权的下一候选。
- `OUTPUT_TRUNCATED` / `INVALID_PROVIDER_RESPONSE`：可考虑新调用，但必须先将上一已计费回执完整落库、重新核算剩余额度、并在用户事前授权范围内；未知计费结果不能默认免费重试。
- 撤权、取消、预算耗尽、SSRF/网络安全拦截、幂等冲突：阻断自动切换。
- 最多 2 次跨模型切换。无配置、权限未知、凭据未钉住、未清租约、费用结果未知等均 fail closed。

## 分阶段接线（尚未实施）

B. 设计按工作区与槽位的持久化、显式授权候选链、预算上限与模型能力校验，创建任务时冻结到执行计划和唯一哈希；用户 UI 可选择启停与顺序。历史任务默认关闭。

C. 在各流程 Durable Worker 的**任务/阶段边界**接入；前一个 Gateway invocation 必须先终结和对账。后一个供应商必须新建带父执行 ID、模型快照、阶段、来源哈希的独立 invocation，不可复用前者请求指纹或偷偷覆盖原书/音频/短视频的 provider 字段。

D. TTS 增加音色映射与输出格式验收；Embedding 只允许整套向量重建后原子切换；PDF 视觉按提供者单独征得用户授权；独立审校保持模型独立、原文证据和人工发布门禁。均需独立 E2E。

E. 使用历史 `1301`、`402`、超时、截断、非法 JSON 和未知远端回执，做真实 PostgreSQL/Redis、并发撤权和重复支付防护回归。针对新的模型组合，在用户明确许可的预算内进行最小真实对照测试后再启用自动切换。

> 注意：本阶段的 `assessProviderFailover` 是无副作用的准入判断器，不是自动化执行器。仅返回下一候选标识；不能被用于绕过 Gateway 本身的授权、账本、凭据冻结或 SSRF 防护。
