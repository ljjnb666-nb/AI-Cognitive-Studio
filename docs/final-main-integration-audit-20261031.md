# AI Cognitive Studio 最终主干集成审计

日期：2026-10-31（Asia/Shanghai）。范围为用户确认的主干集成准备与本机配置；不部署、不合并、不启用生产 OCR/审核、不新增模型或 TTS 调用。

## 结论与适用范围

本报告提交时：**BLOCKED — 等待本轮修复的准确 HEAD CI**。局部测试和旧 HEAD 全绿不替代新提交的六项完整检查。最终 READY_TO_MERGE 判定以交付报告与 PR #218 最新检查为准。

发现并修复四项实际问题：校订写权限及撤权竞态、Provider 实际建连 DNS 安全、破坏性回滚入口、审核外键 schema metadata 与既有 DDL 不一致。没有新增数据库迁移、OCR 引擎、审核机制或播客功能。

READY_TO_MERGE 仅表示可在取得明确授权后按下列顺序合并；不表示现在可以启用 standard、自动审核、付费任务或生产部署。此前真实 103 秒播客和 B03 拒绝证据保留，未重跑供应商。

## 准确基线与依赖

| 对象 | 准确 SHA | 基线 / 状态 |
| --- | --- | --- |
| 最新 main | `d6e058912442f3a0b48a53334897e4ca3cb63155` | branches/main 与 fetch 一致 |
| #215 | `4f9d975af11ea144fd9eaa169c061b13863db193` | main；Draft / Open / MERGEABLE / CLEAN |
| #216 | `43a55ecfca01b2a63261bc82a500d60cf3b9ff31` | #215；Draft / Open / MERGEABLE / CLEAN |
| #217 | `ea65676a5aac1ad4fe34156dc441b1b575d13b74` | #216；Draft / Open / MERGEABLE / CLEAN |
| #218 原产品验收 | `87ab3acbc2bff47f1207dbb5fa64c6d2457908e5` | #217；本轮必要修复追加在其后，未重写祖先 |

`git merge-base --is-ancestor` 验证每一条边均成立，独立增量提交数依次为 10 / 8 / 4 / 16。主干没有在这些分支之后独立前进。#218 修复后的准确 SHA、GitHub 合并状态和 CI 必须再次实时读取，不能继续使用原产品验收 SHA 作为新代码的 CI 证据。

原四个 HEAD 的 CI 分别为 [40908016472](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/40908016472)、[41005661534](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/41005661534)、[41016216322](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/41016216322)、[41168187648](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/41168187648)，均六项成功；只证明其对应旧准确 HEAD。

GitHub 允许 merge commit，且未启用合并后自动删除分支。main 当前没有 branch protection；本轮未修改仓库策略，不能把 MERGEABLE/CLEAN 当作授权或安全审计通过。执行者须严格使用下文准确 HEAD 比较，不使用 `--admin` 或无条件合并。

## 本轮阻塞项及修复证据

| 问题 | 复现 / 修复 | 验证 |
| --- | --- | --- |
| 新 USER_EDIT 服务仅检查 membership，VIEWER 可改当前稿；成员撤销与写入之间未锁定 | 权限回归先失败，证实 VIEWER 创建了子版本。现对 WorkspaceMember `FOR SHARE` 并仅允许 OWNER / EDITOR，再获取 Episode 锁；撤权提交后重新读取即拒绝 | VIEWER 拒绝、EDITOR 成功、真实 PostgreSQL 锁观察及并发撤权、原稿/指针不变；Podcast 完整文件 32 PASS |
| Provider endpoint 预检与 socket 建连分离，可能 DNS 重绑定；仅 A 记录预检也不足以覆盖 AAAA | 复用同一地址策略，通过 Undici dispatcher 的 socket lookup 检查全部实际 DNS 结果，并直接把核验地址交给 socket；拒绝内网 literal、混合 A/AAAA 和 IPv6 变体，保持 HTTPS/TLS 校验及不跟随重定向 | 预检公网后实际解析到 loopback 的本机对抗测试：NETWORK_POLICY_REJECTED、不可重试、TCP 连接数 0；不向模型发送数据 |
| #216 回滚脚本直接 DROP 执行凭据；#217 增加 FK 后不适用 | 旧脚本在隔离事务中复现依赖失败。新脚本默认拒绝，要求另行备份/授权；审核事件表存在时即使设置授权开关也拒绝，全部破坏性 DDL 在同一原子 DO 内 | 默认拒绝、后继表依赖拒绝、psql 继续执行错误时仍保留两项不可变触发器及表；无 CASCADE、无迁移账本改写 |
| 审核事件的三条 FK：SQL 是 ON UPDATE NO ACTION，schema 隐含 CASCADE | schema 显式 NoAction，匹配已部署 DDL；不修改四个历史迁移、不另造修复迁移 | 修正后的数据库→schema diff 与 main 原有 diff 完全一致，无堆叠新增漂移 |

