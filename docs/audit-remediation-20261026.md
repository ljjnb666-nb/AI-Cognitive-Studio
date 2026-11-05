# 审计修复台账 — 2026-10-29

基线：`818da236e59ba0716e456da643fc9fb87610f7f3`，历史审计日期 2026-10-21。
分支：`codex/audit-remediation-20261026`。当前变更仍在验证，未提交、未发布；本表不能作为“所有问题已修复”的声明。

| 问题 | 已实现和证据 | 剩余验收 |
|---|---|---|
| F01 证据输入 | 出站原文切片包含块 ID 和 UTF-16 偏移；真实范围/引文校验；生产分块必须有证据；Phase 9 夹具只读出站载荷 | 最新 Phase 9 Edge 全链路 4/4 已通过；真实模型证据质量未测 |
| F02 综合信息丢失 | 单子节点也综合；多级保留 memory、relations、证据；缓存复用；不收敛时显式失败 | 真实大书语义保真率未测 |
| F03 PDF | 按字形水平间距和行基线恢复词/换行；原生解析版本升级；240 项解析单元通过 | 复杂分栏、表格、公式及代表样本质量仍未关闭 |
| F04 成本/取消 | PostgreSQL 原子资源预留、日/运行限额；每次重试检查取消；取消清理执行租约；43 项 DB 集成通过（含四类运行的并发取消/权限/代数上限） | 资源单位不等于货币预算；四类运行的取消接口竞争已覆盖；取消与实际 Worker 最终产物提交的端到端竞争仍需扩展 |
| F05 语义质量 | 证据覆盖明确标记为结构指标，语义支持为 NOT_ASSESSED | 人工/真实模型语义评估与发布阈值仍未完成 |
| F06 检索 | 在数据库按租户、当前谱系、模型身份过滤后排序，再限制结果；仅加载 top-k 向量；最佳项在候选 25 之后的回归通过 | 当前是数据库精确扫描，非 ANN；大数据性能和分块混合召回未完成 |
| F07 媒体 | 测量 PCM 音量/静音/削波；修复尾部裁剪截断内部停顿后的对白；6 种版式及真实动效；播客 168、视频 38 集成通过；14 个视频单元通过 | 语音准确率/自然度未评估；4 个媒体诊断压力用例为显式跳过 |
| S00 依赖 | 升级 Next/Auth/构建依赖，锁定已修复传递版本；最新 pnpm audit 各级 0 | 锁文件修订后的静态、最新镜像已通过；后续修订仍需最终提交 CI |
| S01 SSRF | 每次连接验证 DNS 并固定 socket lookup；A/AAAA、特殊 IPv6、响应上限、DNS 超时和取消 | 真实 TLS 套接字 7/7：固定 DNS/Host/SNI、证书信任/主机名、生产内网拒绝、跳转、超量响应及取消；本机允许私网仅用于测试服务器，生产策略独立断言 |
| S02 权限 | 共享写入口 OWNER/EDITOR；VIEWER 上传签名前拒绝；成员查询失败关闭 | 全路由 HTTP 权限矩阵、权限变更竞争覆盖仍需完善 |
| S03 上传 | 签名固定 Content-Length；MinIO 拒绝超量 PUT；工作区并发配额；定时清理逐对象验证并持久化回执，可失败重试 | 完整隔离根回归中摄取 179 PASS / 2 SKIP；OCR host 隔离已通过 |
| S04 退出 Beta | 事件/反馈与退出共享参与者行锁；删除和退出原子；重复退出幂等；19 项 Analytics 测试通过 | 完整隔离根回归中 Analytics 19 PASS |
| S05 重试授权 | 每次付费重试重新授权，取消/凭据状态均重新检查；Gateway 146 集成通过 | 已付费远端结果不因本地记账失败而重发；仍需外部供应商验收 |
| S06 账户生命周期 | 密码找回/邮箱验证、TLS SMTP、重置后撤销会话；新增会话绑定的账户/个人学习记录 JSON 导出、快照读取、条数/字节上限、同账户并发限制；Web 186 项通过；单份原始文件附件下载已实现 | **完整数据导出、账户/书籍/工作区的可验证删除生命周期尚未实现**；真实邮件往返未验收 |
| U01 列表 | 20 条分页、查询条件、数据库错误显式展示；仅查询窗口内条目 | 浏览器分页、筛选、空结果、重复查询参数及移动端宽度检查通过；数据库故障恢复体验待验收 |
| U02 状态 | 解析完成与理解完成区分；按当前提取的最新分析过滤列表 | 浏览器全链路待通过 |
| U03 编辑/无障碍 | 用户+工作区+实体隔离的 sessionStorage 草稿、24 小时过期、幂等提交 ID、离开提醒、登出清理；表单标签和跳转主内容 | 刷新/断网草稿、移动端/键盘浏览器验收待补齐 |
| E01 Readiness | 数据库、Redis、S3 探测有超时与连接清理；纳入 Web 自动发现 | 真实故障注入和长期连接数观测待补齐 |
| E02 漏测 | 核心 unit/integration 自动发现；Gateway/Analytics/队列隔离纳入根命令；Web readiness/onboarding 纳入 | 独立阶段 E2E、可选 FFmpeg 压力仍须单独执行 |
| E03 恢复 | 隔离恢复演练 PASS：118 表、2,907 行、加密 canary 解密与对象 SHA256 验证 | 生产全桶/历史密钥备份、生产规模 RPO/RTO 未证明 |
| E04 部署 | 固定 Node digest/pnpm、非 root 应用镜像、Web/Worker/显式迁移 Compose、优雅退出及 readiness | 已构建镜像并通过隔离迁移、PG/Redis/S3 readiness、非 root、Web/Worker 优雅退出；最新源码镜像与隔离运行验收已通过；分支保护设置未验证 |
| E05 性能/诊断 | 向量返回条数受限；活动/近期失败任务窗口、真实计数、租约判断 | 新增媒体按 S3 Range 流式返回、HEAD/取消/租户隔离，17/17 HTTP 回归通过；生产负载 SLO 尚未关闭 |
| E06 文档/维护 | README 更新为实际 Beta 功能；新增部署、密钥和恢复手册；拆分排序/预算/锁/音频测量模块 | 大型 pipeline 模块进一步拆分暂未完成 |

