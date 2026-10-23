# 2026-10-23｜B31 第126物理页首次真实 GLM 图结构输出：私有字段格式诊断

## 首次失败与安全边界

- PR #123 HEAD `31e1d533f0ecf40710896e68728117d536b39e49`，owner-only Windows 真实请求 workflow #39936890413，在 B31@126 单次 GLM 视觉调用后返回 `ACS_PRIVATE_GRAPH_REJECTED=STRUCTURE_CONTRACT_INVALID_ROLE_TOKEN`，该 workflow **FAILURE**。
- 从准确执行顺序可知：模型返回了文本，严格 JSON 解析通过，后续 `facts()` 对 `objects / relations / axes / trends` 的一个或多个角色 token 发生拒绝。此时无法推断实际语义节点、拓扑或 Graph F1。
- 在失败前，代码已尝试以 O_EXCL 私有留存 B31 请求 marker 和包含原始模型文本/finish_reason/SHA 的 `reply.private.json`。实际是否落盘必须在 Windows 私有目录只读核验，不能通过源码行为假设。
- **严禁重跑 PR #123 的付费工作流、删除 B31/B15 请求标记或发起任何新模型调用。** B31 这一次 HTTP 调用可能产生费用，账单实际扣费未知。

## 本切片：零付费只读诊断

新增脚本 `tools/pdf-parser-benchmark/scripts/ebook_private_graph_role_diagnosis.py`，只读取 D 盘既有 B31 回复、校验 Manifest 页码/SHA/原文摘要/finish_reason，并在只读内存中解析 JSON 后逐字段检查：

- 对象节点 `role/kind/parent_role`。
- 连线 `source_role/target_role/relation`。
- 轴 `chart_role/meaning`。
- 趋势 `chart_role/series_role/shape`。

输出仅含固定英文**字段类别**（如 `object_role`、`edge_relation`）、固定错误**类型**（如 `non_ascii`、`uppercase`、`surrounding_whitespace`）、**计数**。严禁输出实际 token、原始图中文字、模型原文、页图、私有 SHA/路径及模型密钥。

任何来源身份/摘要不符、非完整停止、JSON 格式不合法、数组规模过大、有已认证候选、模型原文缺失时直接拒绝，不尝试猜测恢复。GitHub Linux 只使用合成字符串进行测试；owner-only Windows 工作流不提供 GLM API 密钥，审计前后检查 B15 request、B31 request/reply SHA 一致且 B31 candidate 仍不存在。

## 后续判断

只有完成 **准确 HEAD 合成测试、真实 Windows 只读诊断、完整项目 CI** 后，才能依据匿名诊断类别研究下一安全切片：若是单纯的 token 表示问题，应先明确跨对象 ID 一致性、是否会改变图关系，再实施离线可逆的 token 映射，不允许无依据地把任意字词规范化为独立金标准。

此阶段不生成候选图、不计算真实语义或方向准确率、不发布解析器排名、不合并任何 Draft PR。必须保留之前的首次失败/Runner 弃用与网络告警。
