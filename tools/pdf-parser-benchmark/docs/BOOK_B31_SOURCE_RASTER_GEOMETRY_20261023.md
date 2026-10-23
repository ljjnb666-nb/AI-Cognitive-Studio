# 2026-10-23｜B31 原始扫描页独立像素几何预分析（不生成图结构金标准）

## 准确上游事实

- Draft #126 HEAD `3b709b110065002d5a3f2558e07a67719ec1dd94`：专项与完整 CI **SUCCESS**；原始 B31 PDF 第 126 物理页 `0` 矢量 drawing paths、`1` 内嵌图片条目、`0` 原生文本块，私有页面 PNG + SHA 元信息已在 D 盘独占生成。
- Draft #125 HEAD `1b891ce7a2ddeac9a31a6e37a5330724b0b60143`：已保存的 GLM 回复经 5 个 Unicode 对象 ID 一对一匿名修复产生 `5` 节点、`4` 条有向边的**暂定**候选，结构合同通过，但箭头方向与漏检仍未独立核验。
- B15 未知计费继续隔离、B31 单次真实 GLM 请求不重试。本阶段 **不调用云端模型，不从候选反向生成源图特征**。

## 完全独立的来源路径

`ebook_b31_source_raster_geometry.py` 只读取 SHA 固定的 **原始 PDF 导出的** `b31_source_only_page126.private.png` 与私有 provenance 元信息。先验证：

1. 目录/文件必须位于原私有 D 盘、无 symlink；源图片在既有 4.5 MB 限额以内，元信息在 64 KB 以内；
2. 输入 PNG 摘要等于私有 source packet 元信息，元信息书 ID 为 B31、物理页126且源 PDF SHA 与既有 manifest 对齐，`human_verified=false`、`certified_graph_f1=null`；
3. PyMuPDF 只解码像素，不读取 GLM request、reply、candidate，也不访问任何网络模型。

针对 RGB 像素计算固定阈值的前景掩膜、前景像素 bbox、32×32 像素块占用、占用块的 8 邻域连通分量数量、长水平与竖直像素连续线段的行/列数。连通分量的 *tile_box* 仅保留私有 JSON 中。因为字形、标题、图框、箭头和边线可能连接或相互重叠，**这些计数不是节点数、箭头数或图 F1**。

同一次 Windows 实机运行还只读检查系统 `tesseract` 是否在 PATH、缓存 Python 是否已有 `cv2` 模块。只报告 `TRUE/FALSE`，不自动安装依赖，不输出 OCR 内容，不把缺失工具伪装为已具备识别能力。

### 私有交付

默认运行仅只读预览；显式 `--write` 才独占创建：

`D:\ai-cognitive-pdf-benchmark-data\semantic_gate\b31_source_raster_geometry.private.json`

输出包含原始源 SHA、PNG SHA、仅用于后续图像级算法调参的几何特征，以及 `node_count_verified=false`、`arrow_direction_verified=false`、`independent_graph_gold=null`、`certified_graph_f1=null`。私有源图片、图文字、bbox、SHA、模型回复和 candidate 不允许进入 GitHub、Actions artifacts 或公开日志。

Windows 运行前后会核验原始源 PNG、源 JSON、B15 请求标记、B31 请求/回复/候选共 6 件文件的 SHA 完全不变。任何 SHA 漂移、已有目标报告、非法目录或 RGB 解码错误均 fail-closed，不覆盖。

## 下一决策点

本次预分析之后选择独立视觉识别算法：
- 若 OpenCV 在既有环境可用，测试轮廓 + 形态学 + 线段/箭头几何检出；OCR 仅辅助识别节点文字。
- 若没有 OpenCV，优先使用现有 PyMuPDF + 纯 Python 特征和独立 OCR，评估误检/漏检；不得在未经验证的情况下把此无监督几何输出当 gold。
- 独立参考必须与 GLM 暂定候选**隔离构造**，核对实际原图的每一节点与有向边后再对照、计算准确率。独立源像素证据本身不足以认证图语义。

所有 PR 保持 Draft/Open/Unmerged。保留首次失败/重试/Node20→24 弃用警告与 #123 GLM 单次结构拒绝，不再发 B31 付费请求。