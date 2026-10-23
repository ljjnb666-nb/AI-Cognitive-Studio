# 2026-10-23｜GLM 图结构原始回复私有留存与离线恢复

## 已核验历史

上游 #119 的准确 HEAD `1fd37bb628c72db66c8b0ffd855db45cd2bf0e65`，真实 D 盘只读审核 B15@109 为 `QUARANTINED_PAID_OUTCOME_UNKNOWN`、B31@126 为 `NOT_STARTED`。B15 曾经取得一次 GLM 回复，但不满足 JSON 合同；**该次请求没有保存原始回复**，本切片不能恢复旧结果、不能推测扣费，不能触发自动重试。

## 新的防丢失流程（仅未来请求）

1. 使用已有 SHA 固定、物理页身份和原始图像渲染。
2. 请求前必须以独占创建 D 盘 `request.private.json` 标记，仍然只有最多 1 次请求/书页。
3. 当且仅当模型确实返回了文本，先调用 `capture_reply` 以 **O_EXCL 不覆盖** 保存 `reply.private.json`；包含原始文本、SHA、长度、匿名书 ID、物理页、模型名、权威标记。留存的是 provider JSON 响应中的 message.content 原样文本，而不是整个 HTTP body。
4. 然后使用严格 JSON 解析（仅接受完整 JSON 对象或恰好一个 JSON Markdown 代码围栏，拒绝解释文字、重复 JSON 键、NaN 等），再继续原有图结构与轴/箭头/曲线语义合同校验。
5. 结果不符合合同，不删除请求和回复记录，模型费用未知，需要单独分析。**不自动重试，绝不反复计费**。
6. 所有文件仅在 `D:\ai-cognitive-pdf-benchmark-data\semantic_gate`；GitHub 上仅提交通用代码和自造测试。禁止上传图像、原文、原始模型回答、API key、私有 SHA 或语义内容。

## 离线恢复

入口：`tools/pdf-parser-benchmark/scripts/ebook_private_graph_reply_recovery.py`。

`--private-root`、`--manifest`、`--book B15|B31`：默认**只读检查**现有私有请求/回复，验证 SHA、原始回复完整性、结构合同；不写候选，不调用 API、不读取/使用密钥。

可选 `--write-candidate`：**显式执行**时才写新 `candidate.private.json`，采用 O_EXCL，不覆盖旧文件；只证明原先已经取得的文本可被解析成一个临时预测，不代表真实图表准确率。运营/CI 不应自动开启此标志。

旧 B15：只有请求标记、无回复存档，返回 `NO_CAPTURED_REPLY_LEGACY_ATTEMPT`，`--write-candidate` 必须拒绝。B31：历史没有请求标记，不能假定有回复；只读检测应交由先前 #119 账本审计。

安全限制：源 SHA 与页码绑定、目录 symlink 拒绝、回复长度和完整性校验、重复 JSON 键拒绝、输出不包含私有路径/回复/图表节点/原始 SHA。即使模型回复被完整留存，也**不等于图表结构或箭头方向正确，更不等于独立金标准**。

## 验收和非目标

本 PR 只运行纯合成数据单元测试及一个 owner-only Windows 只读确认（读取旧 B15 已存在的账本，不会发起新的模型调用）。全量 CI 需在准确 HEAD 通过。该 PR 不改变生产解析路由、不合并上游 PR、不创建真实 AI 图结构参考或准确率排名，保持 `certified_graph_f1=null`、`human_verified=false`。
