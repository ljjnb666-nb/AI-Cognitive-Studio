# B31 原图两引擎输出：区分 Markdown 字符与真实 OCR 文字

## 真实前置结果（2026-10-23）

上游 Draft #142 的 [真实 Windows CI #39980610731](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39980610731) **成功使用 MinerU 4.0.3 `mineru-kit parse --tier basic --ocr-mode ocr`**，从已 SHA 锁定的 B31 原始 PDF 物理第126页生成私有 Markdown：

- 实际 Basic ONNX 模型为原缓存 8 个 ONNX 权重，官方 models verify 在 #141 成功，运行环境关闭下载与联网。
- 真实转换调用约 **17,263 毫秒**；输出 Markdown 文件 **106,990 个原始字符**，经独立回读与 SHA 验证通过，旧 MinerU 文档库两轮失败日志和模型权重未变化。
- 先前 RapidOCR 已在同一 B31 第126物理页识别 **50 行、1,191 个字符**，但并没有独立人工/参考证明这些文字全正确。
- 因 MinerU 导出的是 Markdown，其 106,990 个字符可能包含 Base64 图片、HTML 标签、Markdown 图片引用、公式或其他非文字部分，**不能和 RapidOCR 1,191 字直接当作有效文字数量比较**，更不能据此判定哪个引擎胜出。

## 本切片实现

仅读取已经成功创建的私有 B31 MinerU Markdown 与 #142/#135 原始报告，来源身份双重审核：

1. 按源 SHA 读取本机真实 Markdown，不重新调用 MinerU、RapidOCR、Docling 或 GLM。
2. 统计图片 `data:image/...;base64,` 的数量及占用字符、Markdown 图片引用数、HTML image tag 数、代码围栏、表格分隔行、数学块标记；剔除可识别图片负载后估算非空白非图片 Markdown 残留字符。
3. 以上**只属于 Markdown 语法层面的近似统计**，残留字符可能仍含结构符号、误识别、HTML 标签/不可见信息，不能当作真实 OCR 准确文字、更不能输出 CER。
4. 所有计算结果均为匿名计数；不保存或向 Actions 打印任何原文、图片、链接或内容地址。只在用户 D: `semantic_gate\multibook_matrix_20261023\b31_mineru403_basic_markdown_structure.private.json` 保存一次含原始源 SHA 和结构计数的只读可复验证据，O_EXCL 写入；不覆盖其他任何产物。
5. 既有 MinerU 成功 Markdown/日志、RapidOCR 文字报告、B31 原书图、旧两次失败记录以及全书原始 Benchmark 文件 SHA 前后不变。

## 测试与最终用途

Ubuntu 合成测试覆盖图片 Base64 不是 OCR 文字、外部图片引用、原文不泄露、私有回读、防篡改、伪造金标准拒绝。Windows owner-only 实际运行只产生来源固定的结构数量，绝不发起新模型请求。

**不能输出“MinerU 识别了 106,990 个字”“MinerU CER 优于 RapidOCR”或“MinerU 图结构解析成功”之类没有金标准的结论。**

下一阶段：同一批五本 OCR 固定页的 MinerU Basic、RapidOCR 与完整 Docling Standard 资源核验及统一指标测量；独立文字/表格/公式/图结构参考验证后再评选工具组合。

所有 PR 保持 Draft/Open/Unmerged，未经授权不得合并；首次失败及 Node20→24 warnings 继续保留。