## 当前可复核结果

### 2026-10-29 导出正文读取前的体积限制

- 修复个人导出只在全部正文载入 Node.js 后检查体积的内存风险。现在在同一 Repeatable Read 快照内，先按字段白名单和个人归属由 PostgreSQL 汇总 JSON UTF-8 体积，超限即拒绝，再读取内容；最终文件的精确字节检查继续保留。
- 新增读取前拒绝的回归及真实 PostgreSQL 超大中文正文测试，验证 413、其他账户不受影响、缩小数据后可重试。Web **188 PASS**，typecheck/lint PASS，证据 `output/audit-repair/export-preflight-web.txt`。
- 本次查询改动晚于下述生产镜像及浏览器结果。最新镜像、全仓集成和最终提交 CI 仍待补齐。完整工作区导出、分块导出及可验证删除仍未实现。


### 2026-10-29 最新应用生产容器复验

- 包含个人导出、原始文件下载、取消权限修复和列表参数修复的镜像构建 PASS：`sha256:63c2b8b15752bda52b0c24232d6b80d2771c1dbe7929dba5346dd86cf6fe46ce`。
- 扩展容器验收脚本，实际请求编译后的个人导出和源文件下载接口，要求未登录返回 401 且禁止缓存。新增检查 PASS。
- 隔离容器迁移、PostgreSQL/Redis/S3 readiness、UID 1000、Worker/Web 优雅退出全部 PASS，临时容器、网络和凭据文件清理成功。证据 `output/audit-repair/container-build-lifecycle.txt`、`container-runtime-lifecycle.txt`。
- 这是本地应用镜像验证，不是最终提交 CI；最新完整根集成、完整工作区导出/可验证删除、真实供应商与生产规模验收仍待完成。


### 2026-10-29 原始下载、列表与四类取消验收

