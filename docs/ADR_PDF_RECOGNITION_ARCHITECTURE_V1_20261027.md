# ADR：AI Cognitive Studio 新 PDF 识别架构 v1

**决策状态：ACCEPTED_FOR_DEVELOPMENT（已确定开发基线；非生产上线审批）**  
**决策日期：2026-10-27**  
**适用项目：AI-Cognitive-Studio / 拆书播客**  
**来源：用户明确同意 v1 组合架构的持续开发。**

## 目标及不变量

必须解决“能取到正文，却遗漏同页图表结构”的产品问题，同时支持真实复杂书籍、失败回退、可追溯的书页来源和资源预算。**不得因为用户批准开发方案就擅自更改已经发布/持久化的 `pdf-routing-plan-v1`，也不得合并 Draft PR 或改变生产 Docling 启用状态。**

1. **原生可用文本 → PDF.js**：默认维护原生正文作为唯一权威文字来源，并绑定 PDF 与物理页。
2. **没有可用原生正文 → 现有 OCR executor（RapidOCR 或 MinerU）**：仅在已存在的耐久 OCR 状态机授权下解析；最优优先级随五书来源证据更新，不以“引擎多数一致”当真值。
3. **原生正文 + 图像/矢量/注释证据 → 影子混合页候选**：不变更原文本 route；仅在显式 opt-in 流程额外保存来源图像像素用于后续视觉理解。
4. **可见图表 → 视觉模型独立候选**：独立返回带来源 PNG SHA、物理页、节点、边与方向的图结构。全部标记 `UNVERIFIED_VISUAL_CANDIDATE`，不修改 canonical blocks、章节正文或正确率数据。
5. **逐层质量门禁**：OCR 字符、精确保留标点、表格结构、图例/箭头关系和来源有效性分别检查；候选与独立 Gold 不得互相升级。
6. **拆书与播客层**：直到证据被相应质量门禁认可之前，图结构不当作经过核实的知识引用。

## 项目代码现实

- 已存在：`extractNativePdf`、`pdf-routing-plan-v1`、`PdfOcrExecutor`、RapidOCR/MinerU 执行器、独立 Docling layout candidate、持久化 OCR authority。
- #199：`inspectPdfMixedContentShadow` 发现非文本候选但不改生产路由。
- #200：`renderPdfMixedPageSourcePreviews` 在隔离 PDF.js / Canvas 子进程真实生成带 SHA 的 PNG；全量主 CI + 专项 8/8 曾在其准确 HEAD 通过。
- 本切片：`inspectPdfMixedPageVisualStructure` 通过上游来源 PNG 调用独立 `VisualPageExecutor`，按约束解析图中节点和边；提供**显式** Zhipu/GLM 图像输入适配器，目的只在受控测试与未来选择。OpenAI-compatible 与 Gemini 原有 Provider Gateway 目前仍是文本/语音等路由；这项 opt-in 适配器**尚未纳入其用量/路由权限系统，不能用于生产工作流**。

## 不允许的捷径

- 不在未经确认的 Gold=0/5 情况下用三引擎投票“制造真值”；CER 不得伪报。
- 不自动将 OCR/视觉模型输出写入用户可见的已审核解读、不自动合并 PR。
- 不因图片存在就强制额外识别整本 PDF、不复制受版权保护原书到公共仓库或 CI Artifact。
- 不改变 `DOCLING_LAYOUT_ENABLED=false`；现有 Docling 只维持非权威候选。

## 可持续验收终点

**一个功能切片**而非无尽的小阶段：`PDF 输入 → 实际正文解析 → 检测混合页 → PNG 源图 → 视觉候选 → 严格结构检查 → 独立图结构审阅`。先用真实无版权合成 PDF 和受控模拟服务验证所有链路，随后用 B15/B31 私有本机数据做来源验证，再建正式审批与资源预算。生产启用和完整五书评分仍需独立验收。

此 ADR 决定“接下来构建什么”，**不是声称它已经成为生产事实**。
