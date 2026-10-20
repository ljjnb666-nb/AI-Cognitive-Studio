# PDF-FIGURE-STRUCTURE-03B：本地视觉提案与来源审计

## 本切片解决什么

03A 已从四页真实 PNG 保存了 **15 个来源可追溯的裁剪候选**；每个裁剪的 SHA-256、原始物理页和像素边界都在本机独立验收通过。03B 将这些私人图片接入结构化视觉提案流程，但仍**不能**把视觉模型提出的节点/箭头称为已验证的事实。

本切片不修改生产解析器、播客生成状态机或现有 OCR 结果；不把 PDF、PNG、OCR 正文、模型输入输出上传 GitHub。

## 两种运行模式

`python/local_vision_proposals.py --fixture RB-PDF-12 --mode prepare`

- 先校验源 PDF、Markdown、整页 PNG、裁剪 PNG 的来源 SHA 和裁剪像素完全一致。
- 为每一个真实候选生成空的 `nodes: []` / `edges: []` 模板和明确的 `NOT_REVIEWED` 标志，**没有实际调用视觉模型**。
- 输出到原私有报告根目录下独立的 `local-vision-proposals-v1-RB-PDF-12-prepare` 等新文件夹；拒绝覆盖已有结果。

`python/local_vision_proposals.py --fixture RB-PDF-13 --mode infer --model <已加载的本地视觉模型精确ID>`

- 仅支持 **LM Studio 本地 `127.0.0.1:1234`** 的 OpenAI 兼容接口；不经 HTTP 代理、不跟随 HTTP 重定向、不接受外部模型地址；模型必须已在本地 API 返回的已加载列表中。不会自动安装、下载或加载模型。
- 将**一张本地 crop PNG** 通过本机 loopback API 传给已选模型，要求返回精确 JSON `{"nodes": [...], "edges": [...]}`。
- 每个候选必须有像素 bbox；每条箭头关系必须有原 crop 内的 node IDs、箭头尖端点和可见的线段两端点；允许返回空列表或未知方向。
- 经已有 `vision_graph_proposal_contract.validate_candidate` 校验后，将局部坐标映射为整页坐标，但**不证明原图中确有该节点或箭头**。
- 输出数据仅保存于 D 盘，不打印模型原文、提示词、私有源文件完整路径、书页文字、节点标签或全部坐标。失败时不创建最终结果，模型超时或结构不合格即拒绝。
- `graphStatus=PROPOSED_UNVERIFIED`、`reviewStatus=NOT_REVIEWED`、`humanVerified=false`；独立人工复核前所有箭头方向和时序语义都不能交给播客生成使用。

## 实际能力核验

2026-10-20 Windows Runner 检测 [Actions #39456632480](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39456632480)：

- LM Studio CLI 已安装，Python torch/transformers/Pillow 已安装。
- LM Studio 本地 API **未启动**，Ollama 本地 API 也不可用。
- 没有执行真实视觉模型推理，因此当前只能以 `prepare` 执行本机图像来源验证与模板落盘。
- 单有 LM Studio 命令行工具并不代表存在可加载的多模态视觉模型。之后如开启本地服务，还需要确认模型可接受 PNG，并在第一次小样本结果中验收其输出。不能静默改用云端模型。

## CI、安全边界与验收

- GitHub-hosted Python `unittest` 仅对构造的合成结构和伪造模型响应测试。包括：跨页/更换 SHA、坐标越界、伪造人工审核状态、非 JSON 输出、模型缺失、重定向到云端、模板不冒充推理与重复提交覆盖。
- 真实 Windows 工作流须先执行**固定 Git Blob SHA** 验证，再使用 D 盘现有裁剪结果，不能执行有未提交改动的本地 Benchmark 工作区代码。
- 真实 `prepare` 成功只能表述为**15 个来源绑定的待视觉模型处理模板已落盘**，不是 15 张图片已完成视觉理解。
- 03C 需要实际已加载本地视觉模型的真实推理、可见节点/箭头证据校验和人工复核；P379 不清晰的横向箭头须允许 `UNKNOWN`，不可凭技术先验补全。
- PR 保持 Draft，依赖上一 Draft PR #99，未经明确授权不合并。
