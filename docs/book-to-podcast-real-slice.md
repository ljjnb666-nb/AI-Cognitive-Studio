# 真实电子书到播客：执行记录

本轮目标 active；尚未生成真实音频，不宣称完整成功。禁止回到 OCR 基础设施扩展。

## 2026-10-31 当前状态（以下旧记录按时间保留）

**BOOK_TO_PODCAST_VERTICAL_SLICE_BLOCKED_WITH_EVIDENCE**。真实章节尚无 CurrentPodcastScript/CurrentPodcastAudio；35秒试音成功不能替代章节验收。本地修复及测试不能替代真实模型和浏览器成品。

- 正向样本仍是已获内容处理授权的 Gutenberg #1342 原作第一章：4573字符、39个可信 SourceBlock、5个正式 DocumentChunk，源 SHA、段落范围与原生提取证据保留私有。没有新增 OCR。
- 真实 FlashX Book Intelligence 已 SUCCEEDED（chapter-source-evidence-v2）；13条记忆、18条内容/记忆向量由真实供应商产生。12条记忆有存储证据，1条摘要无证据。模型记忆不是 Gold：已有个别人物归属和摘要语义风险，最终脚本仍须对照原文核验。
- 最近真实 Air 脚本在 SEGMENT_DRAFTING 失败，PODCAST_EVIDENCE_REQUIRED；返回引用了无证据摘要。旧响应、失败 run 和用量保留。没有章节 TTS 请求，没有章节 WAV，也没有章节 Edge 播放证明。
- 修复生产 Gateway 输入：从检索持久化证据快照明确提供 citableMemoryIds/contextOnlyMemoryIds，禁止引用后者；保留背景摘要。未替模型补写引用、删除错误引用或放宽域门禁。新增数据库回归证明错误引用导致整段物化事务回滚、无当前脚本且失败记录保留。
- 真实调用还暴露 JSON 引号错误、schema 回显、错误 span 配对。当前 JSON_MODE 使用完整本地 schema 验证、明确要求数据实例和真实 memory ID；错误响应仍计用量，不在本地修补 JSON。人性化必须逐字保留不可编辑的实质性/证据语句。
- CI ba0eb75 的 41049631704 曾失败：Book sourceSpans 无显式顺序；Phase9 fixture 仍将新 JSON 证据载荷当正文。现已分别按 ordinal 读取、严格验证正文和全部实际证据载荷，不降低断言。后续准确 HEAD CI 必须另验。

### 累计用量与停止状态

截至本次只读核对，付费账本 stopped=true：22次 FlashX、9次 Air、9次 Embedding（26条输入），章节 TTS 0次。31次付费文本请求包含全部失败和超时。7次旧超时没有可用实报用量，费用未知，完整预留保留。

| 模型 | 有实报用量的响应 | 输入 token | 输出 token | 对已知用量按标价保守上估（元） |
| --- | --- | --- | --- | --- |
| glm-4.7-flashx | 15/22 | 31448 | 11985 | 0.051679 |
| glm-4.5-air | 9/9 | 35812 | 8631 | 0.1120224 |
| embedding-3 | 9/9 | 1998 | 0 | 0.000999 |

这些标价计算不是账单。累计预留上界4.726336元；不能从已知响应估算中扣除7次超时预留。官方价格于本轮复核：https://docs.bigmodel.cn/cn/guide/start/pricing 。原独立试音及两次免费模型429不混入此付费账本。

### 已准备但尚未授权的恢复方案

新提示版本 phase9-web-citable-v5，完整复用成功 Book，仅重做播客。Air最多再6次实际请求（包含重试），累计Air上限15次、累计文本仍不超过40次；单次输出最多8000 token，输入按128K最坏档1.2元/百万token、输出8元/百万token预留，每次0.2176元。Embedding保持累计16次/96条，TTS保持24次/1500字符，双音色及语速1.0不变。

