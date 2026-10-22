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

## 证据账本严格冻结（增量审计）

- 每条匿名记录现在包含**原始电子书 SHA-256**，并与公开不含正文的 manifest 的书 ID、格式、物理页重新绑定。源文档哈希和页码不匹配会拒绝。
- 对来自准确 HEAD `8388ddbf...` 的 12 项字符数、耗时、原生文本代理 CER 启用精确快照锁定：连合理范围内的 +1 字、+0.1 ms、0.0034→0.0035 也会失败。此策略防篡改而非测量精度提升。
- 当前门禁属于**两份仓库静态文件之间的匹配和日志快照核对**，不连接 GitHub 日志 API，也不证明日志本身可靠。今后新增独立实测需创建新的版本化账本，不能修改既有成绩。
- pull_request 工作流改为校验真实 `head.sha`，不把 GitHub 合成 merge SHA 当作原始 HEAD；只允许运行在仓库所有者提交的 same-repo PR。
- 旧 HEAD 的完整 CI 曾发生图书分析执行权切换回执的真实测试失败，保留首次失败及异常调用栈；这与新增证据账本无直接代码调用关系，不能自行归类为已修复。
