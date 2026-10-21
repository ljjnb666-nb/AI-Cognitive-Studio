# PDF-FIGURE-STRUCTURE-03E-03B｜可信图结果登记与跨书页集中审核接入

**日期：2026-10-21。状态：Draft PR #100，尚未合并；生产审核认证仍未完成。**

## 一、已经实现的完整控制路径

打开原本的 `graph-review.html` 审核工作台后：

1. 通过带一次性本机访问凭据的 `GET /api/private-graph/queue` 发现既有 PNG 区域；通过 `GET /api/private-graph/registry` 获取代码登记的**允许审核**条目。
2. 只有区域两份登记相符、并通过服务器来源 SHA / 模型结果 / 节点关系映射 / 审核状态检查后才出现“进入审核”。
3. 当前 P127 仍走原有 `/api/private-graph/p127/bundle`、`/api/private-graph/p127/draft`、旧 `acs-p127-graph-review-draft-v1`，以及固定 `private-reviews/P127-graph-review-r02-DRAFT-UNATTESTED.json`；**不能迁移为新的通用草稿**。
4. 对未来单独经人工授权生成、在代码中登记且 SHA 全匹配的其他区域：通过 `GET /api/private-graph/registered/bundle?item=<书籍:区域>` 读取固定图候选、来源及已存草稿；在统一审核 UI 中逐条调整；`PUT /api/private-graph/registered/draft?item=<书籍:区域>` 以当前 SHA revision CAS 及独占锁保存到 `private-region-reviews-v1`。
5. 所有人工输入仍是 `REVIEW_DRAFT_UNATTESTED`、`humanVerified=false`、`graphVerified=false`；编辑或标记全部为 VISIBLE_MATCH 不会获得任何最终认证权限。

## 二、登记簿安全属性

`annotation/graph-result-registry.mjs` 的生产只读登记表 **TRUSTED_GRAPH_RESULTS** 目前只有一个条目：

`RB-PDF-13:page-002-region-01` → **LEGACY_P127**。固定 P127 的 result/crop/manifest 来源路径以及 EXPLICIT_P127_SECOND_ATTEMPT 类别，按原有严格校验契约读取，没有第二份草稿。

任何新增 **REGISTERED_REGION** 必须进行单独审查的代码改动，并明确登记：

- 书籍 fixture ID、物理页码和规范 `page-NNN-region-NN`；
- 唯一、非路径穿越的模型结果相对路径及固定 Manifest / crop 路径；
- 真实 result/manifest/crop 三份原始字节的完整 SHA-256；
- 来源 run、provider、模型和显式尝试类别。

未登记、错 SHA、错页、错节点框、越界箭头、冒充认证、缺失/不完整的文件一律不能审核；只凭 PNG 存在不会创建审核项。请求参数只能是规范 item ID，不能提交目录路径、glob、模型参数或任意 JSON 作为新结果来源。未启用 `--auto-import-p127` 的默认静态标注模式不暴露任何私有 API。

浏览器还会重新计算三份原始字节 SHA、校验几何及已登记来源；切换审核对象时作废前一个对象的自动保存任务。私有路由使用本机回环 Host/Origin/Fetch-Site、一次性 token、限制请求大小和禁止无审查 PUT。在只读验证模式中，新旧草稿 PUT 均被拒绝。不会上传原书图像、节点文字或模型回答到 GitHub。

## 三、已经发生的验收和首次失败

- [准确代码合成专项 #39567034284](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39567034284)：SUCCESS；50 项 Python 与 82 项 JavaScript，共 132/132 测试通过。保留 checkout@v4 / setup-node@v4 的 Node24 强制兼容弃用警告，不声明“没有警告”。
- [首次真实 Edge 合成 #39566877439](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39566877439)：FAILED；`private-graph-local.mjs` 的通用错误类导出名误写为 RegionReviewError，实际导出名为 GraphReviewError。后续提交 `a7ff9a236641998d0da5d464f7d3e444527b0d66` 修成显式别名。该首次失败保留。
- [修复后合成 Edge #39567074418](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39567074418)：SUCCESS，精确公共源码 SHA 在 Windows Edge 中验收 **P127 原草稿修改/自动保存/刷新恢复**，以及 **模拟 RB-PDF-12/P51** 的可信登记图候选、独立自动保存/刷新恢复，确认新区域不覆盖 P127 原草稿。
- [真实私人 P127 只读 Edge #39567121790](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39567121790)：SUCCESS，在关闭真实草稿写入的服务上读取固定真实 P127 机器证据、原页 PNG 与队列，不向 Actions 输出图片/文本，既有 9 节点/10 关系仍未审核。
- **合成 RB-PDF-12/P51 仅用于模拟注册与交互测试**，绝不代表另外 14 张真实裁剪图已经经过云端图关系识别。
- 最新文档提交后的准确 HEAD 全 CI 和专项 CI 要单独核查最终 conclusion，不得把先前 HEAD 的成功冒认为文档 HEAD 的成功。

## 四、保留门禁与后续工作

- 真实私有证据仍是 15 张裁剪，**只有 P127 一项真实图关系候选**，其余 14 张只有 PNG；本轮**没有调用 GLM**，也没有新增计费授权。
- 后续真正创建新图候选需要明确用户指定的书、页、crop IDs、模型费用上限以及单次授权，先输出机器建议后再审查代码登记 SHA，禁止隐式批量付费或自愈式重试。
- 目前真实 P127 内容尚未有人逐条确认节点与边，不能作为已验证知识内容直接用于播客。尚需人类审核、双人独立复核、正式 GT / 出版门禁。
- 用户 Windows 固定 Worktree 是否已安全同步并非 GitHub Actions 可证明；Runner 采用临时目录执行并清理，**不能以合成/私有浏览器验收冒充本地产品部署**。
- PR #100 继续 Draft / Open / Unmerged；未经批准不得合并。