拟申请累计预算6.50元（不是新增6.50元）：4.726336旧预留 + 6×0.2176新文本 + 70×3072×0.5/百万剩余Embedding + 0.30剩余TTS = 6.439456元。预计后续正常完成约0.15～0.40元，旧超时实扣仍未知。新授权标记有独立一次性文件并严格核验旧40条预留；重启不自动续跑。网络/超时/JSON结构错误每操作最多重试1次、每次≤50秒；权限/质量/预算错误或两次均失败即停。仅处理同一已授权章节，成功后私有持久化并验收Edge，不发布。

prepare-air-citable 已本地执行，externalCalls=0，approvedForPaidExecution=false。这段方案及代码不是费用授权；收到用户单独批准前不得使用新标记启动。

本地验证：Podcast Gateway/持久化四文件87 PASS，Podcast单元15 PASS；Provider Phase8C 123 PASS；Provider JSON/视觉/预算三文件66 PASS（与前组有重叠，不相加）；Worker生产Gateway30 PASS；Book集成88 PASS；相关lint/typecheck及operator tsc通过。数据库/HTTP fixture测试与真实供应商结果分开。没有本轮新增付费调用。

B03 第15物理页仍为 standard/REJECTED，当前正式提取数和ChunkSet数均为0。未修改旧失败或解除门禁。#215/#216/#217准确HEAD与下表一致，仍Draft/Open/Unmerged。只读集成计划不变；本PR #218继续Draft，不合并、不部署、不公开内容。

## 2026-10-30 初始事实（历史快照）

- 当前工作区原本干净；从 #217 HEAD ea65676a5aac1ad4fe34156dc441b1b575d13b74 创建 codex/book-to-podcast-real-slice 分支，复用原 managed worktree，没有新建 worktree。
- GitHub 重新核验 #217 Draft/Open，CI 41016216322 六项 SUCCESS；#215/#216 及 #209～#212 均仍 Draft/Open。
- 已读取 #217 工程报告及现有播客 services/pipeline/audio、Gateway text/speech、Worker runtime、Web 新建播客页。已有双主持人、逐段脚本/人性化、证据绑定、逐句 TTS、WAV 组装、持久化、幂等和加密回执消费能力，不需要另造引擎。
- 最短路径是可靠原生文本 → 正式提取 → ChunkSet/Book Intelligence → CurrentBookIntelligence → 现有播客多阶段生成 → CurrentPodcastScript → 已绑定的双音色 TTS → CurrentPodcastAudio → Web 播放。
- 当前私有验收工作区仅有 ACTIVE 智谱连接及 PDF_VISUAL_STRUCTURE/glm-4.6v；尚无本轮所需内容理解/Embedding/脚本/TTS 路由。内置真实语音适配器为 OpenAI speech，支持 WAV；不将模拟 provider 当真实语音。
- books 目录目前仅有 B03 扫描原书。fixtures 是合成测试材料，不冒充真实电子书。其他历史单页 Benchmark 也不能替代连续章节及原书来源授权。
- 已向用户询问具体书籍的内容使用授权；后续付费调用必须在明确样本、模型、次数与预算后另行授权。没有沿用上轮已消耗的两次视觉调用授权。

## 最小集成计划（只读评估，没有执行 merge）

| PR | 准确 HEAD | 当前 base | 处理 |
| --- | --- | --- | --- |
| #215 | 4f9d975af11ea144fd9eaa169c061b13863db193 | main | 获得明确合并授权后先集成并验证 |
| #216 | 43a55ecfca01b2a63261bc82a500d60cf3b9ff31 | #215 分支 | 依赖 #215，随后集成并验证 |
| #217 | ea65676a5aac1ad4fe34156dc441b1b575d13b74 | #216 分支 | 依赖 #216，随后集成并验证 |
| #209 | 8f4d44561a0bbed8d5271927293d172fa4faeca3 | 更早的来源 review packet 分支 | 只读审核页已被 #217 部分复用，不能整 PR 重复套用 |
| #210 | 152492c758bc01597bed5183a5ede698afb6cf38 | #209 分支 | 视觉候选读模型与独立 OCR 判定不等价，未认定全被替代 |
| #211 | 978452c0c5f166cd06baa33b5eca418748b9a6f7 | #210 分支 | 显式候选请求机制与 #217 Job 存在语义重叠，不能并行建立第二授权权威 |
| #212 | 51493aeb1f4ac47eeec54f76d0dff431e24eceac | #211 分支 | 原书 Range/磁盘解析/Gateway 视觉部分已复用；人工事件和侧车能力未整体搬入 |

