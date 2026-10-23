# 2026-10-23 B31 原始图像的纯离线 OCR 独立观察

## 本阶段为什么转向 OCR

- 上游 Draft #133 准确 HEAD `45d59562700f6fb01b8f0dae64a9ee6686429aa6`，完整 CI #39956828393 **SUCCESS**，真实 B31 物理第126页原始像素几何证据共 103 个端点；先前 3 处双翼连续/低背景、32 处局部墨迹连通，均**只是未认证几何复核线索**，无法独立确认实际节点、边及方向。
- 用户此前上传的原始电子书 ZIP 仍在 Library，但当前 ChatGPT 容器经 Files 权限核查**无法获取原始字节**；不能自称已肉眼判读 B31 原始页面。因此不能继续叠加 CV 阈值然后伪造高质量结构标签。
- 这一 PR 开始**本地、独立、来源严格隔离的 OCR 语义观察**，目的在于判断是否可以从原始扫描图读取真实文字、辅助定位节点。OCR 结果仍不是独立图结构金标准。

## 引擎与成本边界

Windows 本地缓存环境优先使用 `rapidocr_onnxruntime` 已安装包和**已包含在包内**的 detection/recognition ONNX 权重；严禁自动下载新权重，未找到可验证的 `det` 和 `rec` 模型文件时明确输出 `NO_OFFLINE_OCR_ENGINE`，不得假装识别成功。只处理经 Manifest PDF SHA、物理页 126、私有 PNG SHA 验证过的原始 B31 图片，不读取 GLM 预测和其原始回复。

为了避免与包/API 差异导致隐形联网，禁止调用现代 `rapidocr` 包的自动模型下载入口。仅在已安装的旧 `rapidocr_onnxruntime` 包内核验完模型文件后才加载旧 API；如果不可用，报告能力缺口而不是静默安装。

结果保留在：
`D:\ai-cognitive-pdf-benchmark-data\semantic_gate\b31_source_offline_ocr.private.json`

报告可包含识别到的真实中文字符串、OCR 置信度和字框坐标，但**全部只在私有 D 盘落地**；GitHub Actions 只输出引擎是否具备、文本行数和字符数，不包含源 SHA、书本内容、文字、框坐标、截图或模型文本。最多 300 行、4000 字符且 JSON ≤ 500 KiB，任何越界拒绝。未可用时行/字符数为 0 且状态为 `NO_OFFLINE_OCR_ENGINE`，**不是 OCR 准确率 0**。

默认只读无写入；`--write` 只允许 O_EXCL 独占创建一次；`--audit-only` 必须验证来源 SHA、书本物理页、未认证状态和所有 OCR 行的格式/计数。已有损坏证据时不覆盖，保留现场。

## 可信与不可信结论

即使 OCR 成功，也不等于真实 OCR CER 已校验，更不能据此声称已建立 5 个节点／4 条边的独立金标准。零 OCR 文本可能是图中文字难识别或本地模型缺失，需区分 `NO_OFFLINE_OCR_ENGINE` 与 `OFFLINE_OCR_OBSERVATION`。

禁止发布 Graph F1、箭头方向准确率、解析引擎最终冠军等未验证结论。B15 历史未知计费继续隔离、B31 原付费 GLM 请求不重试；所有 PR Draft/Open/Unmerged 未经授权不得合并。

## 测试及发布

- Ubuntu exact-head synthetic 10 项：合成 OCR 回答/未安装引擎/私有 SHA/非法评分/中文坐标/拒绝覆写/伪 gold。Linux 不需要下载 OCR 权重。
- Windows exact-head owner-only：现有缓存 Python+OpenCV；在没有 API Key、无网络模型下载的前提下探测本地已打包 OCR 模型并对真实 B31 图片做一次观察，先只读→独占写入→只读回验；执行前后 **15 件历史私有证据 SHA 不变**。
- 任何结果都不自动将 OCR 文字放到 GitHub、不向模型发送图片或 OCR 内容，不改动现有原图、候选、历史 GLM 消耗记录。Actions Node20→24、Windows checkout retry 的既有警告照实保留。