# 五本 PDF 同源页：真实 Docling Standard + RapidOCR 离线基准

## 目的与已完成基线

上游 [Draft #158](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/pull/158) 准确 HEAD `27a2313c158b059b82f271663ba2a2125a6fa174`：主 CI、51/51 合成测试和 Windows 实测均成功。B15 原书物理第 109 页已用 Docling Standard + RapidOCR 真实解析（18,140ms、文字对象 29、图片对象 2、规范化字符 99）。与 MinerU、独立 RapidOCR 同源比较时，差异集中在源页下中；尚无独立 OCR gold，**不得根据字符数直接选赢家**。

目前五本真实 OCR 焦点 PDF 分别是：B03 物理页 67、B08 物理页 64、B15 物理页 109、B29 物理页 72、B31 物理页 126。后四页以往已有独立 RapidOCR 和 MinerU Basic 等来源证据，但**尚无四页 Docling Standard + RapidOCR 的实际转换结果**。

## 此 PR 的真实执行与固定来源

新增脚本 `ebook_fivebook_docling_standard_rapidocr_real.py`：

1. 只读重验五本 PDF 的同一来源、选页 SHA、五本 RapidOCR、五本 MinerU、24 页 Docling Native，并沿 #158→#155 的不可变回执追溯真实成功的 B15 Standard+RapidOCR。**B15 不再运行模型，直接重用 v4。**
2. 查验 Windows 私有 D: 中固定的 Docling 2.141.0 layout 目录与已经验收的独立 RapidOCR 3.9.2 / ONNXRuntime 1.22.1 环境。目录唯一且不允许路径逸出、软链接或源页被改写。
3. **只对 B03、B08、B29、B31 各执行一次真实同源单页 PDF Standard + RapidOCR。** 依次独立子进程而不并行；CPU 两线程/页、165 秒超时，OCR 全页中文开启、表格结构模型关闭、禁用远程服务和模型下载。现有虚拟环境不修改、不安装软件。
4. 每页独占生成 v7 私有 receipt、worker 原文 JSON 和 stdout/stderr 日志，O_EXCL 禁止覆盖。成功页存实际耗时、文字/图片/表格对象数、统一规范化字符数及 worker SHA；失败页保留 status 和 D: 私有日志，不能宣称已解析成功。
5. 运行中断时，已经有完整回执的页只通过 audit-only 复验，**不再推理**。若 worker 孤立存在而无完整 receipt，则 fail closed，须审计和受控恢复，禁止静默删除或重复花费资源。
6. 五页总摘要 `fivebook_docling_standard_rapidocr_real.v7.private.json` 仅在所有子页已完成或保存失败状态后创建，亦不可覆盖；后续 audit-only 对照四份不可变 receipt 的 SHA、重算文字长度和来源合计。
7. Windows CI 先确认主机空闲内存不少于 2GB，逐页顺序执行并独立核验；**只有 5 页真实 OCR 全部 SUCCESS，CI 才允许 SUCCESS**。单页失败须保存私有日志并使专项 CI 失败，不以流程结束代替模型成功。
8. 公共 GitHub 仅输出书代号、物理页、数值、匿名状态；不得公开真实电子书、Markdown、图片、精确坐标、私有原始路径、源 SHA、模型权重或 API Key。所有旧证据哈希必须 unchanged。

## 分析边界与后续

这是首轮跨五本书的真实 Standard+RapidOCR **功能/耗时/输出数量**基准，尚未完成独立参考文字、CER、布局 F1、公式/图表 F1、端到端播客准确度评测。B15 与另一四页采用的同一 OCR 模型，前者是重用旧回执（实验批次不同），比较耗时时需考虑环境加载和运行条件。模型一致 ≠ 内容正确；不同引擎字符更多 ≠ 更优。

全部五页通过以后，下一阶段才对三条路线的**跨书文本一致性**、图表保留、耗时分布和资源峰值做综合评估。未获得跨书结果前不冻结解析架构，也不擅自合并任何 Draft PR。
