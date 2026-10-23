# 2026-10-23｜B15/B31 私有独立视觉参考：真实图像 → GLM L2 暂定 ROI

## 目的与证明强度

仅在 D 盘已经存在 SHA 匹配的 B15（物理页 109，旋转 270°）与 B31（物理页 126，旋转 0°）时，从 **PyMuPDF 渲染的完整页面像素**生成与 Docling、MinerU、PaddleOCR 的预测框无关的参考候选。**不能借用解析器本身的框来制作“真值”**。

该参考属于 `L2_AI_VISUAL_PROVISIONAL_NOT_HUMAN_GROUND_TRUTH`，并非人工独立金标准，更不等同于图表关系 F1。两次采样由**同一个** GLM 视觉模型完成；两次一致只能证明内部稳定性，不能消除共同的幻觉或系统性偏差。

## 安全、外传和运行限制

- 工作流 `.github/workflows/acs-ebook-private-visual-l2.yml` 仅允许仓库所有者在固定同库 PR 头分支触发 Windows 私有 Runner。固定准确 Git SHA；禁止任意 fork PR 获得密钥或接触私有书籍。
- **这是一个云端视觉调用流程**：只有明确使用 `--allow-cloud-vision` 并配置 GitHub Actions secret `ACS_GLM_VISION_API_KEY` 或 `GLM_API_KEY` 时，才会将真实 PDF 页面渲染图（仅 B15/B31 各一页、每页最多两次）发送至配置的智谱 GLM API。该外传是明确的模型处理行为，而不是“纯离线”；运行无密钥时 fail-closed，不使用伪造图像或模型输出。
- 请求端点硬编码为 `https://open.bigmodel.cn/api/paas/v4/chat/completions`，模型固定 `glm-4.6v`，禁止自动跟随重定向；单张 PNG 不超过 4.5 MB；单轮无自动重试，以免超时后重复产生费用。全部调用上限 **4 次**，记录的是同模型双轮一致性，不是跨模型一致性。
- 每页仅输出紧致外包框，0–1000 视觉显示坐标 → [0,1]，每轮 1–16 区域。强制严格 JSON、类别、坐标有效性、不重复、一对一匹配及 IoU≥0.55。两轮数量或位置不一致时**拒绝生成**可比较的 L2 文件，无法给出“真实零目标”的断言。
- 原书、页面 PNG、GLM API Key、独立 ROI、源码 SHA、报告和视觉审计材料不得上传公开 GitHub；输出只保存在 `D:\ai-cognitive-pdf-benchmark-data\semantic_gate\` 与本地 `reports\`。Actions 输出只含状态和匿名计数，不打印原图、图中文字、原始模型答复或坐标。
- 防止覆盖已有私有 ROI/审计文件：已有结果就要求显式调查，不自动重建。失败时若模型请求不确定是否已计费，不会静默无限重试。

## 两条独立审查链

**链 A：L2 视觉参考**  
PyMuPDF 真实页完整渲染 → GLM 视觉两次独立页面输入分析 → 交叉确认框数量、位置与类型 → 输出 B15/B31 私有 provisional `regions`。

**链 B：候选几何预测**  
Windows Docling 2.141.0 → 单页图片 provenance bbox → 已有 SHA/页号/框数守卫 → 原一对一 ROI overlap matcher。

两链在产生候选框之前相互隔离，空间匹配由后续步骤完成。B31 旋转为 0°，具备 provisional IoU/命中计数条件；B15 仍是旋转 270° 页，在现有独立 frame anchor sidecar 缺失时 **`ROTATED_DISPLAY_TRANSFORM_UNVERIFIED`**。不得通过比较哪个坐标变换能产生更高 IoU 来倒推“独立校准”。

`graph_semantics=UNVERIFIED`、`certified_graph_f1=null`、`human_verified=false`、`graph_verified=false` 不变。

## 验收标准

1. 纯合成 Python CI 的模型响应 JSON、双轮分歧、跨 SHA、资源限额与私有文件写入防线通过。
2. Windows 准确 HEAD 的真实 PDF SHA、页号、旋转角通过；官方 API Key 真实可用，两个页面全部完成四次或更少的模型调用，双轮一致且私有 sidecar 已写入，才算“暂定视觉参考已生成”。
3. 完成真实 Docling 重跑且 B31 产生空间 provisional 对比，才可以报告它的**暂定**命中计数，不能说是独立金标准 IoU 或图结构准确率。
4. 任何缺少 API Key、HTTP/代理异常、GLM 无法严格 JSON、双轮不一致、资源不足、B15 独立坐标 frame 缺失，均要**如实报告**。不能把预检、合成测试或一次模型输出包装为正式准确率。
5. 正式 OCR CER、箭头指向 F1、图表坐标轴/数值语义还需另行设计真正的参考协议并做跨引擎对比。此 PR 不冻结最佳解析器路线。
