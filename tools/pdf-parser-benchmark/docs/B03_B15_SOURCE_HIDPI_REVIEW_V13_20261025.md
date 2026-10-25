# Stage 1｜B03/B15 原始单页 PDF 高分辨率来源九宫格（v13）

## 任务由来

#181 的双 SHA 域和私有来源回执验收已通过，但五本书真正 independently_approved gold 仍为 0/5。B03 p67 摘要紧凑字形、右侧竖排标点和正文第三段，B15 p109 图 1-4-16 的实心/空心图例仍存在视觉不确定性。已有 #179 的 v12 页面放大滑块只放大 **1.4x 的原始缓存 PNG**，并不会从源 PDF 补充有效渲染采样。

本切片从已核对的 **Docling staged one-page PDF** 重新以 PyMuPDF 3.0x 矩阵渲染，按真实渲染像素切成九宫格，不是对旧 PNG 进行双线性放大。**若源 PDF 本身只有低分辨率扫描，3.0x 也无法恢复原始扫描中不存在的细节**。

## 来源与边界

复用现存 SHA-pinned source_contract，独立确认原书 SHA、截出的单页 PDF SHA、RapidOCR 焦点图 SHA 与原始页码身份；本切片再核验 staged 单页实际文件 SHA、单页数量与渲染像素。两种 SHA 域不可误判为同一个哈希。

仅处理 B03 PDF 物理页 67 与 B15 PDF 物理页 109，两页 x 9 = 18 张 tile PNG。严格限制单页文件大小、像素数、图片字节，禁止网络 OCR、LLM 或自动 text reference 生成。

私有输出位于：

D:\ai-cognitive-pdf-benchmark-data\semantic_gate\multibook_matrix_20261023\b03_b15_source_hidpi_v13

其中 18 张真实来源九宫格 PNG、一份 JSON 私有 SHA/裁切坐标回执、一个本地离线 HTML，总共 20 文件。脚本只支持首次建立新目录与严格重放复核；首次创建过程先在同私有磁盘临时目录 staging，再通过目录重命名提交，拒绝覆盖既有快照。

## 真实验收条件

- Linux exact-HEAD 6 项纯合成 PDF 渲染、私有重放、防篡改和拒绝无效来源回归；没有用户 PDF 内容。
- 仅用户拥有的 Windows self-hosted Runner 执行首次 --write 或重放 --audit-only，之后再执行一次 --audit-only，验证 2 页 / 18 tile、0 模型调用、原有 frozen PNG 和 native 回执 SHA 未变。
- 工作流只输出固定匿名状态码；不上传 images、PDF、OCR 文本、原始来源 SHA、坐标或私有 Artifact。
- 不应把 CI 成功误表述成 OCR 准确性已核准。

## 未解决项

本次不会比较三引擎 CER、也不会依据九宫格图片自动签发 independently_approved。B03 摘要/竖排/标点、B15 四组标记与曲线对应仍须后续基于图像像素与独立来源完成核验。图表结构必须另有测试维度，不能用文字 CER 取代。五书 gold 仍为 **0/5**，Issue #161 OPEN，ARCHITECTURE_NOT_FROZEN。

以 #181 为上游，Draft/Open/Unmerged，未经明确授权不合并，也不直接写入生产电子书解析路由。
