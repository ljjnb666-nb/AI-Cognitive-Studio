# Stage 1｜B03/B15 来源原图与三份私有视觉候选并排核验 v16

## 不重复前序工作的准入事实

- #184 准确 HEAD f19606f87d1ab39772fc20a13372757c19047dc2 的专项 #40177300524：六项合成 PASS、Windows 单次新 B15 R3C2 视觉调用 PASS；历史 B03 R2C2 未知请求没有重试。它确证的是 **3 份私有候选成功落盘、1 份历史请求结果未知**，不是独立金标准。
- v13 已生成并冻结 B03 PDF 物理页 67 与 B15 物理页 109 的 3x 来源九宫格 18 张，已完成 SHA-pinned 原 PDF 和 extracted-page source audit。
- v14/v15 的三份 GLM 原图候选是有不确定性的视觉草稿，不能推导 B15 图例与曲线关联，不代表 OCR 真值。

## v16 的新增可交付成果

本轮**不再调用 GLM 或任何 OCR**，而是从真实原图九宫格和三份历史候选，在本机私有 D: 自动生成一个供来源核验的静态离线页面：

D:\ai-cognitive-pdf-benchmark-data\semantic_gate\multibook_matrix_20261023\b03_b15_candidate_source_review_v16\B03_B15_三份候选原图核验.private.html

页面按四个目标区域逐一并排展示：左侧为真实 v13 来源 PNG，右侧为 v14/v15 保存的完整模型文字候选、模型标记的未决字词和视觉备注；B03 R2C2 只显示历史「请求结果未知，禁止自动重试」，不得用缺少候选替代为准确识别。

同时仅在私有 D: 写入源图/防重记录/候选文件 SHA 的 v16 JSON 回执。GitHub 仓库不存放任何私有文字、图片、坐标或哈希。

## 严格的工程防线

1. 每次从 D: 重新校验 v13 的 18 张 tile SHA 和完整 v14 inventory，要求精确 3 已完成、1 结果未知、0 尚未开始。
2. 三份候选必须处于 MODEL_CANDIDATE_NOT_GOLD，全部经过 v14 严格 JSON Schema 校验，显式无 CER、无 gold、无图例—曲线权威；未知请求保留 charge fence，确认没有 candidate 文件。
3. 对模型生成的 HTML 文字逐项转义；静态 HTML 有关闭脚本/网络/表单上传的严格 CSP。仅本机打开，无自动保存、无批准按钮。
4. 用同一 D: staging 目录原子创建 v16 新快照，禁止覆盖；二次执行必须内容字节完全一致，不允许添加多余文件。
5. Windows self-hosted owner-only workflow 先对现有 v13 真 PDF 来源按旧脚本 --audit-only 重放，再生成 v16 HTML，最后 v16 --audit-only 验证；前后逐一检查 18 张源图、v13 来源回执、三份候选以及历史未知防重凭据的 SHA 没有变化。
6. Linux 7 项合成测试验证内容隔离、XSS 防线、重复审计不可变、篡改拒绝、伪 gold 拒绝、未知 B03 不填补、候选缺失不可自动修复。所有公开日志仅输出固定匿名状态和计数，不打印单格模型文字或完整私有 SHA。

## 权威边界与下阶段

生成侧-by-side HTML 只是**方便进一步核验的私有材料**，不会自动完成独立逐字核对，不会签发正式金标准，也不计入已完整覆盖的页数。B03 摘要/右侧竖排字符和标点需实际来源逐字复核，B15 图例还需验证标记和曲线的对应关系；其他 B03/B15 未选区域、B08/B29/B31 全页依旧未通过。

独立 gold 0/5，真实 CER=null，Issue #161 继续 OPEN，生产识别架构 ARCHITECTURE_NOT_FROZEN。所有相关 PR 保持 Draft/Open/Unmerged；未经明确授权不合并。保留 #183 首次 GLM 真实失败、v15 的单次收费和 actions/checkout Node20 弃用 warning。
