# 2026-10-23｜B31 第126物理页：独立于 GLM 候选的原始 PDF 视觉证据

## 当前事实

- 上游 Draft PR #125 HEAD `1b891ce7a2ddeac9a31a6e37a5330724b0b60143`，实机已从保存的 GLM 回复离线生成 **5 个暂定节点、4 条有向连线**，结构合同通过；它仍不是源图真实拓扑金标准。
- 对 B31 的准确率校验不能把同一 GLM 回复或其匿名化候选用作 reference，因为那会造成同源自证、伪 F1。
- 原电子书压缩包虽保存在项目文件库，但当前会话无法直接取得 ZIP 原始字节；Windows 自托管 Runner 已有经 SHA 固定的 D 盘私有书源。这一切片直接从私有 PDF 的像素创建独立证据。

## 证据隔离

`ebook_b31_independent_source_packet.py` 只按 Manifest 查找 B31 原始 PDF，重新校验 PDF 文件大小、SHA、总物理页数、物理页 126、旋转 0°；使用 PyMuPDF 从**源页面**生成一次固定参数的 PNG。全程不读取 `visual_graph_proposal_B31.*` 模型回复/预测文件，更不调用任何模型/服务。

另记录源 PDF 的原生 drawing paths、embedded image entries、文字块数量等粗粒度计数，以决定后续是否可用矢量几何推导箭头；**这些数不是节点数量、箭头数量或正确率**。

新私有文件，仅写在原 D 盘 `semantic_gate`：

- `b31_source_only_page126.private.png` —— 完整页面像素证据；
- `b31_source_only_page126.private.json` —— 来源 SHA、物理页、像素摘要、渲染宽高、原生结构计数，`human_verified=false`、`certified_graph_f1=null`。

先执行完全不写入的预览；通过后使用 O_EXCL 创建一次。任何已存在文件或未完整生成都不覆盖、不自动重试。Windows 再验证历史 B15 request、B31 request/reply/candidate 四件文件的 SHA 在前后不变。

所有电子书页面图像和其摘要**仅在 D 盘保留**。严禁推送到 GitHub、Actions artifacts、PR 讨论或日志；只在 Actions 输出匿名数量和 `SOURCE_ONLY_NOT_GRAPH_GOLD`。固定仓库拥有者同库分支 exact-head，Runner 不注入 GLM 秘钥。

## 可得结论 / 不可得结论

验收通过时只能得到一份独立于模型预测的**源像素**和原生格式证据；并不能仅因为生成了源 PNG，就断言 5 个节点和 4 条箭头正确。下一步应基于源图独立抽取/审查几何与节点身份，构造脱离模型输出的独立 reference，然后比较并核对方向与漏检。

禁止无参考时计算所谓真实 Graph F1。保持此前 B15 未知计费隔离、B31 一次真实 GLM 请求和原始回复均不可修改；所有堆叠 Draft PR 均不合并。保留首次错误、CI retry 和 Node 弃用告警。
