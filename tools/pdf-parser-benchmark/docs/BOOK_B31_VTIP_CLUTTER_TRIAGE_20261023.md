# 2026-10-23｜B31 扫描页 103 处 V 型端点的全量误报风险分层与私有审图拼图

## 起点（仅事实，不是金标准）

- Draft #130 @ `dcaa438e521b97df95fa3fcead40989d745a8227`：原始 B31 物理第126页的 source-only CV 多尺度 V 型端点 **103 处**；私有源 PNG、源 CV 坐标、此前 143 合并线段、模型原始回复/暂定候选全部独立保存。源码和真实 Windows 专项已 PASS，完整 CI 独立核验。
- 103 处不是 103 条箭头。任何根据 GLM 5 节点/4 条边反向挑选 4 条结果的策略都构成**同源自证**。本切片绝不读取 GLM request/reply/candidate，不调用任何付费 API。

## 本次新增两种仅在 D 盘的产物

1. `b31_vtip_clutter_triage.private.json`：全部 source-only 几何端点的原始候选索引、原始线段引用、局部墨迹占比、狭小轮廓数量、基于固定规则的「背景干扰复核桶」，并保留 SHA/页码/隐私来源。
2. `b31_vtip_contact_sheet.private.png`：对全部候选截取 **63×63 像素的局部原始页图像**（边界页裁剪按实际尺寸），按低干扰、待判断、高干扰顺序排列，并叠加编号和红色端点标记；只有审图目的，不包含 GLM 模型内容。

默认只读预览；显式 `--write` 才用独占 O_EXCL 创建两个文件；已有结果必须只读 `--audit-only`，验证来源 SHA、私有 contact sheet SHA，禁止二次覆盖；若存在部分写入，立即停止并保留现场。

## 固定、不依赖预测的误报风险分层规则

- 每个原始候选须严格对应 source-only 合并线段的一端，合法索引、位置、双翼支持计数和长度/斜率尺度均验算。不得插入猜测点或虚构箭头。
- 从**原始 PDF 页图**的候选端点周围取固定半径 31px 的 ROI，计算墨迹像素比例、外轮廓中小面积分量数。
- `LOW_CLUTTER_REVIEW`：墨迹 ≤15% 且小轮廓 ≤5；先安排人工/独立复核。
- `DENSE_INK_REVIEW`：墨迹 ≥28% 或小轮廓 ≥14；容易出现字形/图框/复杂背景混入，需更谨慎复核。
- 其余均为 `AMBIGUOUS_REVIEW`。**以上只是背景干扰排序，不是误报概率、置信度或真实方向的判定。** 任意桶均可能包含真实箭头，不能删除。
- 即使检测到 103 个位置，`arrow_direction_verified=false`、`classification_semantic_accuracy_verified=false`、`independent_graph_gold=null`、`certified_graph_f1=null`；不计算 Graph F1。

## 防泄漏与实际验收

- Windows owner-only 同仓库准确 PR 分支使用已存在的 `D:\ai-cognitive-pdf-benchmark-data\tool-env\docling-2.141.0\Scripts\python.exe` 和现成 OpenCV/NumPy，无密钥、无付费 provider 调用、不安装模型。
- 工作流先纯合成 10 项测试（高密度伪文本/低干扰箭翼/重复候选/坐标被篡改/假 gold/假 SHA/不完整写入/独占保存/只读重复验收），再 Windows 真页只读预览、私有创建或现存只读验证。
- 前后验算 B15 request、B31 request/reply/candidate 及所有既有 B31 来源图片、CV、V 型审图文件的 SHA 恒定；新 JSON/PDF 内容、候选坐标、电子书文字、原图、私有源 SHA、模型密钥**绝不能出现在 GitHub Actions 日志或 artifacts 中**。公开只显示每一复核桶匿名数量和未认证状态。
- 使用现有主 `ci.yml` 的 owner-only 精确分支验收；**替换** PR #130 临时 V 型 job 而不是重复执行模型或旧私有写入。所有工作保持 Draft/Open/Unmerged，未经授权不合并。

## 后续出口

审图拼图仍只存在用户私有 D 盘。独立视觉审查者应先看完整原图和所有 ROI（不看模型答案），逐一记录真实箭头是否存在及方向；之后才对 GLM 预测做盲法对照。没有复核的候选只能叫 **`UNVERIFIED_GEOMETRY`**。
