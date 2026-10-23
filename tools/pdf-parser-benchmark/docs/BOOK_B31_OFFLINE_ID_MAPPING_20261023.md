# 2026-10-23｜B31 真书已保存 GLM 回复的离线节点 ID 一对一归一化

## 问题来源

上游 #124 Windows 只读核验：真实 B31 第126物理页已保存 GLM 回复；`STRUCTURE_CONTRACT_INVALID_ROLE_TOKEN` 共 13 处，均为 `non_ascii`，其中对象节点标识符 5、边起点 4、边终点 4。**原始回复已经成功留存在私有 D 盘**，无需再花费 API 费用。

## 本次修复原则

- 不修改原始 GLM text、request marker 或 B15 历史隔离文件；继续禁止重发 B31 GLM 请求。
- 从 SHA 固定且 `finish_reason=stop` 的 B31 `reply.private.json` 加载原始 JSON，只在内存中作**确定性对象身份重命名**。
- 有效 ASCII snake_case 对象身份原样保留；含非 ASCII 字符的对象身份按出现顺序替换为 `anon_node_001` 等新 ID。每个原身份只能对应一个新身份，引用必须精准匹配原对象身份。
- 同步替换 `relations[].source_role/target_role`、`parent_role`、`axes[].chart_role`、`trends[].chart_role/series_role` 对象引用。**不交换起点终点，不改 directed，不改 relation/kind/axes/trend 意义，不增加或删除节点或边**。
- 原始对象 ID 重复、引用不存在、内部新 ID 冲突、不能解释的 ASCII 异常、其他非法结构均 fail-closed；不为了合格率而猜测或合并不同节点。
- 重写后仍须运行原 `parse_candidate()` 和 `facts()` 语义结构合同。只有在全量校验 PASS、节点和边数量不变且至少一条有向边的情况下，显式 `--write-candidate` 才在 D 盘独占创建 `visual_graph_proposal_B31.candidate.private.json`。
- 默认命令只读诊断。正式 Windows owner-only workflow 先跑**不写入预检**，成功后才执行一次离线候选生成，前后验证 B15/B31 request 和 B31 reply 的 SHA 不变。没有 GLM key，也没有模型网络请求。
- 生成的新候选仅可标记 **`PRIVATE_CANDIDATE_WRITTEN_PROVISIONAL`**，不能成为人工/独立金标准，也不能报告 Graph F1 或方向正确率。原始回复继续私有留存，用户后续独立审查仍需比对视觉像素。

## 验收与限制

Linux 使用合成中文对象与有向边做属性不变性、重复身份拒绝、引用失效拒绝、原始回复不可改、独占写入、非终止原因拒绝、日志不泄漏等测试。Windows 在固定拥有者同库 Draft PR 精确 HEAD 执行真实私有数据合同验收。

既有 PR #123 的首次 GLM 图结构字段格式失败、可能计费、Windows 下载警告以及 PR #124 的 13 个匿名错误分类全部保留。没有合并授权就不合并任何 PR；不修改生产解析器或 OCR 选型。
