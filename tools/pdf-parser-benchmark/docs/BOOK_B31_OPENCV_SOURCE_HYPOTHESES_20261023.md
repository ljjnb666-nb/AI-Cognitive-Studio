# 2026-10-23｜B31 原始扫描页 OpenCV 独立几何候选（不等于图节点与箭头金标准）

## 上游准确事实

- PR #127 HEAD `eeb2dd77dd95edd4df0b9483ce41061290a2337a`：B31 扫描图源（PDF 第126物理页）在私有 D 盘已经 SHA 校验，上一切片原始像素证据统计 `158305` 前景像素、`619` 占用格、`2` 个栅格块连通区域，Windows 确认 `OpenCV=TRUE`、`Tesseract PATH=FALSE`。
- PR #125 的 5 节点、4 有向连接仅为源自 GLM 的临时预测，**本次检测绝不读取它**，也不根据其数量选择 OpenCV 阈值或“纠正”检测结果。B15 仍未知计费隔离，B31 旧模型请求不重复。

## 代码与边界

`ebook_b31_opencv_candidates.py` 仅从 B31 原始 PDF 导出的 `b31_source_only_page126.private.png` + 私有 provenance 元数据读取像素。复核书/物理页/源 PDF SHA、PNG SHA、像素尺度、禁止假冒人工认证。先读取 PNG IHDR 宽高（上限 400 万像素），再用 OpenCV 解码，保护有限的 Windows 内存。

图像级处理：自动判背景极性 → 灰度 + Gaussian → Otsu → Canny → HoughLinesP 检测长线段；`findContours` + 多边形近似提取矩形/四边形候选与三角形尖端候选，并计算线段端点与三角形中心点的近邻假设。每类坐标和坐标关系全部仅保存在 D: 私有 JSON，不输出给 GitHub。

**严格注意：**
- Hough 段可以来自文字笔画、边框、噪声；矩形可能来自排版文本框；三角形可能来自字体或标注，不一定是箭头尖。
- 邻近三角形并不能证明哪个节点是箭头起点/终点，不得推断 directed edge。
- 本次只是互不依赖的 raster `geometry candidates`，不是人审金标准，不得生成 graph F1、OCR CER 或视觉解析器优胜结论。

### 防线

- PNG 原生 IHDR 尺寸预检，最长总像素 `4000000`。
- OpenCV 原始轮廓数量超过 `30000` 则拒绝；Hough 候选仅保留前 `256`，四边形前 `256`，三角形前 `128`；截断标志单独记录，不能把截断计数看作真实总量。
- 默认只读预检，`--write` 才以 O_EXCL 独占创建 D: `semantic_gate/b31_opencv_source_candidates.private.json`。
- 仓库最新准确 HEAD 的 Ubuntu 用锁定版本的无 GPU OpenCV + numpy 对**完全合成图片**跑测试；Windows owner-only 固定分支无 GLM 密钥，不下载模型，不联网识别，不允许输出像素或图节点。
- Windows 对原图 PNG、原图 metadata、原像素报告，以及 B15/B31 request/reply/candidate 七个文件分别验算执行前后 SHA。任何来源错位/已存在输出/缺依赖/错误类型都拒绝，不覆盖原始资料或此前预测。

## 下一步

待拿到真实 B31 的 Hough/轮廓候选数量后，先在私有目录作原图与检测候选的**独立视觉复核**（不使用 GLM 候选），逐节点和箭头验证召回与误检。只有构造并验收完整的独立参考后才能与 GLM 的 5 节点、4 有向边比较、生成正式结构质量指标。

所有堆叠 PR 继续 Draft/Open/Unmerged；保留 #123 GLM 首次拒绝与可能计费、#126 首次测试失败、Node.js 20→24 Actions 弃用告警。