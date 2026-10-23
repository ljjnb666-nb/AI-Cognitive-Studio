# 2026-10-23｜B31 单页真实 GLM 视觉图结构观测（最多一次付费请求）

## 上游准确状态

- 上游 Draft #122 HEAD `51c0179b6d1ff224d7f2733977c8b247a967143d`，完整 CI #39934292591 **SUCCESS**，Windows #39934292726 真实 SHA、B31 物理 126 页、请求账本无记录、B15 标记不变均 PASS。
- B15 第 109 物理页已有历史请求标记，JSON 错误导致原回复未落盘，仍属 `QUARANTINED_PAID_OUTCOME_UNKNOWN`；本切片**绝不请求 B15、不读取其原书、不删除或覆盖其标记**。
- B31 第 126 物理页为未开始状态，独立预检已经通过；这**不构成视觉模型识别成功**。

## 单次执行及保护措施

为 B31 新建独立、只在 PR 的准确 HEAD 且仓库拥有者同库分支下执行的 Windows 自托管工作流：

1. 首先在 GitHub Ubuntu Runner 对纯合成数据进行单页识别、模型回复落盘、finish_reason、非法 JSON、历史请求标记、离线恢复和防重试合同测试。
2. Windows Runner 对本地 D: 已缓存 Python、磁盘 ≥16GiB、剩余 RAM ≥2GiB、GLM 密钥存在、Manifest SHA、B31 物理页进行只读预检。失败即止，零付费调用。
3. 预检通过后只执行 `--book B31 --allow-cloud-vision`：原始 PDF 只渲染 B31 第126页，向用户先前授权的 GLM 云端传输这一页的像素（**非全离线**），最多一次 HTTP 请求、输出 3000 tokens 限额、拒绝重定向、禁止自动重试。
4. 任何 API 调用前先以 O_EXCL 独占建立 `semantic_gate/visual_graph_proposal_B31.request.private.json`。调用成功且返回文本，先以 O_EXCL 落盘 `...B31.reply.private.json`，再核验 `finish_reason=stop`、JSON/结构/方向是否满足严格合同，最终才以 O_EXCL 落盘 `...B31.candidate.private.json`。超时、模型截断、非 JSON、供应商报错或结构违反时 **永久隔离本次尝试，不得自动再次发送**。
5. B15 历史 request marker 的 SHA 在调用前后保持相等。模型回复、书页、图片、图节点名、源 SHA、密钥都不输出到 GitHub 日志，不上传 artifacts；仅显示匿名页 ID、候选对象/边计数、拒绝状态或 UNVERIFIED。

GitHub workflow **只会因本切片 PR 创建或匹配文件更新触发**，没有手工 `workflow_dispatch`。即使 GitHub Job 被人工重跑，已有 B31 request marker 也会在只读预检中阻止二次计费。

## 验收边界

- `one-shot-contract-without-cloud` PASS 只证明合成合同。
- Windows 若模型候选生成 PASS，仍仅能标记 `PROVISIONAL`，因缺乏与 B31 节点/边对应的独立参照，不能声明图结构 F1、方向正确率、OCR CER 或 Docling/MinerU 解析器选型。
- Windows 若失败，保留第一次错误、私有 request marker 和 reply（若存在），不得“再试一次”或手工删除标记。未来恢复只能针对已有已保存回复离线操作，且明确 `--write-candidate` 才能修改；真正再发模型请求必须另行授权、核销费用、建立隔离 version。
- 保持 #122、#121 等上游 PR 及本 PR Draft/Open/Unmerged，未经用户明确合并授权不得合并。
