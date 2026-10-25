# PDF 正式架构 · Docling 持久化执行权（PR #190）

## 基线与范围

基于已完整通过主 CI 的 #189 `1dcc1925a1cdf4ec2a4c689eb90b8def86b64daa`。
本切片只改进 Docling **非权威布局候选**后台执行权，不自动开启该功能，不改变 PDF.js/RapidOCR 正文、当前提取指针、拆书分析启动事件或 MinerU 生产路径。

## 不变量与防线

1. `DoclingLayoutTask` 为 PostgreSQL 唯一的执行/尝试预算权威，复合关联 `ingestionRunId + sourceDocumentId + workspaceId`，唯一任务键还绑定 0-based 页码、routingGeneration 与离线模型 SHA。新增 SQL 检查：次数限 0～2，RUNNING 必须同时携带令牌和租约，非 RUNNING 禁止遗留令牌。
2. 抢占是**数据库时钟的原子 UPDATE ... RETURNING**：仅允许 PENDING 或租约确已到期的 RUNNING，且 `attemptCount<2`。一次成功抢占立即消费一次持久尝试。多个主机同时抢一个任务最多只有一个取得合法 token。
3. 成功/失败结算必须匹配当前 token、RUNNING 状态及未过期的数据库租约；过期旧执行者无法结算。失败从第一次返回 PENDING，第二次返回 FAILED；Redis 的任务清空、重建或多次重试不能重置数据库尝试次数。
4. **候选快照写入加锁防线：** 后台 Worker 把 claim token 传入 #188 sidecar；写入 PostgreSQL 快照元数据时在*同一个事务* `SELECT DoclingLayoutTask ... FOR UPDATE`，逐项验证租户/来源/run/页码/代际/模型 SHA、令牌与数据库租约。旧执行者最多遗留未引用的 S3 内容寻址对象，不能发表候选快照元数据。
5. 首次投递使用原 JobId，花掉一次数据库尝试后的第二次投递附加 attempt 后缀。数据库记录决定是否重新入队；终态成功/失败不重新执行模型。已存在快照的历史任务可在安全边界结算。
6. 独立的受限历史恢复扫描不限于最近 7 天（只处理已建立的持久账本、过期租约或等待超过 2 分钟的 PENDING）；新发现仍沿用近 7 天、单页复杂内容证据、单次最多 20 runs、每书最多 2 页的额度。

## 工程验收要求

- 新增真实 PostgreSQL 并发用例：同页两主机只有一位持 token，租约故意到期后新 token 可抢占，旧 token 对 sidecar 写入与终态结算均被拒绝。
- 新增 Redis 丢失恢复用例：第一次失败后只投递第二次的稳定任务身份，再失败则永久 FAILED，无第三次计算。
- 保留已有真实 PostgreSQL 候选路由、来源验证、存储及默认禁用回归，并要求完整主 CI exact HEAD SUCCESS。
- 本 PR 不含实际云端调用或私有书籍读取，不上传电子书 Markdown/图像，也不自动启用 Docling。

## 尚未解决的明确风险

- 本账本是**逐页逐模型执行权**，不是多页、跨主机全局 Docling CPU/GPU 容量信号量；同一主机 Worker 本地并发仍是 1，但多主机总并发尚未全局限制。
- 不适合在网络或对象存储层无限阻塞情况下长期运行：5 分钟租约没有周期续租；过期时旧结果被严格拒绝，代价是可能浪费一次尝试。下一切片应实现续租心跳和跨主机容量租约及故障注入。
- 未完成真实 Docling Python + Redis + PostgreSQL + S3 同次 E2E；上游 #187 只证明离线模型合成页真实运行。
- 真实五书独立 gold 0/5，CER=null；Issue #161 OPEN，正式架构尚未冻结。

PR #186～#190 保持 Draft/Open/Unmerged。未经用户明确授权不合并、不默认生产启用。
