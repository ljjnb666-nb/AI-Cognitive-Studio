# B15 / B03 原书盲审工作台（本机离线 v10）

## 已验证上游

- [Draft #162](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/pull/162) 准确 HEAD `1657ddc4368511a20c4b354647a4f4eb9791b276`：owner-only Windows 已在 D: 私有目录**真正生成** B15 p109 R3C2 裁片、B03 p67 整页图片；随后 audit-only 成功，来源 SHA unchanged。
- 两份冻结来源表仍是 `SOURCE_ONLY_BLIND_UNREVIEWED`，**审核通过数 0，CER 未验证**。任何引擎共同识别出的内容都不是独立标准答案。
- #162 主 CI 需以对应 HEAD 最终 `validate` 为准；上游不同类型门禁不能相互替代。

## 本切片的实际目标

新增脚本 `ebook_blind_review_offline_workbench.py`，仅在原有本地私有目录旁生成**完整离线的中文 HTML 工作台**。它无需数据库、前端服务、Node 安装、账户登录或云端模型，可直接用本机 Microsoft Edge 打开：

`D:\ai-cognitive-pdf-benchmark-data\semantic_gate\multibook_matrix_20261023\blind_source_review_v9\原图核对工作台.private.html`

页面将同时提供两个可切换来源：B15 的下中 R3C2 裁图、B03 第 67 页完整原图，以及图片缩放、区域类型选择、原图转录草稿和不确定性记录。**页面不显示任何 RapidOCR、MinerU、Docling OCR 候选，也不把这些候选写入正文。**

页面按钮只能触发浏览器**本地下载 `DRAFT_UNVERIFIED.json` 草稿**。草稿永远包含：

- `status=DRAFT_UNVERIFIED`
- `independent_reference_verified=false`
- `reviewer_approval=null`
- `cer=null`
- 同源书代号、物理页、范围、来源图片 SHA、草稿内容及不确定项。

这一草稿不是独立 OCR 金标准，不支持“批准审核”、自动推理、上传到 GitHub、计算 CER 或替换现有 `independent_reference_vN`。如果页面填写后没有导出，内容不会隐式保存。切换图像也会清空当前填写内容，防止跨页串写；浏览器关闭后内容不自动恢复。

## 不可变性、隐私与验收

1. 每次创建或审核工作台，必须先对上游 v9 两张图片、两张空白表、历史源 SHA、v8 三引擎回执执行完整 `audit-only`。
2. HTML 只含不敏感的页面代号、范围、两张图片的相对文件名与**私有来源哈希**；不嵌入 OCR 文字、完整电子书正文、图片像素或任何云端资源。原图 PNG 仍在 D:；绝不将 HTML、原图、草稿发布至公共 CI artifact/日志/仓库。
3. 本地页面通过 CSP 阻断 `connect-src` 网络请求与外部样式/脚本；没有 `fetch`、网络上传或服务端调用。操作只生成本地浏览器 JSON 下载。
4. 文件 `blind_source_offline_review_workbench.v10.private.json` 和私有 HTML 首次 O_EXCL 写入，日后只能 `--audit-only`，须逐字节与冻结源重新计算结果吻合，任何来源图片或表被修改均 fail closed。
5. 完整验收需要新 5 项 synthetic + 上游 66 项回归、准确 HEAD 主 CI、owner-only Windows 真实私有工作台创建和 audit-only。**CI PASS 只表示浏览器工作台文件、安全与来源契约完成**；尚未执行真实独立原书校对。
6. 本 PR 不合并、不创建独立参考文本、不调用模型；架构选型仍是 `ACCURACY_UNVERIFIED / ARCHITECTURE_NOT_FROZEN`，#161 继续 OPEN。

## 真实原书审核的下一步（不在本 PR 自动完成）

要决定 B15 下中 61–63 个额外字符是否真来自原书，必须实际查看图片并针对相同范围留下可核对的目视转录，不能拿其他 OCR 的完整页字符串充当局部参考。工作台导出的 `DRAFT_UNVERIFIED` 只是工作底稿。经过**独立可追溯的来源审查**以后，应在独立的已审核参考记录中附源图 SHA、同一 ROI 范围、审核来源与证据，再用同范围的 OCR 输出计算 ROI CER；若未核对，始终报告 `CER=UNVERIFIED`。

目前 ChatGPT 只能通过公开 GitHub 查看流程与匿名结果，**不能直接从 Windows Runner 的私有 D 盘读取图像像素**。若之后要由 ChatGPT 做视觉初审，需在对话中提供原图/裁片；AI 初审仍不能冒充独立认证金标准。
