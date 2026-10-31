# 结构证据与模型审核闭环验收报告

日期：2026-10-30。分支 `codex/ocr-structure-model-review`，基于 #216 的 `43a55ecfca01b2a63261bc82a500d60cf3b9ff31`。

## 真实产品结果

已完成一个真实扫描页的纵向切片：完整原书导入 → 指定物理页 MinerU standard → 来源审核页 → 显式页级授权 → 工作区 GLM‑4.6V → 独立事件及用量账本 → 拒绝结果展示及素材阻断。

实际结果 **REJECTED**。OCR/模型执行成功没有被当作质量通过。真实运行的 DocumentExtraction、CurrentDocumentExtraction 均为 0，未授予播客素材或发布权。本轮验证审核链，不宣称 Gold 准确率。

未合并 #215/#216 或 #209～#212，未改写其历史，未部署或开启生产 standard。原 dirty checkout 未改动；复用现有 Codex managed worktree。

## 集成与来源权威

- #216 的 standard 结果被门禁保留为 OCR_REQUIRED / SOURCE_OCR_REVIEW_REQUIRED，既有审核链只接受 currentExtraction。为展示而发布 canonical pages 会绕过质量门，因此直接读取不可改写 execution receipt 和 content-addressed OCR artifact。
- 按文件复用 #209 的审核页面、#212 的 SHA/ETag Range 预览、Gateway 视觉输入和磁盘分段 PDF 解析。没有盲目合并堆叠 PR、重做 OCR 选型/库存/执行架构或 Gold Benchmark。
- 继续以 SourceDocument / SourceBlob / IngestionRun / OcrPageAttempt / execution receipt 为权威，不另造 SourcePage/SourceBlock。
- OcrModelReviewEvent 独立于原人工事件，关联 Job、OCR receipt、Gateway invocation/snapshot、provider 配置及实报模型、证据 SHA、六维理由、真实用量；数据库拒绝 UPDATE。
- 原页图直接渲染原书同一物理页，不是 OCR 重建图。API 核验成员、最新运行、原书 SHA、页号和 receipt，IO 后再次核验，私有 no-store；保留完整 PDF 的受控 Range 链接。

## 真实执行证据

完整 B03 原书：151,495,200 字节、271 页；第 15 物理页（索引 14）。原书/图片/正文/账号/密钥及原始模型响应仅留本机私有目录，不入 Git/GitHub。

| 项目 | 已核验值 |
| --- | --- |
| 原书 SHA256 | `5be652d2066b680f1242bf358979c549aaf8a1588d9648926ecd8b6c30697440` |
| actualTier | `standard`，真实 MinerU 4.0.3，执行约 72 秒 |
| 模型版本 | `mineru-4.0.3-onnx-llamacpp-q8-v1` |
| 批准清单 | `3382d142ef28eeeda138fd13786ec41e591007c852aca1487b424850f8c179ad` |
| OCR receipt | `cmvukhtoq00797bs0whgoy0lh` |
| OCR 文本 SHA256 | `2e4e265547cb696a15e1ca2ff74dc0f78284072ba8379486fd39abc789e663d8` |
| OCR 文本 | 782 字符 |
| 原页 PNG | 715 × 1015，387,844 字节 |
| PNG SHA256 | `85fad6515d4a762c44bc4b853dd8ce1825a49a7c7896a4f63c18017ebaf82a6d` |

从完整原书执行指定页，未执行页保持 PENDING/UNRESOLVED，局部执行不能发布整书提取。资源下限、模型完整性、claim/lease、stop/reconcile 及质量门继续生效。旧单页样本 SHA/索引未被冒充为完整原书身份。

## 两次独立授权及模型结果

用户分别明确授权首次和额外一次调用：只发送同一物理页图及该页 OCR，每次最多一次尝试、8 MB 页图、1600 输出 token；不发送整本 PDF、不自动重试、不授权发布。Provider 密钥由用户直接在 Edge 密码框保存，未在聊天或日志输出。

1. 首次 Job `cmvukutm200017b8o1sju18dg`，调用 `1660ea1f-647a-45ae-979c-eee1b4cc2174`：约 20.9 秒后 INVALID_PROVIDER_RESPONSE，无可用判定及用量回执。具体响应形态及费用未知；没有重试或补造结果。
2. 用户额外授权后，新建关联失败父任务的 Job `cmvul4hzd00037b8og88epq9x`，保留原记录。调用 `c52f0185-f586-4de6-8e95-1e9cc6bc9e64` 成功，独立事件 `cmvul56vz00037bdkv083geqz`；配置及实报模型均为 `glm-4.6v`。
3. 成功调用实报 **1764 输入 token / 314 输出 token**，账本 SUCCEEDED，金额 UNPRICED。首次费用未知，不能把本次用量当两次总费用，不编造人民币上限。
4. 文字遗漏、侧栏阅读顺序、图像占位符维度为 ISSUE；表格、图表、公式为 CLEAR，聚合为 **REJECTED**。证据摘要 `53277db14183d38bd0aa57bec94307e0480e05b6f0cd63c1a33f4e541b9fe0e0`。

