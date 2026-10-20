# PDF-FIGURE-STRUCTURE-02：像素几何候选与图形关系审慎门禁

**范围：隔离 PDF Benchmark，不修改生产 PDF 引擎或播客生成流程。**

## 输入

此前已经经过 SHA 证明并保存在私人 D 盘的 MinerU 图像持久化结果：
- RB-PDF-12：原书物理页 P261
- RB-PDF-13：原书物理页 P51、P127、P379
- 4 张完整页面 PNG，映射到 6 条 doc: 图像引用

不要求再次运行 MinerU OCR；不上传图片、文字或模型，也不改变原始 OCR 输出。

## 实现

python/figure_geometry_candidates.py 使用 Windows 上现成的 OpenCV/cv2：

1. 严格验证每个 PNG 的 SHA-256、尺寸、源 PDF SHA、源 Markdown SHA、页码及 previous figure-evidence.json。
2. 基于 Canny + HoughLinesP，提取受限数量的像素线段，标注为水平、垂直或对角线候选。
3. 基于图像轮廓近似，提取可能的矩形视觉区域，包含原 PNG 像素坐标 bboxPixels。
4. 对近似三角轮廓，只在有方向一致的邻近线段支撑时产生几何箭头尖端候选；tip、shaftEndpoint、baseMidpoint 均有像素证据。
5. 在相同报告根目录新建 geometry-candidates-v1-{fixture}，输出 geometry-candidates.json 和 overlays/ 中的叠加 PNG，输出前不能覆盖旧报告。
6. 结果的 graphNodes、graphEdges、arrowDirectionRelations、timingRelations 全部为 null；仅 geometric arrow-tip 候选不是语义箭头关系、时间轴或流程图边。
7. stdout 只返回每本书各类候选数量、是否持久化，不发布坐标、图片、文字或任何源书路径。

## 防线

- 不从 Markdown 的 doc: 字符串读取路径或触发外部 URL；只读经过 manifest/SHA 和允许清单证明的私人 PNG。
- 不执行已有本地工作树中的修改代码，不清理本地改动。
- 不下载模型和依赖；Windows 预检已证明 cv2 存在。
- 人工页级 GT 仍缺失；即使候选很多，也不能称“流程图已理解”或评价结构准确率。
- 当几何图像过密、来源改变、目标已存在或文件碰撞时停止，不盲目清理旧结果。

## 验收

云端 CI 只运行无书籍的纯 Python 合成测试（箭头尖端向量与图像来源篡改），不运行 OCR 或图像模型。

在 Windows 真实图片上需要另外执行 SHA 固定的独立工作流，输出：
- 每页矩形、线段、疑似尖端候选计数；
- 每张叠加 PNG 成功解码、SHA 与 manifest 一致；
- 关系正确率、图表内容理解、时间顺序 = NOT_MEASURED。

后续 PDF-FIGURE-STRUCTURE-03 在有原图和结构 GT 时考虑视觉模型与人工审阅结合的关系解析；不能靠当前计数推断任何网络图、时序图、航空示意图的真实边。
