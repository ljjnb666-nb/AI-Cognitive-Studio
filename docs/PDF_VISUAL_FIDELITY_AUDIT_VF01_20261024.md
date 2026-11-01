# PDF 视觉内容保真审计（VF01）｜生产读路径风险识别

## 本次直接审计确认的事实

`packages/ingestion/src/pdf-routing.ts` 将**已获得可用 PDF 原生文字**的页面路由为 `NATIVE_TEXT`，即便同时检测到 raster image / vector / annotation。这个策略本身符合原生文字优先，并不证明正确保存了页面图片。

`packages/ingestion/src/pdf-run.ts` 的 `PdfOcrPageResult` 当前只有 OCR `text`，OCR checkpoint 将结果作为不可变 `.txt` 对象保存，`usableOcrBlocks` 将文本转为 `PARAGRAPH`，没有建立原 PDF 图像像素、图例或 image-to-text anchor 的权威关系。

因此，**正文被正确抽取不等于图表被保留、定位或理解**。如果直接把该文字送入拆书播客/短视频，下游有可能接收不完整的知识材料。这是当前架构的潜在视觉资料缺失风险，不是已经证实某个生产用户文档被损坏。

## 本 PR 的安全边界

- 新增纯函数 `assessPdfVisualFidelity`：同时读取**源 PDF.js 逐页 evidence**和**本次实际将发布的 canonical blocks**，产生固定键序、中文可解释的风险代码。读到源 raster image 而没有 `IMAGE` block，则标记 `RASTER_IMAGE_NOT_REPRESENTED_AS_CANONICAL_IMAGE_BLOCK`；混合文字/视觉、vector、annotation 另行标记。
- 真正的 `IMAGE` block 存在也**不能证明**图像像素已完整、原图一致、正确锚定或曲线语义已核准。所有这类 authority flags 始终保持 false。
- `runPdfExtraction` 的成功返回值加一个 **仅内存、只读的 `visualAudit` 字段**；**不会改动持久化路由计划、不修改 quality gate 的发布决策、不更换 OCR engine、不执行新 OCR、不改变数据库、Redis、MinIO schema，也不将未核准图表语义交给下游。**
- 新增使用真实 PDFKit 图文混排的 **PDF.js 子进程回归测试**，以及文字页、OCR 页、vector/annotation、含 IMAGE block 时仍未核准、重放顺序与错误契约测试。
- 结果不包含原书 OCR 内容、坐标或图像 SHA；单测只使用合成图片和英文短句，不提交 Benchmark 私有样本。

## 下一步正式能力的准入条件

1. 在当前五书同源页上验证 Native PDF.js、MinerU/Docling/RapidOCR 对正文/图像/阅读顺序的各自质量，包括 B03 p67 全页和 B15 p109 图例/曲线边界的独立来源审核。
2. 在正式图像保留通道中明确 PDF 物理页、不可变源图内容地址、像素裁片、图文锚点、图片保真与缺失时的显式降级状态；不能把 `<!-- image -->` 占位符或 OCR 文本当作图像已保留。
3. 后续独立 PR 才允许将这一审计风险映射为持久化质量元数据或安全发布门，须包括旧 run replay / generation / lease / 租户隔离 / 失败重试 / 有图无字 / 有字有图 E2E。
4. 在同一范围独立参考出现并通过验证之前，保持 `ARCHITECTURE_NOT_FROZEN`、`CER_UNVERIFIED`；完整图例/曲线到播客口径不自动认证。

## 正确理解现有证据

#174 的真实 Windows 检测仅对四个图例符号中的两个产生候选，另外两个弃判；不是 OCR 准确率。B03 八段视觉抽样也不是随机全页 CER，更不可由某个引擎在八段表现好推出全书主备结论。

本 PR 直接基于 `main`、独立于 #159–#174 未合并 Benchmark PR；所有 PR 保持 Draft/Open/Unmerged，未经用户授权不合并。

## 2026-11-01 最新主干适配

本 PR 已把主干 `61d08b64` 的最新 OCR execution facts、质量分类、混合页 shadow 逻辑原样保留，仅增加只读 `visualAudit` 返回值。没有覆盖已有主干架构；第一次已发布的文字结果仍按原门禁处理。旧 SHA 上通过的 CI 不能代替新集成 HEAD 的门禁，必须重新执行。此返回值尚未接入真正的独立模型审核与播客质量发布拦截。
