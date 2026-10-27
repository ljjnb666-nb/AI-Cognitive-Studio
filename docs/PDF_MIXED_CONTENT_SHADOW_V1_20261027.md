# PDF 混合内容页｜非权威影子质量观察 v1（2026-10-27）

## 问题和现有不变量

在 `pdf-routing-plan-v1` 中，一页只要 PDF.js 原生文字可用（真实 canonical blocks > 0），即使同一页包含图片、矢量绘制、批注，它仍路由至 `NATIVE_TEXT`。原生正文可以发布成功，但图像中的关系、标签、箭头或图例不一定得到保留。B31 的 TCP 图仅用于证明这种**类别风险**；没有据此证明生产图语义已经丢失，更不使用私有书页编写公共单测。

- 历史 PDF `routingPlan` 的 schema、generation、reasonCodes、产出字段以及重放比较均不得改变。
- 原生正文与 OCR 仍只有既有权威链路。Docling layout sidecar 依然是独立的非权威候选，生产启用开关维持关闭。
- 这一步不新增 OCR 或付费视觉调用、不写任何新数据库表或持久化文件、不改变 OCR attempt 与出版决策。

## 已实现的内容

新模块 `packages/ingestion/src/pdf-mixed-content-shadow.ts` 只读取已完成的每页 `PdfPageInspection`：
- 必须具有 canonical native text evidence、既有 `NATIVE_TEXT` 路由，并同时具有 `IMAGE`、`VECTOR` 或 `ANNOTATION` 证据，才成为**影子审查候选**。
- 固定 schema `pdf-mixed-content-shadow-v1`。内存报告保留页号和证据种类，图表语义 `UNVERIFIED`，OCR/graph accuracy 均为 null；**不能**将图片/路径数等同于图表数量、图质量或错误数量。
- `runPdfExtraction` 在原路由重放/保存校验之后只写匿名聚合日志：document pageCount、mixedPageCount、imagePageCount、vectorPageCount、annotationPageCount；不输出 PDF 字节、OCR 文本、全文哈希、文档 ID、页号或图像。
- 即使观察到混合页，也**不会自动修改路由、不触发 Docling 或额外 OCR、不阻挡发布**。因此它是影子风险信号，**不是已经实施的语义补救方案**。

## 真实和合成验收

`packages/ingestion/tests/pdf-mixed-content-shadow.test.ts`：
1. 同页文本+图片/矢量/批注：只标记候选，不修改路由/原因码/页号，也不破坏重复执行。
2. 原生块为 0、纯图片页、真空白页：不伪造混合页风险。
3. 图表关系和准确率永远 UNVERIFIED / null。
4. 使用 PDFKit 生成无版权合成 PDF，通过真正隔离的 PDF.js child，验证正文+图片同页在 v1 路由仍为 NATIVE_TEXT，而新的 shadow 识别这个候选。

单测加入 package 标准 `test:unit`，远端 CI 必须以本 PR **准确 HEAD** 重新核准；未核实的作业不宣称 PASS。

## 后续准入及残留风险

- PDF.js 中的 IMAGE/VECTOR/ANNOTATION 证据存在装饰性误报与漏报，不可作为“图识别失败”的真值。只能作为影子召回信号，需和未来独立图语义 Gold 结合。
- 这次仍未保全同页图像至最终内容，未扩展 Docling sidecar 的页面选择范围，未上线图谱语义处理。下一阶段须以本轮匿名候选为依据做**只读混合页源图保全**并用 B15/B31 独立图结构核准，而不是直接启用自动补救。
- 五书 Gold 0/5，正式 CER=null，生产路由与质量策略 NOT_FROZEN，Issue #161 继续 OPEN。
- 本变更基于 Draft #196，不涉及 Benchmark v17/v24 私有原书，未经明确许可不合并。
