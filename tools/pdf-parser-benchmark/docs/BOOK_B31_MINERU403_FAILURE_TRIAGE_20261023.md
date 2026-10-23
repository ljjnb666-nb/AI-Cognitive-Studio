# 2026-10-23｜MinerU 4.0.3 两次真实 B31 失败后的受限离线诊断

## 准确事实，不掩盖首错

- 上游 Draft #140 历史首轮 Windows [CI #39976246006](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39976246006) 证实独立 MinerU 4.0.3 exe 可执行、`--version` 正确、原有缓存 **8 个 ONNX 权重**、同一份源 B31 第126物理页 PDF SHA 通过；但 `mineru parse` 非0退出，私有首次 stdout/stderr 保留，**没有成功 MD/JSON**。
- 第二次诊断确认 CLI 提供 `--tier`、`--pages`、`--output`、`--json`、`--force` 选项，但首次错误无法从安全的关键词匹配中分类。
- 第二轮限定修正 v2 仅删除 `--json` 与 `--force` 后，在 [CI #39977719133](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39977719133) 上仍为 `MINERU403_TRUE_OFFLINE_INFERENCE_FAILED`，而且 **v1/v2 原始日志分别保留于 D: 私有磁盘**。不能再归因为单纯无效 CLI 选项、不能编造 Model F1/CER。

## 本阶段只做诊断，不重复解析书页

新增 `ebook_mineru403_failure_triage.py`，严格只进行：

1. 通过上游原始 PDF、24 个已定物理页、B31 第126页单页 SHA 与历史缓存模型身份核验来源。
2. 读取两次真实失败的原日志，在本地用**固定允许类别**匹配依赖缺失、配置/模型资源、CLI 参数、网络请求、运行时后端、文件权限及格式错误；输出仅有限枚举类别和常见 Python 异常类名，**不输出任何错误行、模型路径、PDF 正文、真实文件名或密钥**。如果未知，保持 `UNKNOWN_FAILURE_PRIVATE_DETAILS_ONLY`，而不是胡乱归因。
3. 只有本机已有 `mineru-kit.exe` 时，调用官方只读的 `mineru-kit models verify --tier basic --small-backend onnx` 来核对**Basic 小模型集合的实际完备性**；不能调用 `download` / `parse`，不能自动安装；结果保存在新的私有 `b31_mineru403_basic_models_verify.private.log`，只公开是否通过与匿名错误分类。
4. 所有 CLI 调用禁用代理联网、锁定 `MINERU_MODEL_SOURCE=local`、`HF_HUB_OFFLINE=1`、`TRANSFORMERS_OFFLINE=1`，保留首次两份错误日志和历史 ONNX 权重前后 SHA。文档不能把有8个 .onnx 文件视为模型完整。
5. 只保存一次新私有报告 `multibook_matrix_20261023/b31_mineru403_failure_triage.private.json`，独占 O_EXCL；重跑时只读验收。若旧两份错误日志缺失/改变，立即停止。
6. Ubuntu 合成测试应证明原文不泄漏、不同异常类别可区分、失败证据不覆盖、模型 verify 非0不被认为通过、整项操作绝不触发第三次 MinerU parse。

## 安全和决策边界

完成本阶段后才能据模型 verify 与历史两次私有错误类别决定后续是否值得运行扫描页的 MinerU Basic OCR。MinerU 4.x 官方说明：Flash 面向快速内容提取，也可根据模式对扫描页调用 OCR；Basic 使用 ONNX 或 Torch 小模型，覆盖 OCR、公式和表格；Standard 还需要 VLM 权重。**不能因 Flash 推理失败就推断 Basic 必然失败或默认从云端下载权重。**

已明确禁止自动重试 v1/v2 的任何原命令，杜绝损坏历史证明；不能上传电子书、Markdown、私有错误日志或模型文件。所有 PR Draft/Open/Unmerged；未经明确授权不可合并。原先 #137 Ubuntu 540 秒 apt 失败、#139 合成首次误报、Node20→24 warnings 仍按原始结果保留。