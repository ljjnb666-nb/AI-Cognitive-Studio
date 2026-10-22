# 2026-10-23｜真实电子书识别器匿名对照账本

此切片基于 PR #108 的已验收准确 HEAD：8388ddbf789e1b97983220a470be1b5e6efe95a8。不改动绿色 PR #108、生产解析路由、人工认证或 Windows 私有原书。

## 可信事实

- [真实 Docling 3 页](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39807569923)：B15 两图片两来源框、旋转 270°；B31 三图片三来源框；没有可用 L2 私有参考，因此尚未进行真实 IoU。
- [真实 PaddleOCR 3 页](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39807570076)：仅文字 OCR 及版面数量，不含图表语义认证。
- [真实 MinerU Flash 3 页](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39807569900)：B16 原生文字层成功；B15/B31 是不进行扫描 OCR 的负对照。Basic/ONNX 模型就绪检查未通过。
- [原生/EPUB](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39807569958)：27 本来源 SHA 匹配、24 个物理 PDF 页、69 组原生解析执行。
- [完整 CI](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39807569996)：6/6 作业成功；准确 HEAD 共 13/13 工作流成功。既往失败、取消与 Node.js 弃用警告不能抹除。

## 账本性质和边界

corpus/ebook-20261022.cross-engine-evidence.json 仅记录从上述 GitHub 实测日志独立复核并转录的匿名页 ID、字符数、耗时、来源工作流和证据状态。这是人工转录的静态快照；代码门禁不自动重新读取 GitHub 日志验证数值，因此之后变更时必须重新查看原始 job 日志。

通过脚本 ebook_evidence_gate.py 检查来源 HEAD、行覆盖、页码、工具角色及所有认证权威的禁止升级条件。特别禁止把 PDF 原生文字层代理 CER 当成人工 CER，把 MinerU Flash 负对照当作扫描 OCR 失败或胜利，把图片框数当作图表/箭头语义正确率。

全程只有匿名公开统计，不含电子书正文、书名、图片、私有 ROI 坐标或 OCR 原文。所有 certified_cer 与 certified_graph_f1 为 null，human_verified / graph_verified 为 false，最终解析器选型保持 UNDECIDED。

## 下一步

在 D 盘已有私有基准目录下完成 L2 参考部署、B15 270° 旋转显示坐标变换核验及真实 IoU；再进行独立扫描 OCR 真值和图表关系预测评测，统一冷热启动与 CPU/GPU 资源后进行最终路由决策。此前不得合并结果为生产自动认证。
