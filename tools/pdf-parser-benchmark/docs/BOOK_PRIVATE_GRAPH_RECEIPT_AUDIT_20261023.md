# 2026-10-23｜B15/B31 视觉图结构识别：私有请求账本只读核验

## 背景与首次失败

准确 HEAD `6c1dfbfcba9fb7fab10c8f73a08eba9397d73567` 的完整 CI #39916914376 SUCCESS，但真实 Windows 专项 #39916914405 FAILURE。Windows 预检通过，执行时遇到 `STRUCTURE_MODEL_JSON_INVALID`，在 B15 首次 GLM 模型调用返回后、结构化候选写入前终止。B31 未进入调用。由于模型返回内容的原始字节未持久化，不能凭日志修复或重建 B15 结果，也不能断言供应商没有扣费。

先前的首次失败（旧 SHA `94a0ccb4ff9d239a8f629a41ec0e3eef308f9dc5`）是密钥别名预检失败，未发起付费请求；两次失败必须分别保存。

## 本切片的唯一目的

提供独立、只读、零云端 API、零计费、无私有内容外传的状态审计，不再执行视觉模型调用：

- `tools/pdf-parser-benchmark/scripts/ebook_private_graph_receipt_audit.py`
- 每页只读取 `semantic_gate/visual_graph_proposal_<book>.request.private.json` 和 `visual_graph_proposal_<book>.candidate.private.json`；目标 `B15@109` 与 `B31@126`，核对 Manifest SHA、准确物理页、模型及候选图结构契约。
- 允许 `NOT_STARTED`、`QUARANTINED_PAID_OUTCOME_UNKNOWN`、`PRIVATE_CANDIDATE_PRESENT_UNCERTIFIED`、`PRIVATE_ABSTENTION_UNCERTIFIED` 等匿名状态。没有候选不等于零准确率；存在请求标记不等于供应商一定收费或已经成功返回。
- 错误来源、SHA 不符、非法 JSON、重复键、伪造 humanVerified、私有目录链接等一律 fail-closed。
- 审核不会写、移动、删除或覆盖任何文件，不做任何外部 HTTP 请求，不触发旧付费工作流，不打印书页、回答文本、节点名、SHA、私有文件位置和 API key。
- 工作流只在仓库主人创建的同库固定堆叠 PR 上、精确 SHA 的已有 Windows 自托管 Runner 执行，没有传入模型密钥和上传 artifacts。Linux 工作流使用纯合成数据测试。

## 决策边界

真实 Windows 若返回 B15 `QUARANTINED_PAID_OUTCOME_UNKNOWN`，应保持原始 marker、不重新请求。由于最初的 `STRUCTURE_MODEL_JSON_INVALID` 可能由 Markdown 代码围栏、非严格 JSON、输出截断或格式错误造成，单凭当前匿名日志**不能确定**具体回复内容，也不能选一种猜测自行修正。

如需进一步识别该模型响应的原因，应在新的隔离切片为**未来请求**增加私有的、有限大小的原始响应安全留存和明确的计费/状态记录，之后才考虑重新申请用户授权发起新付费调用。旧 B15 无原始响应缓存，不能编造恢复结果。

此切片验证的是账本一致性，**不验证真实图表语义、不评估准确率、不决定 MinerU/Docling/PaddleOCR 的路由或名次**。保持所有上游 PR Draft/Open/Unmerged，生产 humanVerified/graphVerified 与解析路由不变。