失败诊断修复：后续已计费但不可解析的 200 回复保留实报用量及非正文诊断（结束原因/字段类型/字符数），不把正文或推理写入账本。首次已丢失数据不补造。按[官方 GLM‑4.6V 文档](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.6v)及[对话补全契约](https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E5%AF%B9%E8%AF%9D%E8%A1%A5%E5%85%A8)，该页审核关闭默认思考、约束简短 JSON，未提高 1600 token 上限。截断/内容过滤即使残留 JSON 可解析也不接受。首次精确失败根因未知，不声称已经复现。

## 一次性、权限与并发

- 真实 Better Auth 会话、规范站点 Origin、OWNER/EDITOR、精确来源四元组及 receipt/SHA、当前视觉路由和 credential version；dev bootstrap 身份不可发起付费审核。
- 每份授权使用现有 Job，15 分钟有效、claim token fence。并发点击/领取最多一次调用；RUNNING 不重新领取，失败不自动复位。
- 额外调用必须另行明确同意，引用同来源 FAILED Job 并创建幂等子 Job。成功或运行中任务不能重新授权；并发额外授权收敛到同一子任务。
- consumeTextResult 事务内重查成员/期限/Job claim/来源/页结果，然后保存事件并完成 Job。run → document → blob → page 锁保护结果，document FOR UPDATE 也阻止后继 run 的 FK 插入越过校验。
- PostgreSQL 确定性锁观察证明后继 run / page claim 修改会等待证据锁，释放后旧证据被拒绝。
- 全 CLEAR 才 PASSED；任何 ISSUE 为 REJECTED；有 UNKNOWN 且无 ISSUE 为 REVIEW_REQUIRED。三种状态均不授予素材/发布权。

## 验证

- Worker：16 PASS。真实 PostgreSQL/MinIO/PNG 渲染及生产 Gateway 加密仓库，只有 HTTP 为模拟；覆盖三种结论、一次并发领取、过期/撤权/换源/换页、迟到 plan/后继 run、失去 Job claim、畸形/截断响应、显式额外授权、不可改写事件。
- evidence/consent PostgreSQL：13 PASS；跨书/页/工作区、替换对象、后继运行、并发授权及真实锁观察。
- Gateway 视觉/独立判定：19 PASS，已加入现有 Phase 8B CI；完整 Phase 8B 本地 69 PASS。
- PDF 路由集成：16 PASS；指定页一次执行，其余页未解决且无正式提取。
- 全仓单元：476 PASS / 2 SKIP；全仓 Lint、typecheck 已通过。完整集成、构建及准确 HEAD CI 最终计数和运行链接以本 PR 说明及交付回复为准，运行中不算成功。
- 两个增量迁移向后兼容；独立验收库和全新回归库均从 57 迁移成功部署，未改历史迁移。
- Windows Edge 156.0.4314.50：真实注册/登录、用户保存 Provider、绑定 GLM‑4.6V、两次显式页面操作、拒绝结果、完整原页 PNG 解码且摘要与模型图片一致，无 pageerror。
- Edge 负例：错误 SHA/物理页 404，匿名原书读取拒绝，缺失/恶意 Origin 403，匿名授权 401，错误页授权 409，重复授权返回已完成任务。没有第三次模型调用。

修复过程保留失败证据：JSONB 计划摘要夹具改用数据库返回表示；规范站点 Origin 与 Next 内部 URL 不同；Edge PDF iframe 缩放/滚动导致原页不完整，复用原有渲染器展示同 SHA 原页；Next 将 new-URL 脚本变成静态资源，改为 Node 原生磁盘模块解析。没有削弱断言。

首次全仓回归误用含真实 Gateway keyring 的验收环境，额外 Book 后台处理使两组旧夹具 147 断言通过但清理失败；保留失败记录，改用与 CI 一致、不携带该能力的新独立回归库重跑。私有 MinIO 起初缺少 CI 的 CORS 配置，已限定合法本地 Origin，未放宽应用或测试。构建首次因生产 HTTPS 契约拒绝本地 HTTP，后按 CI 的 NODE_ENV=test 验证；未放松生产 HTTPS 校验。

## 保留风险及回滚

- bbox、表格/图表/公式细节无可信结构，明确 UNKNOWN；段落按 OCR 输出序列展示，几何阅读顺序未经验证。
- 模型可能误判：本次“页眉遗漏”理由与 OCR 已含书名可能矛盾；占位符属于结构标记，不能直接当正文事实。保留原理由和拒绝状态，不强行改为通过。
- 单页不能外推整书结构或准确率；首次费用未知，人民币计价未接入。
- 按需视觉审核需 PDF_VISUAL_REVIEW_ON_DEMAND_ENABLED=true、有效 Gateway 配置和私有临时目录。生产 standard 双开关仍默认关闭。
- 回滚优先关闭可选功能并退回应用版本，保留审计表/账本。撤销 DDL 必须先备份并另行批准，不能把 DROP 审计数据当常规回滚。

私有证据目录：`D:\ai-cognitive-pdf-benchmark-data\private\ocr-structure-review`。current-page.private.json、real-model-review.private.json、first-failed-model-review.private.json 及 Edge 截图可本地核验；密钥、账号、书籍正文/图片不上传。

本轮完成后停止扩展 OCR 审核基础设施；下一轮直接进入多页/整书导入到播客生成的端到端试运行。
