# PDF-FIGURE-STRUCTURE-03E-04B-02A｜参考定价与历史计费证据对账

**日期：2026-10-21 · Draft PR #100 · 核心边界：无网络请求/无付费授权/不修改原书。**

## 本切片已完成

### 1. 官方公开价只作为参考，不当作账户授权

已从智谱官方定价与模型文档核对 `glm-5.3-flash` 的公开刊例价：

- 未缓存输入：**0.8 元/百万 Tokens**；
- 输出：**2.8 元/百万 Tokens**；
- 缓存命中输入：**0.23 元/百万 Tokens**；
- 模型支持原生图像输入（文件或 base64 图像路径），但图片折算的最终输入 Token 数量以实际调用与模型计量为准。

官方信息地址：

- https://docs.bigmodel.cn/cn/guide/start/pricing
- https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash

新增 `annotation/graph-batch-pricing.mjs`：只在**人工假定输入/缓存/输出 Tokens** 的条件下，按单个请求向上取整到“分”，输出参考费用。可检验的值包括 token 假设、未缓存输入 / 命中缓存 / 输出、官方来源与核对日期、参考总分数。它**不能证明图片 Tokens 的最大值、用户所在账户的最终价格、缓存存储收费上限、实际请求完成时的价格**，因此统一标记：

`accountTariffVerified=false`、`imageTokenUpperBoundVerified=false`、`providerSpendUpperBoundVerified=false`、`approved=false`、`dispatchEnabled=false`。

`requireActualSpendBound` 仍无条件拒绝，且已有 `guardBatchDispatch` 始终拒绝；不能伪造 `withinRequestedDraftCapForIllustration` 为实际预算保障。多次请求不是整批折算再取整，避免低估参考账单。

### 2. 只读排查历史 API 尝试，不自动重放

新增 `annotation/graph-batch-reconcile.mjs`：读取固定、预先定义的 per-fixture/per-region、同书旧 batch、P127 特例 retry 目录/标记的**类型和存在性**，不读取模型正文、不扫描其他目录、不获取密钥。针对每个区域归类：

- `NO_PRIOR_PROVIDER_EVIDENCE_NOT_AUTHORIZED`：没有发现历史模型输出/回执。**并不表示已获准调用**。
- `PRIOR_ATTEMPT_OUTCOME_UNCERTAIN`：存在 `.cloud-attempted`、未完成 `-stage`，此前可能已经收费。必须人工核账，禁止自动重发。
- `OUTPUT_PRESENT_REQUIRES_PRIVATE_VALIDATION`：存在历史结果路径，但还未证实结构有效或用户审核通过。禁止覆盖及重复收费。

文件系统遇到符号链接、不支持节点类型或未知 I/O，整个对应检查 fail-closed。统一 `canAutoRetry=false`、`dispatchAuthorized=false`、`providerRequestsIssuedThisRun=0`。

批次对账同时包含**拟选任务和已排除任务**；否则“历史请求不确定”的任务反而会从视图消失，形成账务盲区。

### 3. 真实 Windows 回归事实

[真实 Windows 目录对账 #39588671133](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39588671133)：**SUCCESS**。读取真实私有目录中 P127 与一个 RB-PDF-12 待选区域的受限元数据，不读取图片字节、不对云端发送请求：
- P127 被判断为 `OUTPUT_PRESENT_REQUIRES_PRIVATE_VALIDATION`，禁止自动重发；
- RB-PDF-12 待选区域判断为 `NO_PRIOR_PROVIDER_EVIDENCE_NOT_AUTHORIZED`，仍然没有调用授权；
- Windows 来源公共代码通过精确 Git Blob SHA，真实私人原图与模型文本不进入 Actions 日志。

专项新增的模拟价格、四舍五入边界、来源伪造、P127 retry、批次历史回执及文件系统注入测试均加入合成 Vitest 门禁，测试不使用真实密钥。

**准确 HEAD 的主 CI 历史失败必须保留**：在之前 `abb861e7a6889bff9bcda1ec40ac75c1ed921577` 上，完整主 CI [#39586749187](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39586749187) 的 `quality-performance` 阶段 1/168 播客集成断言失败：`A2_PODCAST_CLAIM_DID_NOT_REACH_PROVIDER_RESOLVER`，最终 `validate` 同样 FAIL；`static`、`core-tests`、`product-acceptance`、`stability-beta` 成功。该问题不因 PDF 专项通过而消失，也不应被直接归因为本切片；必须保留日志并另行定位，未经证实不能称完整主 CI 全绿。

## 目前还不能对 14 张图执行付费请求

这是 03E-04B-02A **价格参考与只读历史对账**，不是 03E-04B-02 完整执行器。仍缺少：
1. 可供执行前硬验证的全量图片 token 计费最大值或账户层有效预算限制，以及准确可审计的最终实付上限；
2. 用户真正明确、可撤销、不可转移且绑定计划和结果 SHA 的签名授权；
3. 和既有 Python GLM adapter 同一幂等命名空间的“计费回执先写后发”，跨进程锁与未知结果不重试；
4. 结果保存、校验、正式注册与跨区域独立人工审核的整链路；
5. 真实 Edge 付费执行验收必须遵循用户授权范围，先低成本单区域，再决定是否扩张。

**未获新付费授权前不读取私有 PNG 用于模型发送，所有新模型请求数量 = 0。** PR 保持 Draft / Open / Unmerged。
