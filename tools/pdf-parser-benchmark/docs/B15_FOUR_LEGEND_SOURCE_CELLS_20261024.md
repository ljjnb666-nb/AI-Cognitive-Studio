# B15 图 1-4-16｜四个原始图例像素单元（v7，未核准）

## 起点

#172 的 v6 私有图集、原图、来源 SHA 和 19 条 OCR 四点框已经完成 Windows + 主 CI 工程验收；#171 实测所有 19 条文字候选主要落在同一候选 ROI 内。纯文字框重叠无法区分图例的实心圆、空心圆、实心三角与空心三角，也无法证明曲线归属。

本切片从 **MinerU Markdown 中已经固定 SHA 的第二张 JPEG 图像** 回到真实像素，不再依赖 OCR 文字猜图标。对嵌入图底部检测较长的水平边框候选，并把该候选区域按 2×2 布局切为四组原始像素切片。四格按照页面顺序记作 CELL 1–4，**不自动填写任何名称、符号类别、曲线对应关系或 gold**。

## 严格来源校验

- 先用原书 PNG、Markdown、v1/v3/v4/v5 重算 v6 JSON/PNG/HTML；v6 冻结内容必须字节一致，全部来源 SHA 不得变化。
- 原始 MinerU JPEG 只能从 source-proof 中提取，要求固定 book B15、物理页 109、图 1-4-16 和源图 SHA；不可替换人工生成的图像去冒充原图。
- 检测长边框时仅使用下部原始灰度像素；缺乏足够清晰的长线、边框比例异常、裁片不足四格、低质量输入直接 **REJECTED**，不进行自动兜底猜测。
- 原图候选边框、四格像素和完整哈希全部保存在 D: 私有 v7 JSON 和 PNG，不写进公共 GitHub/CI 日志和 Artifact。
- v7 使用 O_EXCL 首创，任何第二次操作只能 audit-only 校验重算字节，不覆盖 v1–v6 或以前已冻结的 v7；原始私有输入必须保持 SHA 不变。
- 模型和云调用均为 0，所有更改只在 Bench 工具内，不触动生产解析流水线。

## 必须保留的状态

- `figure_frame_independently_verified=false`
- `marker_shape_verified=false`
- `label_to_marker_verified=false`
- `series_to_curve_correspondence_verified=false`
- `independent_gold_available=false`，`cer=null`

本切片是“可供独立视觉核对的四格候选来源像素”，不是完成独立视觉核对本身。先前由 ChatGPT 直接查看用户上传原图得到的四对名称与符号存在局部视觉依据，但个人文件库中的图像目前未能以原始字节 materialize 并与 D: 冻结 JPEG 做完整哈希对账；因此**不能暗中将此前的视觉结论写入经 SHA 认证的 v7 gold**。

后续需要将原像素四格与已记录的四组视觉参考逐一对照，确认实心/空心和文字；之后还要独立检查具体曲线或数据点与图例的关系。Issue #161 保持 OPEN、架构 NOT_FROZEN，所有 PR Draft/Open/Unmerged。
