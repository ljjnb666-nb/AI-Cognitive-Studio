# 2026-10-23｜B31 扫描图 PDF：官方 MinerU 无状态 Basic ONNX OCR 实测

## 为什么改变执行入口而不是重复重试

- Draft #140 两次真实 `mineru parse`（使用 Doc Library 的文档库入口）在同一 B31 物理第126页非0退出；删除 `--json` 和 `--force` 并没有消除失败。原始 v1/v2 stderr 日志都在私有 D 盘，不能覆盖、不能宣称结果通过。
- Draft #141 Windows exact-head [CI #39979760007](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39979760007) 的受限分类仍无法安全判断 v1/v2 的具体根因，但确认 **`mineru-kit.exe` 存在、官方 `models verify --tier basic --small-backend onnx` 返回0**。这证明当前本机配置下 Basic ONNX 模型**通过官方完整性验收**，不代表旧文档库入口成功。
- 官方 MinerU 4.x 明确区分：`mineru parse` 使用文档库/缓存，而 `mineru-kit parse` 用作**无状态单文件实际转换**。Basic 是带小模型的 OCR/公式/表格档位，不依赖 Standard/Advanced VLM。

## 本切片唯一真实推理动作

在无需联网的 Windows Runner 中，只对从原 SHA 固定 B31 PDF 裁出的**物理第126页**私有单页 PDF 调用：

`mineru-kit parse <私有原生单页PDF> -o <私有新Markdown> --tier basic --ocr-mode ocr`

使用历史同一 MinerU 4.0.3 环境，不重新安装软件、不下载权重，不触发 GLM/外部 VLM。设置 `MINERU_MODEL_SOURCE=local`、`MINERU_MODEL_SMALL_BACKEND=onnx`、`MINERU_TABLE_DEVICE=cpu`、HF/Transformers offline，断开 HTTP/HTTPS/ALL_PROXY；默认拒绝模型不完整、原 B31 页 SHA 不一致的执行。

- 仅在诊断 PR #141 私有 `basic_models_verified=true` 且从原始私有报告回读验证后准入。
- 仅允许首次运行，CLI 原始 stdout/stderr 仅存私有 D 盘，不向 GitHub 输出模型路径、图像、书本正文或私有源 SHA。
- 硬性限时 **900 秒**，执行码0 + 新 Markdown 非空且不超限 + 模型权重和原页 SHA 前后不变 + 独占私有报告完整 + 只读审计通过，才称真实 MinerU Basic OCR 成功。
- 如果失败，保留新的 v1 私有日志，不生成成功 JSON，不在同一个 CI 里循环重试。旧两份 `mineru parse` 失败日志和官方模型 verify 记录 SHA 全程保持不变。

新输出（全部仅 D:）：

`semantic_gate\multibook_matrix_20261023\b31_mineru403_basic_onnx_stateless.private.md`

`semantic_gate\multibook_matrix_20261023\b31_mineru403_basic_onnx_stateless.private.log`

`semantic_gate\multibook_matrix_20261023\b31_mineru403_basic_onnx_stateless.private.json`

## 不代表的结论

即使成功，Markdown 文本字符数和耗时也只是**实测输出量**，无法无独立人工/可信参考计算 OCR CER、表格 F1、图节点/有向边 F1、箭头方向正确率。因此仍不得给解析器排名。

此前五本 RapidOCR 各一页、六本24页 PyMuPDF/Docling Native 是跨书基线；**本 PR 仅验证 MinerU Basic 在 B31 一页的真实输入输出**。待通过后才进行其他固定 OCR 页、同页引擎质量对比。

上游 #137 540秒 apt 下载失败、#139 首次模型候选正则误报、#140 两次实际 MinerU 非0、Node20→24 警告均保留。未经明确授权全部 PR Draft/Open/Unmerged，不合并、不公开电子书。