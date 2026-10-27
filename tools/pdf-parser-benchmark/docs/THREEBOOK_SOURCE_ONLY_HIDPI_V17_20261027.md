# Stage 1 v17 — B08/B29/B31 原始 PDF 高分辨率来源核验

本增量承接 v12 五书原图与 v13 B03/B15 的 3×3 高分辨率审阅，不重写或覆盖任何已冻结 v12/v13/v16 快照。

- 严格源：D: 私有现存的三个 **SHA 固定单页原 PDF**，通过已有五书 `source_contract` 逐页复核，拒绝同源错误或篡改。
- 输出：3 张高分辨率整页 PNG、27 张独立来源 3×3 tile、一个只读离线 HTML、一个匿名来源身份/尺寸/私有 SHA 回执；只写入 `D:\ai-cognitive-pdf-benchmark-data\semantic_gate\multibook_matrix_20261023\b08_b29_b31_source_hidpi_v17\`。
- 只进行来源渲染，**0 OCR、0 AI/GLM、0 下载、0 外部审核批准**，不计算 CER，不自动选择引擎。
- Linux 合成 PDF 测试覆盖三页/27 格、快照二次逐字节审计、篡改拒绝、网络/CSP 约束；Windows owner-only 真实来源在 `HEAD` 匹配后只读取 SHA 固定原件，写入独立目录，二次回放审计并校验原始七份源文件均未修改。
- 所有真实图片、版权内容、精确源哈希、原文草稿只保留 D: 私有目录；不能进 GitHub、CI 日志或 Artifact。首次失败/重试与 Actions 警告保留。
- 只解决三书**可观察原图清晰度与可复查性**，不代替真正独立逐字校对与审核。五书 Gold 0/5、CER=null，Issue #161 OPEN，ARCHITECTURE_NOT_FROZEN；生产 Docling 不启用，未授权不合并。

下一步在 B08/B29/B31 真原图中逐页先记录文字/表格/图像范围、竖排与公式等难点，然后仅对相同页面范围的三引擎输出独立打分。