网络边界沿用 Node socket lookup 和 [Undici connect 选项](https://github.com/nodejs/undici/blob/v7.30.1/docs/docs/api/Client.md)，仅增加固定依赖 `undici@7.30.1`。没有放宽证书校验或允许私网例外。Fake HTTP、真实本机 TCP 拒绝和真实供应商调用严格区分；本轮供应商调用为 0。

## Mimosa 历史告警逐项复核

已找到并核验历史 sealed JSON：`scan-2026-10-29T15-53-59.913Z-d2b7a9a241ca`，seal digest `b2965f0959f1bf6a1ed7de70bd27749756d3e7ee652da72db2da4b2de7256992`，三个被封存 artifact 的 SHA 均匹配。报告本身是 **inconclusive / verdictEffect=none**，9 项（7 HIGH、2 MEDIUM），不是无漏洞证明。本轮没有可用的新 Mimosa 扫描接口，未伪称已经重新获得全仓扫描通过。

| 历史类别 | 当前独立复核 |
| --- | --- |
| auth-form 硬编码凭据 HIGH | 原位置是 HTML `autoComplete="new-password"`，没有凭据字面值；按实际数据流判定误报，不删除旧记录 |
| 4 处 spawn / server / reconciler command-injection HIGH | 执行路径是 argv array、`shell:false`、应用生成绝对临时路径；部署 executable 是可信操作员配置，书籍内容不拼接 shell。保留超时、字节上限、创建时间/PID、host claim/lease、启动前 reconcile 和停止证据；不宣称 kernel 隔离 |
| managed server loopback SSRF HIGH | 每个导出网络入口限制字面 `http://127.0.0.1:<合法端口>`，重定向拒绝，生产执行器传入 owned PID/serverId 与 managed port；非本进程身份不能切换模式。原 advisory 保留，相关 hostile URL/redirect/identity 单测通过 |
| 2 处 short-video / speech SQL taint MEDIUM | 实际为 typed Gateway 调用和 Prisma tagged SQL 参数绑定，没有将书籍/环境字符串拼成 SQL；保留语义身份、consumer 指纹及幂等账本 |
| Provider HTTP transport SSRF HIGH | 旧预检不足，按本轮真实问题修复 socket lookup；不再把单次 DNS 校验当作实际连接约束 |

剩余信任边界：MinerU 本地二进制/模型目录和同账号文件系统仍须由可信操作员控制；代理环境拒绝不是网络命名空间。模型判断不等于 Gold，结构 UNKNOWN/REJECTED 不赋予素材权。原默认 Gateway 的成员/费用契约不在本轮整体改造范围，新校订入口和显式审核均已单独收紧。

## 增量迁移、数据保留与回滚

在专用新建 PostgreSQL 测试库，依次从每个准确 SHA 导出原始 schema/migrations，真实执行 `prisma migrate deploy`；每阶段重复部署均无待办：

| 阶段 | 已应用迁移 | 本阶段新增 |
| --- | --- | --- |
| main | 53 | 基线 |
| #215 | 53 | 0 |
| #216 | 55 | execution receipts、receipt immutability |
| #217 | 57 | model review event、reported model/index name |
| #218 | 57 | 0 |

main 阶段预先保存的历史 OcrPageAttempt 在升级后仍存在，新来源/actualTier/quality 字段均为 NULL；没有回填虚假的 model/quality 证据。历史迁移文件 checksum 未变化。旧应用字段查询仍可读，加法迁移不要求当场启用新能力。

三条 NoAction metadata 修复追加于 #218，保留 #215～#217 原始提交及祖先关系。因此中间 #217 的 schema diff 仍会显示这三条已知 FK metadata 差异；实际数据库约束始终是迁移中的 NoAction。此时只核验实际 DDL，不执行 diff 建议，也不启用新功能；到 #218 后该增量差异消失。无需为了 metadata 进行堆叠历史重写或重复创建 FK。

注意：main 已有索引、约束、默认值方面的 schema drift；比较的结论是“无本堆叠新增漂移”，不是“整个数据库与 schema 完全一致”。不运行 `migrate dev/reset` 或自动生成一份改变历史约束的大迁移。这项既有债务及差异文本保留私有，部署前不得把 diff 输出直接当作安全可执行 SQL。

常规回滚：停止升级 worker 的消费和调度 → 将两项 standard 开关及按需审核设为 false → 清除 standard manifest/相关参数（保留 manifest 而关闭 admission 会按设计 fail fast）→ 回到已核验的旧应用版本 → 保留四项加法迁移、事件、账本和失败记录。禁止通过直接撤销已应用 migration 或 DROP 审计数据实现常规回滚。

如果完全不配置 OCR_PROVIDER，则应移除全部 MINERU/standard 配置键，让裸默认返回“无 OCR executor”；不能保留孤立的 standard=false 键，因为现有严格配置解析仍会要求 OCR_PROVIDER。上面的 false 关闭方式适用于保留合法 MinerU/flash 配置的 worker。本机 Web 显式关闭审核入口与不启动 OCR worker 是分开的验证，不把 Web 能启动当作 worker 配置已通过。

`docs/operations/step6-2b2-rollback.sql` 现只保留受保护的 #216-only 特殊破坏性演练路径，不适用于当前 #217/#218 schema。任何真实撤销 DDL 都须先备份并另行授权；本轮仅对隔离测试库演练。

## 默认行为、本机配置与费用

- 两项 standard 开关默认不启用；半配置/畸形配置拒绝。已有 native-first、flash fallback、host/run/page claim、容量延后和迟到结果 fence 保留。单元验证 314 PASS / 2 Windows symlink SKIP；Linux 完整覆盖由准确 HEAD CI 验证。
- 无可信正式提取，Book / Podcast 不准入；standard 结构未证实仍 REVIEW_REQUIRED。审核结果 PASSED/REJECTED/REVIEW_REQUIRED 都不直接晋升正式提取。B03 standard/REJECTED 及 0 正式提取/0 ChunkSet 证据保留。
- 按需审核必须显式开关、真实会话、合法 Origin、OWNER/EDITOR、精确 receipt/source/page/credential、未过期且一次领取的 Job；失败不自动恢复，额外调用必须有新授权。网络返回和落库前重新核验成员/来源/Job claim。
- 新 TTS 模型/适配器的注册不创建路由、Job 或付费授权。合并或构建不调用供应商；不能把以前的验收费用授权当生产许可。历史播客账本仍独立保留，不启动新任务。
- 用户确认没有另行纳入远端生产环境。本机只发现 PostgreSQL / Redis / 私有 MinIO，没有运行中的 OCR/审核 Worker；GitHub 无 Environment、Deployment、变量记录。本轮不声称已检查未提供的远端生产配置。
- 本机旧验收文件显式 `PDF_VISUAL_REVIEW_ON_DEMAND_ENABLED=true`；此次应用启动使用 false 覆盖，并显式关闭两项 standard 开关，原私有配置文件不改。读取与已保存音频播放不依赖新付费任务。
- 本机实际 POST 审核入口返回 `403 OCR_REVIEW_DISABLED`；移除未配置 OCR_PROVIDER 时的孤立配置键后，默认解析器返回 null（无 executor）。传输层另用不带凭据、仅 `{}` 的 `https://example.com/` 请求得到 HTTP 405，证明真实公共 HTTPS 建连与 TLS 校验仍可工作；不是模型/TTS 请求。

## 旧 PR 重叠与排除

| PR | 准确 HEAD | 判断 / 操作 |
| --- | --- | --- |
| #209 | `8f4d44561a0bbed8d5271927293d172fa4faeca3` | 基于 `de9cdcdcea6f16757ce320b74da888c5a3383776`；来源页只读 UI 被 #217 部分复用，不整条重复合并 |
| #210 | `152492c758bc01597bed5183a5ede698afb6cf38` | 基于 #209；视觉候选与 OCR 独立判定不等价，未认定全部替代 |
| #211 | `978452c0c5f166cd06baa33b5eca418748b9a6f7` | 基于 #210；显式请求及一次领取与新 Job 授权有概念重叠，不能并行建立第二消费/收费权威 |
| #212 | `51493aeb1f4ac47eeec54f76d0dff431e24eceac` | 基于 #211；Range/原页渲染/Gateway 视觉部分复用，人工 confirm/reject/withdraw 事件尚未整体迁入 |
| #186 | `8c8edb259b0f9297d7e11a6ee5f8cde577920be4` | 基于旧 main `818da236e59ba0716e456da643fc9fb87610f7f3`；独立 RapidOCR adapter 不在本堆叠祖先中，native-first/worker 接线重叠，不能把整个旧分支覆盖到新 runtime |

#209～#212 相对共同 main 祖先包含五个独立迁移：Docling layout sidecar、layout task ledger、visual candidate、explicit request、human review events。与本轮四个迁移没有重名，但来源/候选/审核语义和 runtime 路径重叠；“不重名”不代表可安全叠加。#186 没有新增迁移，仍有 worker/env/routing 合并冲突风险。

本轮排除 #209～#212/#186，不关闭、不合并、不盲目 cherry-pick。将来只对确实缺失且仍需要的能力单独移植、单独验证迁移与唯一权威。不能把“部分复用”写成“全部已被覆盖”。

## 获得明确授权后的最小集成步骤

1. 重新读最新 main 与四个 PR 的 headRefOid、mergeable、mergeStateStatus、Draft 和六项 CI；任何 SHA 变化、冲突、检查未完成或失败即停。保持 standard/审核/付费 worker 关闭，先确认备份及迁移部署窗口。
2. 授权后将 #215 从 Draft 设 ready，使用 merge commit 和准确 HEAD guard 合并；不 squash、不 rebase merge、不删分支：`gh pr merge 215 --merge --match-head-commit 4f9d975af11ea144fd9eaa169c061b13863db193`。
3. 获取新的 main merge SHA；验证 parents 含原 main 与准确 PR head，tree/差异只含预期增量。记录该 SHA，等待该 main push 的完整 CI（lint/typecheck/build、真实基础设施迁移与回归）六项成功。`main` push CI 不会因后续 PR push 自动取消。
4. 再将 #216 的 base 改为 main；核验增量仅为 #216 的 8 个既有提交、2 个迁移，重新检查准确 HEAD/CI/mergeability，再用 `--merge --match-head-commit 43a55ecfca01b2a63261bc82a500d60cf3b9ff31` 合并。重复新的 main 构建、迁移部署/二次 no-op 与回归。
5. #217 同法 retarget main，预期 4 个既有提交、2 个迁移；准确 HEAD 为 `ea65676a5aac1ad4fe34156dc441b1b575d13b74`。阶段中不得开启 standard 或付费审核，不跳过主干检查。
6. #218 同法 retarget main；准确 HEAD 使用本轮修复后的实时值，不能写死原 `87ab3ac`。预期新增迁移 0。完成其合并后的主干完整 CI、迁移 no-op 和默认关闭验证，再提交新的 main SHA / 父提交 / 检查链接。
7. 若 main 发生外部前进，或 GitHub 显示的差异包含已合并提交/重复迁移，则停止、重审差异；不自动 squash/cherry-pick 或强推来掩盖依赖问题。

本轮未执行 ready、retarget、merge、分支删除、部署或生产 DDL；上述命令是待授权执行的计划。真实主干合并后的检查尚未发生，不能用本地演练冒充。

## 验证和证据索引

- Ingestion 单元 314 PASS / 2 SKIP；来源/结构证据 PostgreSQL 38 PASS；Worker 审核 PostgreSQL/MinIO 16 PASS；Worker 生产 Gateway 30 PASS。
- Podcast 持久化 32 PASS；Provider Phase8A（含真实 socket 安全测试）81 PASS；Speech/智谱/预算三文件 45 PASS；相关 lint/typecheck 通过。重叠定向 27 PASS 不重复相加。
- Prisma 生成初次被 Windows 正在运行的 Next 服务占用 DLL；仅停止本任务该服务后重试，不停止无关进程。迁移审计前两次自建 seed 夹具使用了错误 enum/relation，未更改项目 schema 来迎合夹具；修正夹具后在新隔离库完整重跑。
- Prisma Client 重新生成和 Web 生产构建均已成功；已有 ingestion `import.meta` 构建 warning 保留，没有用修改解析器来规避它。本机默认探针按解析器实际 null 契约及严格 orphan 配置规则修正后重跑通过。
- 最终准确 HEAD 的生产构建、完整 CI、GitHub 状态及本机安全启动结果，由最终中文交付报告补齐；任何运行中/旧 HEAD 成功都不计作最终成功。
- 私有证据：`D:/ai-cognitive-pdf-benchmark-data/private/final-integration-20261031/`，包含 `migration-sequence.private.json`、main/stack schema drift 原文、`rollback-rehearsal.private.json` 和历史 Mimosa 对照。原书/音频/密钥/原响应不进入本报告或 Git。
