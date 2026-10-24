# B15 图 1-4-16｜MinerU 图像保留与 RapidOCR 同页文字候选关联

## 本轮目标与基线

本切片承接 [Draft #164](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/pull/164) HEAD `5e7a547dd08b9ba70028e5bbc22edad9169949f9`（此前已完成 77/77 synthetic、Windows 真 Edge 5/5 和主 CI）。现在不再做三引擎重复相似度测试，而是回答：

> MinerU 保存的图表图片如何与 RapidOCR 抽取的图内文字建立**可回溯、不会凭空捏造语义**的候选关联？

资料只使用用户上传过且与旧私有收据一致的 B15 物理第 109 页 MinerU Markdown、`fivebook_mineru_basic_B15.private.json` 和 `multibook_rapidocr_five_pages.private.json`；图表原始像素、Markdown 全文、RapidOCR 原始行与完整 SHA **始终只保存在私有 D: 目录，不上传公开 GitHub**。

## 实际算法

- 对 MinerU Markdown 的 `data:image/jpeg;base64` 进行限流安全解码，核对 JPEG 文件头/尾，要求两张图依次与相邻图号 `1-4-15`、`1-4-16` 对应；记录图 1-4-16 **已被保留的第二张图**的私有 SHA。
- 绑定同一本 B15、物理页 109、原书 PDF SHA、RapidOCR 源渲染 PNG SHA、MinerU Markdown SHA 和 RapidOCR 行规范化 SHA。任一来源改变直接拒绝。
- 在真实 RapidOCR 原始行中，识别“正文引用图 1-4-16”和后面的独立图题“图 1-4-16”两个锚点；检验阅读顺序和四边形纵向边界，提取二者之间候选行。
- 真实 B15 输入目前得到 **19 条图内文字候选行**，每行保留私有 text、四点坐标和置信度；公开 GitHub 日志只能输出 **图像 2、候选 19、来源 unchanged、未审核**。
- O_EXCL 私有回执 `b15_mineru_figure_rapidocr_anchor.v1.private.json` 第一次冻结后只能 `--audit-only` 重读源文件、重算图像及行级哈希和完整回执内容，禁止静默覆盖或重复推理。
- Python 标准库即可执行；没有 OCR 重跑、云端、付费服务、pip 安装或模型下载。

## 明确的事实与推断边界

该回执只证明**同一来源页的图像与图题及相邻 RapidOCR 文字有候选联系**。RapidOCR 四边形属于原页面渲染坐标，MinerU 内嵌图像属于另一独立图像坐标系，**目前没有像素级变换矩阵或 IoU 配准证据**。因此：

- `image_to_page_geometry_verified = false`
- `label_to_marker_correspondence_verified = false`
- `series_to_curve_correspondence_verified = false`
- `visual_semantic_reference_verified = false`
- `independent_gold_available = false`
- `cer = null`

特别是「最大呼吸能力、肺活量、肾小球滤过率、肾血浆流量」与实心/空心三角、圆点及四条曲线的**精确对应关系**，需要后续从原图与图例符号局部进行视觉核对。OCR 输出可能混淆实心/空心三角，本阶段**不能自动修正为金标准**，更不能把 19 条候选看作 19 条准确标签。

## 验收门禁

1. Linux stdlib-only Python 3.12：6 项 synthetic，覆盖无 gold、SHA 篡改、重复图题、非紧邻图题、源图数量错误、非法四点坐标和冻结重验；无任何依赖安装。
2. Owner-only Windows：准确 HEAD checkout、只读源 SHA、真实 B15 冻结 v1 或现有私有回执 audit-only；必须确认图像 2、候选 19、图号 1-4-16、全部“未验证”标志、来源 unchanged，输出白名单匿名状态。
3. 准确 HEAD 完整主 CI 仍独立执行；保留 GitHub checkout warning、首次失败与 A2 既有问题记录。
4. 完成以上后，下一切片才开展“图像局部配准与图例符号裁决”，不能提前宣称视觉图表语义被理解；#161 继续 OPEN、ARCHITECTURE_NOT_FROZEN。所有 PR 保持 Draft/Open/Unmerged，未经用户授权不合并。

## Windows 私有回执位置

`D:\ai-cognitive-pdf-benchmark-data\semantic_gate\multibook_matrix_20261023\b15_mineru_figure_rapidocr_anchor.v1.private.json`

其中包含未审核的 OCR 候选原文、坐标与私有 SHA；**不得通过公共 CI、Issue、PR、Artifact、日志或在线调试工具传输该回执全文**。