#209～#212 链相对 main 含五个独立迁移（Docling sidecar、layout task、visual candidate、explicit request、human review）；#217 新增的是独立 OCR model review 事件迁移。没有相同迁移文件名，但表/任务/来源状态语义有重叠，不能据此认定无冲突或全部过时。

可执行顺序：先取得合并授权 → 逐个处理 #215 → #216 → #217，每次核验最新 main/head、准确 HEAD CI 与迁移可部署性 → 再处理本轮播客 PR。#209～#212 保持原状，不盲目 merge/cherry-pick；仅对确实未覆盖且仍需要的人工/候选能力逐项做差异移植。未经用户授权，不关闭旧 PR、不删表、不改写历史。

必须保留：standard 默认关闭、源 SHA/claim/lease fence、质量阻断、UNKNOWN 结构边界、模型/人工事件分离、Gateway 幂等/实报用量、运行中结果隔离、付费结果回收及原始数据私有性。现有单元/真实 PG/MinIO/Worker/浏览器/准确 HEAD CI 不得降低。

## 下一步

先确定合法正向原书及连续 3～5 页/小章节；本地提取并检查顺序/缺失/重复，计算实际字符/分块数，再给出具体调用上限与费用授权请求。B03 继续作为 REJECTED 负例，不进入正式提取或播客链。最小音频实际播放前不扩展到整书，不以测试数量代替成品。

## 正向样本已完成非付费准备

用户已明确授权权利条件满足的内容用于私有研发、必要模型/TTS 传输；费用必须另行授权。私有原书权利记录不足，换用 Project Gutenberg #1342《Pride and Prejudice》第一章，原站说明 Public domain in the USA、作者 Jane Austen (1775–1817)。只使用原作第一章，不发送现代导言/注释。来源：https://www.gutenberg.org/ebooks/1342 。

- 原始 EPUB SHA256：2172db6a64d45b02f239cc7b46b50d7117fcd527e2a7a1386694f5eeccd26381。
- 私有摘录 EPUB SHA256：41fef531a3e6347cfcd0a6f3b15208173fbe9efbe6fb7952933227af16f8e776；明确为派生摘录，未冒充原书字节。
- 第一章跨两个原始 spine 文档，从 pgepubid00022 到下一章标题之前；已拼齐，4573 字符。原书和 license 保留，逐段原始文本 SHA 及范围留在私有 provenance 清单。
- 经现有 createUploadIntent/completeUpload/processIngestionRun 正式导入，SUCCEEDED；39 个 SourceBlock，规范化文本与源章节完全相同（仅忽略空白），没有额外 OCR。
- 原有 materializeChunkSet 生成 5 块，状态 SUCCEEDED，内容估算 1151 token；来源范围引用已持久化。零外部调用。
- 私有证据目录 D:\ai-cognitive-pdf-benchmark-data\private\book-to-podcast-real-slice，native-ingestion.private.json、chapter-provenance.private.json、trusted-text-and-chunks.private.json；书籍内容不进入本报告或 Git。
- 项目主库也无 ACTIVE Provider，不能假定另有可用 TTS 密钥。已询问用户可用凭据，未要求在聊天中发送。
- 官方当前文档说明现有 gpt-4o-mini-tts 进入弃用期、计划 2027-01-06 下线；本轮若使用它需明确这一运行窗口，不为了本次验收重写语音架构。现有适配器仅记录本地输入字符数，后续不得冒充实报计费 token。

真实 Book Intelligence、脚本、音频及 Edge 播放尚未完成。待核算具体预算并得到有效费用授权后继续。