- 新增原始文件下载：服务端工作区隔离、强制附件、Unicode 文件名过滤、Range/HEAD/取消、禁止缓存。4 项接口测试通过，真实浏览器下载与上传原件 SHA-256 一致。完整工作区归档和删除仍未实现。
- 修复重复查询参数导致搜索字符串处理失败的问题；三个列表页统一解析重复页码和非法页码。筛选条件变更时同步表单状态，空搜索结果和空分页分别给出准确提示。
- Phase 9 **5/5 PASS**：新增分页无重复/遗漏、跨工作区隔离、筛选重置页码、重复参数、空结果、390px 移动端检查；原有登录、个人导出、Book/播客/音频/视频流程继续通过。证据 `output/audit-repair/phase9-pagination-download.txt`；隔离数据库和桶清理完成。
- 取消数据库测试扩展到 Book、Podcast、Audio、ShortVideo：降权/移除锁等待竞争、重复取消、权限拒绝、终态保护、代数上限，DB 共 **43 PASS**，typecheck/lint PASS。证据 `cancel-all-run-types.txt`。这证明取消服务层的数据库约束，不等于覆盖全部 Worker 晚到产物竞争。
- 最新 Web 集成 **186 PASS**，Web typecheck/lint 与 diff check PASS；证据 `web-after-pagination.txt`、`pagination-typecheck.txt`、`pagination-lint.txt`。
- 上述结果为本地未提交工作区；后文 968 项根集成和镜像结果属于较早修订，不能替代最新完整根回归、镜像验收或最终提交 CI。


### 2026-10-29 个人记录导出与取消权限竞争修复

- 新增账户页 JSON 下载与 `/api/account/export`：服务端会话身份、显式字段白名单、个人父记录归属过滤、Repeatable Read 快照、同账户事务锁、10,000 条/20 MiB 限额及错误脱敏。超限明确失败，不悄悄截断。完整工作区/源文件/媒体导出及删除仍未实现，范围见 `docs/personal-data-lifecycle.md`。
- 最新 Phase 9 **4/4 PASS**，包含真实登录后从账户页面下载并读取 JSON。证据 `output/audit-repair/phase9-personal-export.txt`；该次浏览器验收早于最后的取消权限修订。
- 取消权限竞争修复：取得 run 行锁后重新锁定成员记录并检查角色，直到取消事务提交。真实 PostgreSQL 锁屏障先复现降权/移除后仍成功取消的两个失败，再验证修复；保留 run -> Job 的顺序。
- 取消 HTTP 层明确区分 401/403/404/409/503，未知后端错误脱敏。最新 **DB 28 PASS、Web 182 PASS**，两包 typecheck/lint PASS，diff check PASS。证据分别为 `cancel-authority-before.txt`、`cancel-authority-after.txt`、`web-after-cancel-auth.txt`。
- 以下全根/镜像结果属于此前修订，不能替代新增导出和取消权限修订的最终提交 CI 或最新镜像验收。当前全部变更仍未提交/发布。

### 2026-10-29 迁移后最终环境验收

- 用户完成 Docker 数据迁移至 `D:\Docker\DockerDesktopWSL`；实际配置与 VHDX 路径一致，原 C 盘数据 VHDX 不再存在。迁移前后的容器 ID/名称、镜像 ID/标签及数据卷名称一致，项目 PG/Redis/MinIO 健康。D 盘旧备份已按用户明确要求删除；保留校验和删除记录。
- 最新源码 Next 构建及 Phase 9 Edge **4/4 PASS**，测试数据库和对象存储夹具已清理。AI 使用测试适配器，不代表真实模型质量。
- 最新镜像构建成功：`sha256:9044e630f1320a8b3193954dfe66ba30bfc22a75f91ea7d11375e598e7db2684`。镜像内媒体测试 **21 PASS / 4 SKIP**。
- 隔离生产模式容器验收 **PASS**：数据库迁移、PG/Redis/S3 readiness、UID 1000、Worker/Web SIGTERM 完成；临时容器与网络清理成功。证据：`output/audit-repair/container-runtime-after-migration.txt`。
- 至此最新根集成、浏览器和镜像验证已完成，历史 Docker/满盘阻塞已解除。完整数据导出/可验证删除、真实模型与邮件、生产规模负载等后续项仍未完成，不能据此宣称全部审计问题关闭。

### 2026-10-28 Docker 恢复后复验

