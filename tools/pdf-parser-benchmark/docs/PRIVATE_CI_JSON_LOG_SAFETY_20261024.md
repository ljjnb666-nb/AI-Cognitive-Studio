# Windows 私有 JSON 回执日志防泄漏修复（安全 P1）

## 已确认的失败与安全边界

2026-10-24 的 [#165 首次专项 #40091069683](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/40091069683) 中，B15 私有关联回执已 `PRIVATE_CREATED → PRIVATE_VERIFIED`、图像 2、候选行 19，但随后 Windows PowerShell 使用 `Get-Content | ConvertFrom-Json` 解析含中文 OCR 文字与四点坐标的 JSON 时失败，异常文本意外包含**部分私有 OCR、坐标和完整 SHA**。GitHub checkout 曾出现 `curl 56 / early EOF`，重试后成功；需保留失败摘要，不可在公共文档、Issue、PR 粘贴原始日志数据。

**历史日志删除成功响应：** 2026-10-24 仓库所有者执行 GitHub API 删除 run #40091069683 的日志，响应 `HTTP/2.0 204 No Content`（12:22:33 GMT）。证据记录于 [Issue #166](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/issues/166)。HTTP 204 不能证明早先下载的副本、第三方缓存或存档已被销毁，仍需独立验证新工作流的安全防线。

## 系统性防线

本 PR 是独立于 OCR 架构功能的安全整改，基于尚未合并的 #165 堆叠分支，并且不触动原始私有 PDF、PNG、OCR 结果、模型参数及生产业务。新增纯标准库 `ebook_private_ci_receipt_gate.py`：

- 有界读取本机 D: 私有 JSON；拒绝软链接、缺文件、超限文件、JSON 重复键、NaN/Infinity、编码错误。
- 按**固定枚举 policy** 判断原工作流已经要求的字段/结构/数量及不变量；拒绝把 AI 候选内容自动标成独立 gold。
- 成功只输出 `ACS_PRIVATE_RECEIPT_GATE=PASS`；失败只输出 `ACS_PRIVATE_RECEIPT_GATE=REJECTED`，**任何异常都不打印原始 JSON、堆栈、路径、OCR 文本、私有 SHA**。
- 准确 SHA 的 Linux 无需任何额外安装，测试每种 policy 的成功与拒绝、编码/重复 JSON 错误与私有文字不外泄、符号链接拦截，以及对应 YAML 文件静态扫描。
- 所有私有源文件保持 D:；工作流继续进行自身已存在的源文件 SHA 前后守恒检查。

本次替换的 **11 条受影响工作流**：

1. `ebook-fivebook-docling-standard-rapidocr-real.yml`：五本真实 Standard+RapidOCR 全成功约束。
2. `ebook-fivebook-three-engine-crossbook-consensus.yml`：五书五页三路一致性源数量。
3. `ebook-b15-b03-blind-source-review.yml`：两张原图且 0 独立 gold。
4. `ebook-blind-review-offline-workbench.yml`：两图来源、0 审核、仅本地草稿导出。
5. `ebook-blind-review-edge-real-smoke.yml`：真实 Edge 工作台未审核状态。
6. `acs-ebook-b15-frame-private.yml`：B15 Docling 版面临时对齐，不得声称图语义正确。
7. `acs-ebook-windows-mineru-flash-real.yml`：三页真实 MinerU Flash 检查及模型环境诊断存在性。
8. `acs-ebook-windows-rotation-private.yml`：三页原始旋转和图像几何保留约束。
9. `acs-ebook-private-visual-l2.yml`：图表 L2 参考来源的非 gold 和临时坐标准入。
10. `acs-ebook-windows-docling-real.yml`：旧版三页 Docling 私有 OCR 报告及图像几何检查。
11. `acs-ebook-windows-paddle-real.yml`：旧版三页 PaddleOCR 私有报告及非 gold 图表语义检查。

## 验收与限制

本切片先运行标准库 synthetic / YAML 静态守卫以及准确 HEAD 完整主 CI。上述 11 条私有 Windows 工作流具有自己特定的 branch selector，不会因为本安全 PR 而全部自动重跑；只有它们**在后续各自正确 HEAD 的 Windows 真实执行通过**，才可以说运行时回归也验收成功。

原有某些工作流将丰富诊断指标逐字段写入公开日志，现在收敛为匿名 PASS/REJECTED。这减少了公开侧可观测性，**完整指标并未删除，仍留在受保护的私有原始报告**。以后需要公开统计时，必须引入白名单数值投影和类型校验，不能直接打印不可信字符串。

- #165 修复版将 private B15 候选总数检查移入 Python `--audit-only --require-candidate-count 19`，并新增回归；本安全 PR 作为更广的防线。
- 任何后续日志删除仅指向**单一包含敏感回执的失败运行**，不应删除全部工作流历史或消除失败验收摘要。
- 原始 OCR 内容/页内坐标/原书图仍禁止公开上传。Issue #154、#161、#166 继续 OPEN；所有 PR Draft/Open/Unmerged，未经用户明确授权不得合并。

## 2026-10-24 全仓库 51 条工作流二次检查

#167 的原始 9 条整改之外，确认 Docling/Paddle 两条旧 Windows 工作流仍使用 `Get-Content | ConvertFrom-Json` 读取私有 JSON。已新增 2 种私有策略和合成测试，并在 owner-only 只读 Windows 收据兼容性检查中加入两条可选回执；可选回执缺席仅记 `NOT_PRESENT`，不可冒充通过。Docling 原来读取公开 PyPI wheel 元数据的转换与私有报告无关，继续保留。其余流程不在本次私有 JSON 命中范围，广义日志脱敏仍需持续审计。所有准确 HEAD CI、Windows 真实 job 以最终运行结果为准。