## 智谱真实双音色试音已验收（章节播客仍未完成）

用户明确选择智谱官方 glm-tts、tongtong/xiaochen、WAV；先完成约 30 秒试音，再推进章节。已复用既有加密智谱凭据为 PODCAST_TTS 单独配置官方 speech 连接，未输出密钥。没有新建 OCR、Gateway 或播客引擎。

- 官方契约：https://docs.bigmodel.cn/api-reference/模型-api/文本转语音 。非流式二进制 WAV，1024 字符上限、speed [0.5,2]，保留水印；不发送 OpenAI instructions/pitch/SSML。
- 官方价格：https://docs.bigmodel.cn/cn/guide/start/pricing ，GLM-TTS 2 元/万字符。用量字符数为本地确定性计数，明确不冒充 provider 实报计费数据，响应未提供账户扣费。
- 用户分别授权：132 字符、最多4次、0.10元上限；失败后另行授权33字符单句诊断、最多1次、0.01元上限；最后授权剩余99字符、最多3次、0.03元上限。任一失败停止，无自动重试；没有据此调用文本模型、Embedding 或整章 TTS。
- 实际首次请求失败后未发剩余3次。诊断请求得到真实有效音频，但同样被校验拒绝；原始响应留在私有目录。发现官方带 AIGC 水印 WAV 的 RIFF 总长度少4字节，AIGC JSON 还含 NUL 终止符；fmt/data/PCM 全部完整，ffprobe 读出9.428秒、24000Hz、单声道PCM16。
- 精准修复：仅当所有 RIFF 块完整、AIGC Label=1 且总长度恰少4字节时校正总长度，音频数据和水印逐字节保持；其他错长、截断、非法格式继续拒绝。用保存响应离线验证并恢复第一句，没有追加云端调用。原 FAILED Job/invocation 未改写为成功，另有本地恢复证据。
- 后续获得独立授权的3句全部通过真实 Gateway，加密回执消费、Job持久化及用量账本成功。合成顺序 tongtong/xiaochen/tongtong/xiaochen，每句之间0.3秒停顿。
- 成品 glm-tts-audition.private.wav：**35.452秒、1,701,774字节、24000Hz单声道PCM16**；SHA256 `55b3c3953d20f81baeff461de6e0631314dfc7d2aaeb6780a7165d5e0149457b`，私有MinIO存储并回读摘要一致。
- Windows Edge156.0.4314.50真实播放：currentTime推进，paused=false、muted=false、volume=1，最终ended=true，无媒体错误/pageerror。先独立验证9.428秒片段，再验证完整双人试音。已提供成品播放器供用户听感反馈，不把媒体事件当完整章节内容质量证明。
- 实际远程调用为5次（首次失败1、诊断1、补齐3），均来自各次明确授权。可用132字符按标价估算0.0264元；补齐99字符估算0.0198元；最初失败调用是否收费仍未知。没有账户实报总扣费，不将本地估算写成实报账单。
- 语音单元/真实PG模拟transport集成29 PASS；目录及manifest回归13 PASS；provider-gateway typecheck、Lint通过。模拟HTTP测试与上述真实调用分开记录。新的准确HEAD CI、章节Book Intelligence/脚本、正式章节播客及Draft PR尚未完成。

私有证据：tts-audition-result.private.json（首次失败）、tts-diagnostic-result.private.json、offline-recovery.private.json、tts-completion-result.private.json、edge-dual-voice-playback.private.json、edge-dual-voice-played.private.png。所有实际音频、试音稿、响应和原书仅在私有目录，不入Git。

B03入口重新实测：Book请求因无正式提取被拒绝，播客入口返回 CURRENT_BOOK_INTELLIGENCE_REQUIRED；actualTier=standard、REJECTED、正式提取/ChunkSet/BookAnalysis/播客运行均0，新增远程调用0。正向章节已创建双主持人、zh-CN、2分钟的私有节目配置，尚未排队生成。

## 章节接线与真实执行：服务繁忙阻断，未完成成品

