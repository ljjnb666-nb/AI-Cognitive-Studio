# PDF-FIGURE-STRUCTURE 03E-04B-02F｜多区域人工草稿完成度与安全导航

日期：2026-10-21；父切片：03E-04B-02E（PR #101），本切片单独 Draft PR。

## 范围和状态机

已经有可验证标准图关系文件时，沿用 02E SHA-pinned 暂存和人工草稿服务；旧 P127 继续使用原有专用草稿。仅在本机私有来源通过契约检查、图像 crop SHA、manifest SHA、result SHA 校验后，服务计算一条区域的进度。

- `REGISTERED_PENDING_HUMAN_REVIEW` / `SOURCE_VERIFIED_REGISTRATION_NOT_APPROVED`：允许计入草稿进度（不是可信内容）。
- `WAITING_FOR_EXPLICIT_PAID_AUTHORIZATION` / `PRIOR_ATTEMPT_UNCERTAIN_NO_REPLAY` / `MODEL_RESULT_BLOCKED_MANUAL_INVESTIGATION`：绝不计入可审进度或自动导航。
- `UNREVIEWED` 未处理，`VISIBLE_MATCH`、`VISIBLE_MISMATCH`、`UNCERTAIN` 仅代表已写入的未认证草稿决策，不证明图关系语义正确。

## 不变量

1. 进度从已保存且经过 `parseGraphReviewDraft` / `parseRegionReviewDraft` 校验的草稿计算；网页不可提交自己声明的 review count。
2. 进度响应只含 canonical ID、审核种类、项数和总数；不含裁剪 PNG、私有文本、原始模型 JSON 或 API Key。
3. 任何合法组合下，`certifiedRegions=0`、`humanVerified=false`、`graphVerified=false`、`autoRegistered=false`、`autoVerified=false`。
4. `nextItemId` 只从经过来源核验并且仍有 `UNREVIEWED` 项的区域中选取；已开始草稿优先，随后是书籍/物理页/区域 ID 的确定性顺序；客户端校验聚合结果与顺序，发现矛盾则关闭导航。
5. UI 仅显示服务返回的已经写入的草稿计数，不能把尚未保存的前端修改算成已持久化。
6. 任何区域切换、清空、恢复文件前，只要自动保存仍处于 debounce、排队、HTTP 写入或失败状态，就默认拒绝操作，保留当前内存草稿。对请求进行 epoch、区域 ID、结果 SHA、模型结果种类绑定；接受真正成功的 CAS 回执后才清除脏状态。发生冲突时阻止导航，提示先导出 JSON。
7. 从本机文件手动恢复 JSON 的异步读取同时绑定 loadEpoch、result SHA、当前区域及审核类型、保存版本、人工编辑序号和恢复操作序号；读取期间如果产生了任何新的人工修改，或被更新的恢复请求取代，旧读取必须安全失败，绝不能覆盖新草稿。
8. 正式复核仍需人类逐项判断；没有批量批准、自动置为 `VISIBLE_MATCH`、付费发送、来源登记或最终认证入口。

## 验收矩阵

- Node/Vitest：空草稿 0/6，部分保存 1/6，单区域全部处理 3/6，双区域全部处理 6/6 仍认证 0；未授权/坏输出剔除目标，不允许继续导航；认证/登记路由不新增。
- Microsoft Edge 真浏览器 + 临时合成双书：人工修改期间延迟 File.arrayBuffer() 的旧草稿恢复必须被拒绝，不可覆盖较新的人工编辑；初始进度；P127 修改未保存时切换被拒；保存完成自动刷新进度；下一处可审核区域跳转到 RB-PDF-12；RB-PDF-12 写入时阻止切换，保存后可安全回到 P127；刷新恢复已保存的 2/6。
- 真实 D 盘：继承父 PR 的单独只读门禁，严禁修改现有 P127 草稿、读取非允许路径或对 14 张 PNG 触发任何 GLM 付费操作。不能拿合成通过当作真实付费生产验收。
- 完整主 CI：保留 `core-tests` 的历史 A2 首次失败 `#39597507144`；不跳过、不削弱原安全断言。

## 待验收证据

此文档只说明代码与计划，实际准确 HEAD、Edge 作业、计数和 CI 成败以本 PR 的 GitHub Actions 原始记录为准。即使所列门禁全部通过，本 PR 仍为 Draft / Open / Unmerged；未经用户批准不得合并。
