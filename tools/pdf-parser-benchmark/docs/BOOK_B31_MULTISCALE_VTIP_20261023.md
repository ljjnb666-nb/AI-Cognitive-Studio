# 2026-10-23｜B31 多尺度开放 V 形箭翼假设与私有可视化复核包

## 真实基线

- 上游 Draft #129 HEAD `62e201dc5af96e87dcc8584c00afce08356b4b8e`，专项合成 18/18 与 Windows owner-only PASS。真书 B31 第 126 物理页 `210` 原 Hough 线段，合并后 `143` 个线段假设、`0` 合格三角尖端、`0` 几何配对；这意味着先前基于封闭三角形的方案不能验收箭头。
- B31 GLM 私有候选为 5 节点／4 有向边，**不用于本次无监督参数设计、算法输入和结果判断**。B15 未知收费历史继续隔离，B31 付费 API 不重试。

## 本阶段

纯离线新脚本 `ebook_b31_multiscale_vtip_review.py` 只读取通过 Manifest SHA、物理页、PNG SHA 和未认证字段校验的原始页面 PNG，以及不依赖 GLM 的 source-only OpenCV 线段报告：

- 不依赖闭合三角形，而是逐一检查合并 Hough 线段两个端点处是否有沿着线段朝向的两翼像素支持。
- 固定三个长度尺度（0.75、1.0、1.5）和两个翼展开斜率（0.45、0.70），每侧至少三个不同距离采样点获得墨迹支持才作为**几何端点假设**。
- 保留 source-only 候选的总量和最多 128 个脱敏上报的内部几何坐标，生成独立私有 PNG 叠加审图图（原页、至多 120 条候选轴线、最多 64 处端点圆圈），仅用于后续独立视觉判断。
- 对 PNG IHDR 限定最多 400 万像素，overlay 文件上限 8 MB；SHA 不符、假冒金标准、超预算、源报告截断等保持受约束状态，不凭候选构造人工认证。
- 默认只读预检；`--write` 才独占创建 D: `semantic_gate\b31_multiscale_vtip_source.private.json` 和 `b31_multiscale_vtip_review.private.png` 两件文件。若中途失败，保留部分凭证并停止，不清空标记或偷偷覆盖。
- 工作流不注入任何 GLM 密钥；仅输出总体匿名数量。**完整源图、叠加图、私有源 SHA、几何坐标、候选中文文本、GLM 回复不会上传 GitHub Actions artifacts、issue、PR 或日志**。Windows 作业前后校验九件历史私有源／回复文件的 SHA 保持不变。

## 证据等级

- V 形双翼墨迹支持可能来自汉字笔画、排版边框、示意图或模糊噪声；它只能提供进一步核实的位置建议，不能证明有一根有向箭头。
- 即使检测到正数 `GEOMETRIC_ENDPOINT_CANDIDATES`，`arrow_direction_verified=false`、`independent_graph_gold=null`、`certified_graph_f1=null` 不变。
- 若检测结果仍为 0，应优先观察隔离的私有 overlay 与像素源图并修正**错误类型**，不能以模型 4 边目标调整参数凑数。
- 真实拓扑独立参考仍需在未参考 GLM 候选的条件下对节点与方向逐项判断。可逐步引入本地多模态／独立 OCR，但任何 LLM 预测不能冒称人审 gold。

Draft/Open/Unmerged，未经明确授权不合并。保留所有首次失败、CI retry 和 Node20→24 弃用告警。