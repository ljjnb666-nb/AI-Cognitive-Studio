# MiniMax 默认路由与独立语义审校

本轮仅准备请求和执行离线回归，没有新增真实模型或向量调用，没有数据库结构迁移。

## 新任务默认值

未显式绑定的分块理解、归并分析、全书综合，在创建新任务时从本工作区具有有效凭据的启用 MiniMax 服务中选择 MiniMax-M3，协议为 OPENAI_COMPATIBLE，结构输出为 JSON_MODE。存在多个有效 MiniMax 服务时按创建时间和标识排序选择。

默认值不写入用户绑定。显式绑定即使停用或失效也不会被默认值覆盖。缺少有效默认凭据时阻断创建并提示配置；运行期不为缺少冻结计划的旧任务补换模型，也不回退到平台付费模型。向量、音频、图像审核和视频各自保持独立路由。

新默认计划携带 minimaxM3JsonMode=true 配置，仅对精确 MiniMax-M3 的 JSON_MODE 请求启用官方 thinking.disabled 与 reasoning_split。旧快照缺少该配置时保留原有线上格式。不发送未经官方承诺的 response_format，不把思考内容当成最终 JSON。截断、非法结构和引用质量仍由既有门禁拒绝。

前端设置、服务就绪判断和新任务创建复用同一个缺省解析器。设置接口仅返回安全的服务商元数据，不返回密钥密文。

## 独立审校

新增 BOOK_SEMANTIC_REVIEW 文本路由槽，设置接口与高级配置均支持。数据库的路由槽字段原本为字符串，无需迁移。

prepareBookRevisionModelReview 从真实 Run 读取分析模型，检查独立槽的服务、凭据状态、目录能力和模型独立性，存在可用绑定时冻结审校路由。未配置时明确返回 UNCONFIGURED，运行期禁止付费回退。准备函数不执行模型。

消费回执仍核验原分析 provider/model、成功调用、精确请求指纹、证据引用、模型响应身份及消费记录。新路由身份加入路由槽，避免与旧请求混淆。已有 BOOK_SYNTHESIS 审校回执按原槽重建原始身份与指纹，保留旧发布记录的读取和核验能力。

新审校请求将系统指令与完整证据的 UTF-8 字节数加框架预留作为保守输入估算。该值不是供应商 tokenizer 的精确计数。**新增 v2 独立审校策略（book-revision-review-v2）**：输入预算最多 36000、输出上限 16384、最多一次尝试，默认 MiniMax M3 的 `thinking.type=adaptive` 保留复杂原文论证能力；工作区审校专用路由可明确设置 `minimaxM3ReviewThinking=disabled` 做无思考对照。未经明确授权不得自动触发 A/B 两次付费审校。输出上限包含模型内部思考与最终 JSON，并**不等于保证最终 JSON 预留空间**，超长任务优先在后续版本按证据断言分组且保留跨组 BLOCKED 汇总，不得偷偷分段自动重试。

**历史 v1 不变**：旧 `BOOK_SYNTHESIS` 审校请求仍为 3800，已存在 `BOOK_SEMANTIC_REVIEW` v1 为 6144，均保持 thinking.disabled 与原始请求指纹；按数据库已冻结 `pipelineVersion` 选择正确策略重建，不承认未知版本。兼容 OpenAI `/chat/completions` 的端点使用 `max_completion_tokens`，原生 `/text/chatcompletion_v2` 保留 `max_tokens`。HTTP 200 + `finish_reason=length` 即便出现结构正确的 JSON 也一律拒绝作为有效审校回执，保留用量诊断并禁止自动重复付费尝试。此前已花费但为空的回执不予重放，需要重新获得单次调用授权并使用新的 requestId。

**费用和质量门禁**：16,384 是硬输出上限而非实际用量；在真正付费前需核对目标 MiniMax 账户地域、端点、计费模式、准入额度与两种思考策略的每次最大费用。模拟 Adapter 回归只验证请求与回执安全性，**不能证明 adaptive 比 disabled 更准确**；后续若获授权应只在同源原文小样本上做单次、明确预算的质量验证。

