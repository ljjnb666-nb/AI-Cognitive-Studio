# 混合 PDF 页：可运行的源图像保全切片 v1

## 核心功能（不是 Benchmark 脚本）
`@ai-cognitive/ingestion` 新增显式调用的 `renderPdfMixedPageSourcePreviews(pdfBytes, limits, {enabled:true})`：
1. 真正的隔离 PDF.js 解析并复用 `pdf-routing-plan-v1`，定位**原生正文+图像/矢量/注释**混合页；
2. 仅从影子候选选择最多 2 页（允许设置 1–3），再次交给独立 Node 子进程按原始 PDF 页码光栅化，生成**真实 PNG 页面像素**；
3. 父进程校验原 PDF SHA256、图像 SHA256、PNG IHDR 尺寸、严格 IPC 格式、像素/字节上限；
4. 在 `finally` 删除原 PDF 临时文件与 PNG，不写数据库或对象存储；调用方可使用返回的 `pngBytes` 继续独立视觉语义识别。

图片不是“已理解的图表”，`figureSemantics=UNVERIFIED`，`canonicalTextChanged=false`。**现有正文的存储与发布不发生任何变化**，OCR/Docling 都不被调用。此 API 只在明确传入 `enabled:true` 时运行；当前生产工作流不自动调用。

## 故障闭合
- 输入小于 5 字节或超过 110 MB、最大页数 >3、最大像素 >800 万、超时 >60 秒直接拒绝。
- 子进程只允许有限 stdout，禁止使用 shell，渲染进程 V8 堆上限 384 MB，页面图最多 8 MB，超时或退出异常即拒绝。
- 隔离临时目录，读取源文件、导出图片后一定清理，不上传或记录书页像素、OCR 文本、用户身份或完整 SHA。
- 使用 PDF.js 的内容对象数量只是**页候选**，不是图表数量；装饰或水印可能误触发。

## 验收
测试合成的无版权二页 PDF（第一页同页文字+PNG，第二页普通正文）；通过实际隔离 PDF.js 子进程验证仍走原 `NATIVE_TEXT`，又能导出非权威来源 PNG。另测无图页面不生成、禁用/预算越界拒绝、真实画布像素预算拒绝。纳入 `@ai-cognitive/ingestion` 标准 `test:unit`。准确 HEAD CI 尚需核验，不可用早期 PR 的成功代替。

## 下一步（真正产品集成）
在图表语义工具和准确率独立 Gold 建立之前，本 API **不写入 canonical blocks、用户输出或生产数据库**。随后可由受控调用方将源图像交给本地/云端视觉模型并生成带 provenance 的节点/边草稿，再以可验证的独立质量门禁决定是否向用户展示，不得伪装成 Gold。

项目状态不变：五书独立 Gold=0/5，CER=null，生产 DOCLING_LAYOUT_ENABLED=false，PR 全部 Draft/未合并。
