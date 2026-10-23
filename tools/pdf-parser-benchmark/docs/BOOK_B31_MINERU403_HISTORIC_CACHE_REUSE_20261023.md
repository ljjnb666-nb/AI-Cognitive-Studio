# 2026-10-23｜发现 01F 原 MinerU 4.0.3 隔离环境：不重新下载，直接实测 B31 同一源页

## 为什么上一个模型探测为零

Draft #139 的 Windows owner-only 任务仅在四个当时存在的有限目录中寻找权重，未扫描到疑似模型。它正确报告**扫描范围无权重**，但这不等于 Windows 主机不存在 MinerU。历史 **REAL_BOOK_BENCHMARK_01F_EVIDENCE.json / REPORT.md** 给出了之前的确定路径：

- MinerU 安装：`D:\ai-cognitive-pdf-benchmark-data\python\mineru\Scripts\mineru.exe`（01F 历史版本 MinerU **4.0.3**）。
- ONNX 缓存：`D:\ai-cognitive-pdf-benchmark-data\cache\mineru\home\models\MinerU-4_models_onnx`（01F 约 **819 MB**、五个 ONNX 权重）。
- 旧实测为 RB-PDF-12/13，旧验收报告保存在 `D:\ai-cognitive-pdf-benchmark-data\reports\REAL_BOOK_BENCHMARK_01F_REPORT.md`，旧离线运行曾报告零模型下载。
- 以上是**历史交接证据**，本 PR 必须重新核验对应路径、可执行性和缓存 SHA，不能把旧 01F 测试冒充新的 B31 实测。

## 本 PR 实际范围

从当前 6 本 PDF × 4 页的正式 Manifest 中，选择 B31 的**物理第126页**，直接复用 Draft #138 已 SHA 验证的 `multibook_matrix_20261023\docling_native_single_pages\B31_p0126.private.pdf`；它是从原 B31 PDF 物理第126页裁出的**真实一页**，和 Docling Native 的输入相同。不得以 RapidOCR OCR 字符串、GLM 5节点4边候选或临时合成页冒充。

使用已有旧 exe，且必须从私有 `MINERU_HOME` / `MINERU_MODEL_BASE_DIR` 读取已有五个以上有效 ONNX 文件并计算**私有 SHA-256**，不能重新安装 MinerU 4.0.3，也不能下载模型文件。仅在本机本地源模式运行：

`mineru parse <原始私有单页PDF> --tier flash --pages all --output <仅D盘私有md> --json --force`

- `MINERU_MODEL_SOURCE=local`，`HF_HUB_OFFLINE=1`，`TRANSFORMERS_OFFLINE=1`，HTTP/HTTPS/ALL_PROXY 指向不可用端口，禁止云端提供商；所有 stdout/stderr 重定向至 D 盘**私有日志**，避免泄露 PDF 正文/文字、模型路径、源文件 SHA。
- 每次只运行这一页，限制 **720 秒**，CPU/GPU 使用由既有 MinerU 4.0.3 离线模型配置决定，不在此 PR 擅自调整模型或精度。
- 成功要求进程 **exit 0**、指定 Markdown 文件真实存在且有限、模型目录的**全部 ONNX SHA 前后完全一致**、指定原始单页 PDF SHA 不变，然后私有创建 `b31_mineru403_flash_source_only.private.json`。记录真实调用耗时、原图来源/模型哈希、Markdown 大小、成功标记。
- 先只读模型及来源核查，再第一次真实运行；已有报告则只读回验，不重复推理；如运行中断或失败保留已有私有日志和输出，不清理/覆写。
- 私有原书、24张裁切页、5张源图、RapidOCR/Docling 原本输出及 B15/B31 历史 GLM 付费标记都保持未修改；禁止将模型文件、Markdown、图片、实际路径、请求/回复、密钥、私有 SHA 上传 GitHub 或 Actions artifacts。

## 结果边界

这一真实 MinerU **flash ONNX** 测试如果成功，也只是 MinerU 在 B31 原页的**实际输出与耗时**，而不是准确率。Graph F1、OCR CER、表格/公式参考、箭头方向依然 `UNVERIFIED`，不能比较一个 MinerU flash 页与五本 RapidOCR、24页 Docling Native 的无归一化耗时。

下一步扩展到五本书同一页，再至全部24页，同时尽量加入已经缓存的 Docling Standard 所需完整模型资源；必须在每个引擎上声明实际是否使用 OCR/布局/表格模型，禁止用“包已安装”代替模型已执行。

所有 PR Draft/Open/Unmerged，未经用户明确批准不得合并。上游 #137 apt 540s 首错、#139 首次 synthetic 正则误报、Node20→24 warnings 均不抹除。