## v3 逐项摘要审校（2026-11-06，显式启用 / 不自动付费）

新增 `book-revision-review-v3`，不是替换 v1/v2。默认 `prepareBookRevisionModelReview` 仍生成 v2；只有调用方明确传入 `{ atomizeSummary: true }` 才准备 v3。该准备过程只冻结请求，不执行模型；材料不足或边界不能安全拆分时会明确阻断。生产发布仍需真实独立审校回执、向量与结构门禁。

v3 在原修订文本上进行确定性标点、换行和编号列表拆分，为各摘要项分配 `summary:001` 等独立 ID；每项分别要求 `SUPPORTED` 和至少一处与允许来源坐标完全一致的引用，任何一项 `UNKNOWN/UNSUPPORTED` 都令整体 `BLOCKED`。超长未分段摘要、超过 48 项或单项过长时 **fail closed**，不悄悄截断。摘要的原修订 hash 和持久化内容不变。

v3 使用独立输入 `schemaVersion=2`：各项存来源三元坐标，`sourceExcerpts` 公用表只储存一份源文，减少大量重复长引用。*注意：目前摘要各项继承同一份总摘要证据候选集合*，所以“独立检查”不等于“已证明每项独立绑定到最小证据集”；必须由模型逐项判真，模型质量和误判率仍需真实样本核验，不能仅凭模拟测试宣布通过。

v3 继续采用 MiniMax M3 默认自适应思考、有限的 16,384 总输出 token 和最多一次调用。HTTP 成功但截断、格式异常、无真实来源引用的回执均不可放行；任何真实计费执行仍须明确授权和预算。v1/v2 的输入格式、请求标识、消费回执与历史指纹保持原样，消费或回放必须按历史快照冻结策略选择，未知版本拒绝。

新增集成测试覆盖：默认 v2 vs 显式 v3、独立摘要项 ID、共用原文引用表、局部失败不可伪装为整体 PASS、超长未分段原文拒绝；Provider 测试覆盖 v3 adaptive 思考。**测试通过只证明工程门禁，不证明真实阅读判断能力。**

## 本地验证

- Provider 适配器和模型目录：57 项通过。
- PostgreSQL 预检、零调用保护和文本回执交接：44 项通过。
- PostgreSQL 新旧审校、发布门禁、默认路由和前端就绪：29 项通过。
- Book 冻结路由计划：7 项通过。
- Worker 请求完整性与自动建任务缺配保护：53 项通过。
- 合计 190 项通过。未重跑私有全书 141 分块结构验收。
- Web 与 Worker TypeScript 通过；受影响模块 ESLint 通过。
- Web 生产构建通过。首次使用本机 HTTP 登录地址触发既有 HTTPS 校验，改用专用 HTTPS 构建配置后通过；保留既有 ingestion import.meta 编译警告。

这些结果证明工程兼容性，不证明真实模型审校、向量刷新或全书语义质量通过。精确提交的远端 CI 状态应以 PR 检查为准。

## 官方资料

- [MiniMax 国内定价](https://platform.minimax.cn/docs/pricing/overview)：标准档输入不超过 512K 时，M3 输入 2.10 元、输出 8.40 元／百万 token。
- [MiniMax 国际定价](https://platform.minimax.io/docs/pricing/overview)：对应标准档输入 0.30 美元、输出 1.20 美元／百万 token；不同区域不混算。
- [MiniMax 协议与思考参数](https://platform.minimax.io/docs/api-reference/text-openai-api)：M3 支持关闭思考，思考 token 计入生成上限；M3.1 的参数约束不同，不能套用。
- [智谱定价](https://docs.bigmodel.cn/cn/guide/start/pricing)：独立审校备选 GLM-4.7-FlashX 输入 0.5 元、输出 3 元／百万 token。
- [Embedding-3](https://docs.bigmodel.cn/cn/guide/models/embedding/embedding-3)：0.5 元／百万 token，默认 2048 维；单条请求按文档的 3072 token 限制准备。

所有费率核验日期为 2026-11-05。实际可用权限、账户余额、精确 token 与账单只有获准执行后才能确认。
