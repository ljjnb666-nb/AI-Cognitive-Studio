# 第一阶段｜五本 PDF 同源原页离线盲审包（v11）

## 解决现存的具体缺口

既有盲审 v9/v10 只支持 B03 p67 整页、B15 p109 下中局部；其余三本 B08、B29、B31 的原始页虽然在已完成的同源 Benchmark 中存在，但缺少能直接逐页核对的统一私有原图审核入口。正式参考金标准当前为 **0/5**。

本 PR 新增一份独立的**五页来源盲审工作台**。它复用已经冻结的六 PDF / 24 native pages / 五 OCR-focus PNG 和原始来源 receipt；在 D: **直接保存五份真实来源 PNG 的不可变副本**，而不是生成 OCR 文字或伪造独立参考。

| 书 | PDF 物理页 | 页面范围 |
|---|---:|---|
| B03 | 67 | 整页 |
| B08 | 64 | 整页 |
| B15 | 109 | 整页，非原 v9 的局部 |
| B29 | 72 | 整页 |
| B31 | 126 | 整页 |

## 真正的私有交付

私有目录为 `D:\ai-cognitive-pdf-benchmark-data\semantic_gate\multibook_matrix_20261023\fivebook_blind_original_pages_v11`。

包含 5 个源 PNG、5 个带原 PDF/页 PNG SHA 且保持未批准的空白审核 JSON、一个离线中文 HTML、一个来源核对总回执，合计 **12 个文件**。本地 Edge 打开 `五书原图独立核对.private.html` 可以切换书/物理页、放大原图、填写不同来源区域的独立视觉转录及未决字符，导出 **DRAFT_UNVERIFIED** JSON 草稿。

**不是**在 GitHub 或 ChatGPT 中上传这些图片。没有 OCR 结果、云模型、伪 gold、CER；浏览器禁用所有网络连接，任何文字只有操作者明确输入后才存在于浏览器本地下载。

## 来源证明和不可变性

- `audit_existing` 先检查上游六本 PDF 文档的总来源与 24 页证据、5 个 OCR-focus 图片回执，并逐张核验 PNG SHA、实际像素格式/尺寸、PDF ID 和物理页。
- 五页来源 SHA 必须与 `ebook-20261022.manifest.json` 及真实 native receipt 所标的书籍来源一致。任何一本发生变化，全部拒绝。
- v11 名称固定，O_EXCL 首次写入，后续只能 audit-only 逐字节对照。既存半套输出拒绝覆盖；不修改 v1–v10 或上游五页。
- GitHub 只提交脚本、八项纯合成单测、中文方案及 owner-only Windows 精确 SHA 工作流。原始五页图片/转录文字/图内位置/完整私有哈希不得进入 PR、日志和 Artifact。
- 工作流只允许输出固定匿名消息和数字 5、0，并在运行前后比较全部 5 张原图以及原 native 回执 SHA。
- 没有任何接口可以自动批准审核。空白表中的 `reviewer_approval=null`、`independent_gold_available=false`、`cer=null` 永久不由脚本改为已完成。

## 与三阶段架构选型的关系

Stage 1 的剩余实质工作是**实际按图校对全部可见文本**、解决未决字词、独立记录完整覆盖与审核人/来源证据、核对相同范围的 OCR。v11 把五书图片统一送进可访问的私有离线核对入口；**CI 通过不代表人工/视觉核对发生**。

Stage 2 在独立原图参考真正批准后，才能比较原生解析、RapidOCR、MinerU、Docling、图表结构、时间与成本；Stage 3 冻结 v1 OCR 架构。

用户先前授权 ChatGPT 直接核对 B03/B15 的个人 Library 源图，但该 Library 图像的原始字节无法通过当前文件接口复制到容器验证与 Windows 源图是否字节相同。请勿把该限制隐瞒成已认证 SHA。B03 私有 v3 视觉草稿和 B15 四格结构初审继续保留 NOT_APPROVED。

#161 OPEN、所有相关 PR Draft/Open/Unmerged，未经用户明确授权不合并。
