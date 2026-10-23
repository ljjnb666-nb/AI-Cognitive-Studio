# B15 270° 真实页面私有坐标校准：像素证据与解析器预测隔离

## 核心约束

B15 是 PDF 物理第 109 页，PyMuPDF 报告旋转 270°。此前真实 GLM 两轮视觉观察已经在 D 盘生成 B15/B31 共 3 个 L2 AI 暂定 ROI；B15 的 Docling 图片框与 GLM ROI 不可直接比较，因为两者的页面坐标方向尚不确定。

本切片只生成用于空间比较的**页面坐标系证据**。不得通过尝试 0°/90°/270° 后挑选图片框 IoU 最大的一种坐标变换来定义“正确坐标系”，那会产生以预测结果反推真值的循环论证。

## 三条独立链

1. **原始 PDF 像素对应。** 使用已 SHA 固定的 B15 PDF 物理页，在内存中分别以原始 270° 和临时 0° 输出 PyMuPDF 栅格（不写回 PDF）。在原始帧中挑选分布广、可辨识的高纹理页面特征点，通过两份实测像素图上局部 3×3 邻域搜索检查对应像素内容，要求至少三处非共线、分散的对应点。仅使用页面像素，不读取 AI ROI 或 Docling 预测图片框。
2. **Docling 候选框帧。** 从 Docling 2.141.0 的单页 `document.pages[1].size` 独立取得页面宽高，比较其宽高比与 PyMuPDF 的未旋转/显示帧。若两种比例都符合或都不符合则拒绝，不能用图形框与 L2 的重合结果决定帧。此项仍是尺寸契约推断，不是产品级金标准；若未来发现 Docling 页面旋转/裁剪定义改变，必须重新检查。
3. **GLM 独立 L2 候选。** 只读取之前已经生成的私有 `semantic_gate/B15_B31_roi_candidates.private.json`。采用第一、二链生成的 sidecar 调用原有严格 `calibrated_match()`。输出的 IoU/命中数仍是 AI L2 暂定重叠，不验证图表数值、箭头方向、图形关系 F1。

## 防线

- 严格限制仓库拥有者同库 PR 固定分支的准确 HEAD Windows Runner；其他用户/fork 不能使用私有计算机和语料。保留内存 ≥4 GiB、D 盘剩余 ≥16 GiB 门禁。
- 不再重复请求云端视觉模型，不需 API Key，不新产生 GLM 图片调用费。仅使用已有 GLM 私有参考与离线 Docling。
- 校准原始像素、源 SHA、ROI 坐标、原书正文、docling provenance、sidecar 只在 `D:\ai-cognitive-pdf-benchmark-data\` 保存。Actions 仅输出匿名状态、帧类别、锚点计数、暂定重叠数量。
- 若图像相似度不够、纹理不够、像素非共线验证失败、Docling 页面方向模糊、SHA 错误、真实 PDF 页码/旋转错误，都要 fail-closed，不能创建可信校准。
- 已存在的私有校准文件不自动覆盖；只有与本次确定性计算结果完全一致才能复用。
- 输出 authority 始终是 `PRIVATE_AI_VISUAL_L2_FRAME_CALIBRATION_NOT_GROUND_TRUTH`；不得冒充人工金标准或真实 OCR CER/图表箭头 F1。

## GitHub 与真实验收

专属工作流 `.github/workflows/acs-ebook-b15-frame-private.yml` 首先运行 synthetic 数学/像素/异常回归，然后在真实 Windows 离线 Runner：

1. Docling 真实解析 B15/B16/B31，私下记录 Docling B15 页面尺寸。
2. PyMuPDF B15 同页两个方向真实像素匹配，形成至少 3 个私有 anchor pairs，和 Docling 页面宽高对齐后生成 sidecar。
3. 再执行一次真实 Docling，读取私有 L2 参考与校准，打印 B15 的 provisional 匹配状态和计数。

合成门禁 PASS 不能代替上述实书证据。即使 B15 成功匹配，也只表明 **B15 的候选框与同模型两轮 L2 视觉参考之间存在某种位置重叠**，仍不代表 MinerU/Docling/PaddleOCR 的正式架构选型已经完成。
