# PDF 智能解析第二阶段｜Docling Standard 离线版面候选切片

## 开发基线

本切片基于已验收的 RapidOCR 生产候选 PR #186 HEAD `8c8edb259b0f9297d7e11a6ee5f8cde577920be4`，独立 Draft PR，不将五书独立 gold=0/5 当作开发阻塞。它的基础条件是沿用现有 PDF.js → 按页 OCR_REQUIRED → RapidOCR 文字路线。

## 本切片提供的真实生产源代码

- 新增 `packages/ingestion/src/docling/docling-layout-child.py`，使用 **Docling Standard 2.141.0**，`do_ocr=False`，禁用远程模型/第三方插件，CPU 两线程。用 PyMuPDF 从原 PDF **准确抽取指定 0-based 物理页为一页 PDF**，避免误认原书首页。
- 新增 `docling-layout-executor.ts`，通过已证明的 bounded child 执行器、隔离临时 PDF、最小化环境变量、超时、结果和模型来源指纹门禁运行；只允许输出 `NON_AUTHORITATIVE_LAYOUT_CANDIDATE`，携带 markdown 和文字/图片/表格候选计数。
- 保存原 PDF 的正文权威仍属于现有 PDF.js / RapidOCR 流程；Docling 输出**不能直接替换文档正文**，不能宣称 OCR 成功、图表曲线对应或 gold 准确率。它当前只是独立版面候选 API，**尚未写入数据库或由 Worker 自动触发**。下一切片需要加可审核的 sidecar 快照、来源关联和选择门禁，避免给核心路线加隐式副作用。
- 子进程遵循版本/离线模型实际 SHA 摘要；同样具备 shutdown abort、关闭后拒绝新请求、防止未确认进程成为有效结果的机制。

## 阶段验收

- 七项 Vitest 合成测试：禁用/无效资源拒绝、版本与模型指纹、精确来源 PDF/页码、拒绝伪造金标准、输出协议恶意字段、关机中断与结果竞态。
- Ubuntu 运行 Python 编译门禁，不触碰任何私有电子书。
- Owner-only Windows 使用已存在的 Docling 2.141.0 虚拟环境和离线布局模型，合成一份两页 PDF，要求 `--page 1` 只导出第二页内容且不包含第一页面的特征文本，真实执行 Docling CPU Standard。若现有环境或布局模型不齐，必须安全拒绝而不是联网下载、篡改 venv 或称为通过。
- 原始 PDF、个人电子书、OCR 文字、模型路径或完整 SHA 不出私有机器。工作流只打印固定英文状态码，保留首次 CI 失败和 warning。

## 还未完成的第二阶段工作

1. 确定复杂页面启用规则（图文混排/多栏/表格），**条件性**调用 Docling；
2. 将只读候选连同页码、来源文档 SHA、执行环境模型哈希写入可审计私有持久化快照；保留正文独立权威，解析失败不影响正常的 PDF.js/RapidOCR 路径；
3. MinerU 条件回退与视觉模型局部裁决，要求独立质量门禁，不以多数投票冒充真值；
4. 最后真实电子书、Worker + DB + MinIO 全链路、内存峰值及性能准入。

**状态：** #161 OPEN；五书 gold 0/5；CER=null；生产架构未冻结。所有相关 PR Draft/Open/Unmerged，未经用户明确授权不合并。
