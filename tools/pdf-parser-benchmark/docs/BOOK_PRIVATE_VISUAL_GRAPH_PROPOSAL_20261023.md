# 2026-10-23｜B15/B31 私有真实书页视觉图结构候选

## 目标与范围

继 PR #116 真正用 Windows Runner 证明 B15@物理 109（270° 旋转）ROI 2/2 暂定空间匹配、PR #117 完成多曲线语义契约后，本切片**只补齐真实图片到结构化预测的实际调用**，不是黄金参考、不是胜出工具的正式选型。

- 输入：`D:\ai-cognitive-pdf-benchmark-data` 下 SHA-256 与 corpus Manifest 匹配的真实 B15@109、B31@126 PDF。
- 仅使用 PyMuPDF 原始页像素和固定 GLM 视觉端点 `glm-4.6v`；不使用之前的 GLM L2 ROI、Docling 框或 OCR 文本做生成输入，避免直接把参考答案抄入候选。
- B15：图表、分开的曲线 series、每条趋势、可以分辨的 x/y 轴含义。B31：独立节点和视觉可辨认方向的箭头。无法判断时模型可 `abstained=true`，绝不虚构结果。
- 输入/输出严格使用 `ebook_semantic_structure_gate.py` 的结构契约，AI 生成结构保持在私有 `semantic_gate/visual_graph_proposal_*.candidate.private.json`。

## 计费及幂等约束

- 工作流仅在仓库主人、同库、固定分支、**准确 PR HEAD** 的私有 Windows Runner 执行，运行前检查密钥存在、D 盘剩余不少于 16 GiB、可用 RAM 不少于 2 GiB、缓存环境和真实书的 SHA。
- **最多两次付费调用**：每页仅一次；固定 API 端点、无重定向、无自动重试，单次最大 3000 输出 tokens，图像不超过 4.5 MB，网络连接/读取各限时。上传到 GLM 云端的是整页渲染像素，这是**有外部云端图像传输、非全离线**的测试。
- 在每次调用前用独占创建 `visual_graph_proposal_<B15/B31>.request.private.json` 持久化请求标记。即使超时、异常终止或 JSON 失败，下次也不会自动发起新付费调用；必须先检查私有结果与服务商账单并人工审计恢复，再决定是否新建隔离执行版本。
- 两页私有候选分别写入 D 盘，严禁输出图片、书页/正文、模型回复原文、结构元素名称、原始 SHA、API Key 到 GitHub 日志，也不上传 Actions Artifacts。日志只汇报匿名页 ID、对象/曲线/箭头/趋势计数和弃权状态。

## 权威与后续

- 新候选与原 L2 ROI 是**同一 GLM 模型家族的两种不同提示词产物**，不具备跨模型独立性。当前没有与候选对应的、独立验证过的图结构 L2 参考，所以**禁止**宣称真实准确率、F1、趋势理解或箭头方向已验收。
- 结构模型输出即使通过严格 JSON 和图合法性校验，也仅能标为 `PROVISIONAL` 或 `ABSTAINED`；所有 `human_verified=false`、`graph_verified=false`，`certified_graph_f1=null` 原有规则不变。
- 若 GitHub CI 或 Windows 模型调用失败，保留首个失败原因，不得靠任意重试覆盖；不合并、不更改生产解析引擎、不发布排名。
- 下一步应为结构候选构造**真正独立的参考**，或由不同模型/多来源加独立校验建立暂定 L2 参考，再调用既有 `evaluate()` 进行 provisional 比较；真实金标准仍未完成。

## 验收要求

1. 纯合成测试：严格结构 JSON、多条曲线、不存在/反向箭头、引用越权、缺失私有书页、两次最多付费请求、运输结果未知时重试屏障均 PASS。
2. Windows 工作流真实完成 B15/B31 两页原图视觉调用、持久化私有候选、仅匿名计数日志。
3. 完整项目 CI 及 exact-head 专项 CI 不得混淆；未通过时保持 Draft 与 UNVERIFIED。