用户已听过35秒试音，确认“可以，沿用当前音色与语速”。章节绑定 tongtong/xiaochen、语速1.0；没有以机器媒体事件代替人工听感确认。

完成现有路径的三项小范围接线：目录声明免费 glm-4.7-flash 和 embedding-3；使用智谱官方 embedding 请求体（model/input/dimensions，不发送 encoding_format/task），复用严格向量索引/维度校验和实报 token 解析；Podcast Gateway 按已声明能力选择 STRICT_JSON_SCHEMA 或 JSON_MODE，后者携带完整 JSON Schema 提示，仍执行原有 Zod/来源/质量校验。旧严格输出及持久化回放保留。另修复短节目被提示为15分钟的问题，2分钟配置现在明确120秒、1～2段。

官方依据：
- https://docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash （JSON输出及思考模式）
- https://docs.bigmodel.cn/api-reference/模型-api/文本嵌入 （embedding-3、每项3072 token、最多64项、256/512/1024/2048维）
- https://docs.bigmodel.cn/cn/guide/start/pricing （GLM-4.7-Flash输入输出免费；Embedding-3每百万token0.5元；GLM-TTS每万字符2元）

`tools/book-to-podcast/chapter-acceptance.ts prepare` 已通过现有服务绑定正式章节、语音档案和播放配置，外部调用0。`run` 复用正式Book、Podcast、Audio服务及生产Gateway，不制造已通过的脚本或绕过门禁。所有书文、模型响应和音频仍仅在私有目录。

用户另行批准本轮总预算0.50元：文本最多32次、每次输出8000 token；Embedding最多16次、累计96条，每条按官方3072 token上限预留（≤0.147456元）；TTS最多24次、累计1500字符（≤0.30元）。按当前标价最大合计0.447456元。执行器请求前落盘预留，限制固定模型/官方端点、禁自动重试、失败停止；重启需核对既存记录。预估不是账户实报账单。

实际执行：
1. 首次glm-4.7-flash请求返回HTTP429、错误码1305“该模型当前访问量过大”，request ID `bd9c3b71-41e9-4fa9-b26f-41c3768cd711`。已停止，无后续Embedding/TTS。
2. 用户明确批准额外恢复一次，沿用累计0.50元及原限额，失败请求计入32次文本上限。通过现有Book失败重试服务创建新Job，原失败Job保留；第二次仍HTTP429/1305，request ID `d3ff6089-14e6-4e3a-a2bb-c78e4c5064c7`。再次停止，没有第三次请求。

两次请求均为当前标价免费的文本模型；未调用任何本轮付费Embedding/TTS，响应未提供实际账户账单。Book尚未产生可用理解，章节脚本、章节音频、正式页面章节播放均未完成，不能标记BOOK_TO_PODCAST_VERTICAL_SLICE_VERIFIED。旧35秒试音仍是独立验收成品，不能冒充书籍章节播客。

私有记录：chapter-configuration.private.json、chapter-call-reservations.private.json、chapter-call-reservations.first-attempt.private.json、chapter-resume-authorization.private.json、chapter-response-{1,2}.private.json及meta、chapter-execution.private.json及first-attempt、两次运行日志。未公开书籍文本、密钥或供应商响应。

本地验证：Provider Phase8C **115 PASS**（包含真实PG/迁移、HTTP为确定性transport，非真实供应商成功证明）；Podcast Gateway持久化/回放 **58 PASS**，新增短时长及JSON模式测试后的目标文件 **10 PASS**；Podcast质量/音频单元 **15 PASS**。三个相关包Lint、Worker/Podcast/Provider类型检查及operator严格TS检查通过。章节数据库复核：2个FAILED invocation、各1个REMOTE_FAILURE/RATE_LIMITED、dispatchGeneration=1、CurrentBookIntelligence=0。原失败记录与重试Job分别存在。此检查没有新增模型调用。

