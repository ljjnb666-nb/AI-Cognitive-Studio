# PDF 混合页源图接入｜主干移植切片（2026-10-31）

## 主干基线
从 main@7ac9a8917c3dfe49b12be0b4ff555df988050aa7 选择性移植历史 Draft #199/#200 的有效文件。#223 RapidOCR 和 #224 Docling 已合并；旧堆叠不整链合并。

## 交付内容
1. PDF.js 原生正文与图片/矢量/批注同时存在时，产生非权威混合页影子候选；只记录匿名聚合计数，不收集 PDF 正文、SHA 或页索引到日志。
2. 显式调用 `renderPdfMixedPageSourcePreviews(pdfBytes, limits, {enabled:true})`，真实 PDF.js 子进程渲染最多 3 张物理源页 PNG，验证原 PDF/PNG SHA、PNG 尺寸、像素/内存/时限预算并清理临时文件。
3. 主线自动 OCR 路由、持久化路由计划、canonical 正文、Docling/RapidOCR/MinerU 的运行条件、质量门禁及出版权限均保持不变。无视觉模型调用、无外部付费请求、无生产自动使用。
4. 来源 PNG 只是下一步视觉图关系理解的输入；图语义一律 `UNVERIFIED`，不是图结构 Gold。

## 验收标准
- 准确 HEAD 通过 `pnpm --filter @ai-cognitive/ingestion test:unit`、typecheck、构建和主 CI 六个作业。
- 合成含图片+正文的 PDF 真实隔离渲染成功，非混合页不渲染，页面像素超限与缺少显式 opt-in 均 fail closed。
- 绝不将旧 #199/#200 的 CI 作为本 PR 最新 HEAD 证据。Windows 离线实机回归待独立验证。
- 本 PR 保持 Draft，禁止生产启用、付费调用和直接合并。

## 下一步
在新主干基线上重用历史 #201–#212 的结构化图候选和授权 UI，必须由 Provider Gateway 处理图像调用，避免旧 #201 直连供应商适配器成为生产捷径。B03/B15 Gold/CER 及结构准确性仍须独立验收。