- Docker Engine 29.8.1 恢复，PostgreSQL 完成 WAL 自动恢复，原测试库可查询，Redis/MinIO 健康。完整离线 VHDX 备份已读回并核对 SHA-256，保存在 `output/docker-recovery/`；未重置或删除原数据卷。
- 根集成入口新增随机独立数据库、自动迁移、成功清理和失败保留记录。修复取消测试未清理 RUNNING 任务、污染后续全局扫描的问题；未降低业务断言。
- 最新完整根集成 **968 PASS / 2 SKIP / 0 FAIL**：Storage 1、DB 26、Ingestion 179、Book 88、Podcast 168、Video 38、Worker 131、Web 171、Gateway 146、Analytics 19、队列隔离 1。独立数据库已成功清理，记录在 `output/integration/acs_integration_042788e0220a5695_test.json`。
- 下述历史失败和阻塞记录保留供追溯；数据库复验已解除阻塞，最新浏览器/镜像验证尚未完成。
- 最新 Phase 9 串行构建在 TypeScript 阶段报 `Zone Allocation failed - process out of memory`，浏览器用例尚未执行。C 盘再次降至几 MB，未继续启动镜像构建。已请求迁移旧 Docker 更新缓存（约 11.2 GiB，非原数据卷）至 D 盘，等待用户答复；未清理项目外文件。

证据保存在 gitignored `output/audit-repair/`，避免提交本地数据库/凭据/浏览器状态。

- Phase 9 Edge：4/4 PASS，覆盖真实登录、配置、上传、Book 分析、错误重试、播客音频与短视频。AI 为测试适配器；不代表真实模型质量。
- 根单元分段执行：Domain 64、Shared 9、Ingestion 240、Book 34、Podcast 16、Worker 45、Gateway 120 PASS；Video 最新 21 PASS / 4 SKIP（含时长单位回归）；上述分段单元合计 549 PASS / 4 SKIP。
- Web 上轮 154 PASS；本轮媒体流式/Range/HEAD/权限/取消新增 17/17 PASS；最新全量复验尚未结束。
- 摄取最新完整运行 177 PASS、2 FAIL、2 SKIP；两项失败为固定 OCR 测试 host 与中断残留冲突。随机隔离后该文件 12/12 PASS，未删历史残留或放松执行围栏。
- 历史当前分支集成证据：DB 26、Book 88、Podcast 168、Video 38、Worker 131、Gateway 146、Analytics 19、MinIO 1、队列隔离 1 PASS。不能将历史结果替代最后修订后的回归。
- 最新源码的全仓串行 typecheck/lint 已 PASS；并行复验曾出现 TypeScript/Next/Book 进程内存不足。随后测试报 ENOSPC，系统盘可用空间不足 1 GB；改用 D 盘任务临时目录后 Video 21 PASS / 4 SKIP。Docker info 和 PostgreSQL 直连仍超时，本轮镜像构建已停止；未自行重启全局 Docker。
- 上一个成功镜像：`sha256:0918725fab2aa760d42c662bcc1045320774b8bef4e0c4c62699954fc3e74f62`；14 个实际音视频测试 PASS / 4 SKIP；独立生产模式迁移、readiness、UID 1000、Worker/Web SIGTERM PASS。它早于最新媒体/时长修订，不能标为当前源码镜像。
- 2026-10-28 依赖审计为 0 info/low/moderate/high/critical。恢复演练：118 表、2,907 行、加密 canary 与合成对象 SHA256 PASS；不代表生产全桶恢复或 RPO/RTO。
- 本轮额外修复：短视频完整请求体预算（5/5）、共享引用不误判循环（3/3）、短视频时长毫秒容差（2/2）。

## 接下来必须完成

1. Docker/数据库恢复、最新 Phase 9 和镜像已通过；继续补草稿、分页、移动端和权限浏览器验收。
2. 保持已通过的静态、核心回归、依赖审计和差异检查，完成其余修订后再验证最终提交与 CI。
3. 设计并实现导出/删除：先冻结写入和任务执行，再清理并验证对象与向量，最后删除 SQL；任何阶段失败必须留下可重试回执，阻止晚到任务复活。
4. 用代表性真实 PDF 和供应商输出建立质量阈值；明确真实服务调用和人工评估证据。
5. 在隔离生产规模数据上测负载和恢复目标；核查 GitHub 发布门禁。完成前不能把工具定性为成熟生产系统。