完整回归、准确HEAD CI及本轮Draft PR的最终状态以PR说明和交付回复为准。不得把局部通过或Draft PR写成完整交付或真实章节成功；服务恢复后的任何新远程尝试需要用户重新明确授权，本次单次恢复入口已耗用。

## 扩展判断与未完成项

当前可信导入已覆盖一个完整连续章节，39块顺序及5个分块已核验；这只证明本地提取，没有证明真实内容理解或整书可处理。正式Book在首个chunk调用即被供应商繁忙阻断，因此尚无可用Book结果、章节脚本、章节TTS、来源到播客语句对应表、正式页面章节播放证据。整章音频成功前不扩大到更多章节或整书，也不按5块和35秒试音线性外推成本、自然度、内存或处理时长。恢复后先完成本章，并审查每个实质性语句的证据引用，再决定是否扩展。

下一次远程执行前必须获得新的明确授权，核验固定模型当前价格、预算和账户权限；保留两次失败Job/invocation与供应商request ID，使用现有持久化重试服务，不修改历史失败为成功，不通过换run ID或删除账本复活已结束的授权。B03保持REJECTED负例。没有合并、部署或发布权限。

## 付费文本备选与真实调用暴露的修复

用户在免费模型两次429后明确要求评估付费备选，随后单独批准GLM-4.7-FlashX方案，累计预算3.00元，替代已停止的0.50元方案。官方当前输入0.5元/百万token、输出3元/百万token（https://docs.bigmodel.cn/cn/guide/start/pricing），官方模型代码glm-4.7-flashx、上下文200K、支持JSON模式。最多20次文本请求、每次输出8000 token，每次按完整200K输入预留0.124元；加原Embedding/TTS上限，最大2.927456元。预估实际0.15～0.40元，不视为账户实扣。所有新证据在私有paid-flashx-attempt-v1目录，旧免费失败及试音保留。

首次付费执行：前2次HTTP200，有实报1058输入、1759输出token，按未扣缓存优惠的标价上估0.005806元；第3次30秒超时，无可用响应或费用信息。实际仅3次远程POST；Gateway默认deadline替换了适配器不可重试标记，产生一次本地重试，但持久化预算门禁在发网前拒绝，没有第4次POST。现通过原有Gateway execution配置明确maxAttempts=1，避免只在适配器层限制重试。等待上限改为90秒，在原120秒业务租约内为持久化留出余量；不扩大业务租约或改写owner规则。

这2次真实返回还证明：原Book请求只有正文，未发送真实块编号/范围，模型生成了0、source_block_1等占位引用。保持原始响应和Artifact，不补写引用、不当作可用播客证据。修复为在现有AnalysisRequest中传递真实SourceBlock编号、原文UTF-16范围及对应有界文本；本地先逐项核验文本/范围/顺序与原分块一致，Gateway要求按提供的范围引用。结构化输出哈希包括实际出站证据载荷。chunk内容、提取SHA、质量与来源门禁不放宽。

用户另行批准在原3.00元内恢复一次，三次旧预留全保留。用chapter-source-evidence-v2显式提示版本重新生成，旧版本Artifact不复用。此轮3个分块成功、引用均定位到真实范围；第4块90秒超时，只有1个Gateway attempt，未重试。用户又明确批准从第4块恢复一次，复用已完成前三块；付费文本已发7次（含2次超时，费用未知），全部计入20次上限，只剩最多13次，不重置预算。后续真实结果以PR交付说明和私有账本为准，不能从这些部分结果宣称成品成功。

新增验证：Book单元24 PASS、Book真实PG集成88 PASS、Worker生产Gateway模拟集成29 PASS、预算9 PASS。包括错编号/范围/文本/顺序阻断、实发真实ID并物化证据、deadline下单次attempt、恢复后旧预留不丢失。真实供应商调用与这些模拟HTTP测试严格区分。PR #218为Draft/Open/Unmerged；旧HEAD b65dc926499f1cca1c256e4b0bcce488da9dc0b3的CI 41046213452六项SUCCESS，仅证明该旧HEAD，后续提交需重新核验准确HEAD CI。
