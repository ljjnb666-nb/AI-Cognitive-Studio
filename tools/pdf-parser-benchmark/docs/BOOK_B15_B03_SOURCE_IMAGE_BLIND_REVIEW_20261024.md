# B15 / B03 原始图像盲审包 v9（Issue #161）

## 目的与事实边界

上游 [Draft PR #160](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/pull/160) 的完整主 CI、61/61 synthetic、五书 × 三组 OCR 的 15 组 Windows 私有同源文本一致性评测全部成功。五书的机器输出不同不表示某一结果错误，更不代表有独立标准答案。

主要疑点：B15 原书物理第 109 页下方中央 R3C2 占独立 RapidOCR 相比 MinerU/Docling 多出字符的大约一半；次要疑点：B03 物理第 67 页，三路文字存在差异。**此前任何 OCR 输出都不可以反向写成参考真值。**

## 本轮实际交付

脚本 `ebook_b15_b03_blind_source_review.py`：

1. 对原始六书 24 页基准中已冻结的渲染 PNG、原始书 PDF SHA、图像宽高、B15 3×3 差异报告 v6 和五书三路对照 v8 完整执行 audit-only 核验，拒绝任意来源/书籍/页码不一致。
2. 只从**同一原图**截取 B15 物理第 109 页下中 R3C2（原图像素横坐标 W/3～2W/3、纵坐标 2H/3～H）；另保留 B03 物理第 67 页的完整原始渲染 PNG。只用本地已装 Pillow；无新模型、无云端 API、无下载。
3. 在私有目录 `D:\ai-cognitive-pdf-benchmark-data\semantic_gate\multibook_matrix_20261023\blind_source_review_v9\` 创建两张私有 PNG 和两份**空白、未审核**状态表。图像原始内容、精确坐标、文件完整路径、原始 PDF/PNG 哈希都只在本地，不能进入公开 GitHub、PR、CI 输出或 Artifact。
4. 两份表均固定 `SOURCE_ONLY_BLIND_UNREVIEWED`、`independent_review_performed=false`、`reviewer_approval=null`、`independent_transcript=null`、`cer=null`，**绝不预填三套 OCR 候选结果，不允许自动盖“独立审核通过”**。
5. 私有总报告 `b15_b03_source_blind_review_packet.v9.private.json` 首次 O_EXCL 创建，记录源图、裁剪图和冻结空白表的 SHA。再次运行只能 `--audit-only` 重算和核验，禁止替换历史基准、改变 OCR 结果或覆盖来源图片。部分写入/损坏 fail-closed，不能直接重试覆盖。
6. 独立 owner-only Windows workflow **必须以准确 HEAD 的 synthetic + 私有 PNG 真机创建和 audit-only 成功**才可称“盲审包创建成功”。工作流绿色也**不意味着已经查看原图、完成审核或产生 CER**。所有 public logs 只能输出 created/verified、source-image=2、reference=0、CER=UNVERIFIED。

## 后续原书内容裁决严格流程

- 先由独立审阅者只看上述**原图**，在与冻结包分离的私有工作目录中记录 B15 ROI 内可见文字、图表/图片标签、阅读顺序、不能确定的区域；B03 则以整页为范围。不能提前展示机器候选或直接接受模型共识为原文。
- 完成原图盲转录后，可再单独打开三路 OCR 候选进行差异核对，记录审核依据和裁决。审阅者无论是真人还是被授权的视觉模型，都必须保留“独立验证是否真实发生”的可审查证据，机器自身声明不能取代外部审核。
- **B15 ROI 是局部裁剪**：不得把 ROI 参考文本直接送入既有五书“整页 CER”门禁，并与三套整页 OCR 文本计算 CER。只有来源对应的同一 ROI OCR 输出、范围边界、真实转录都一致才可报告 ROI CER；否则只可记录疑点。B03 全页参考仍需经独立来源及 `ebook_fivebook_reference_gate.py` 正式准入。
- 既有独立来源参考门禁会检查 SHA/声明形状，但“审核真的发生过”不是密码学可凭机器自动证明的事实；因此在真实独立审核记录存在前，项目统一保持 `INDEPENDENT_REFERENCE_NOT_PROVIDED`、`ACCURACY_UNVERIFIED`、`ARCHITECTURE_NOT_FROZEN`。
- #154 播客任务并发风险单独保持 OPEN。所有 PR Draft/Open/Unmerged，未经用户授权不合并。

## 验收条件

新五项 source-only 保护测试 + 上游 61 项合成回归；真实 Windows 源图裁剪/空白表 O_EXCL 冻结和 audit-only，完整主 CI。真实审核、CER 与最终 PDF 主/备解析器选型是**后续独立任务**，不能以本 PR 自动通过代替。
