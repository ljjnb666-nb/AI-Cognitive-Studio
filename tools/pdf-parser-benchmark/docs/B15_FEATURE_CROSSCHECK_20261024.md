# B15 图 1-4-16 第二视觉证据：ORB/RANSAC 交叉核对（v4）

## 实际任务

沿用 #168 冻结的 B15 物理第 109 页 PNG、MinerU Markdown 第二张嵌入 JPEG、v1 阅读顺序锚点和 v3 像素模板候选。新工具使用 **ORB 特征点 + RANSAC 单应性**，将来自不同算法的定位假设相互比较。

私有 v4 JSON 包含特征点一致性情况、几何候选与模板候选 IoU 等待复查线索；另在 D: 私有目录生成一张原图上的候选矩形叠加 PNG，仅标注 C1-C6 候选序号、可能的 ORB 四边形，不展示伪造的真值或模型声称的图例语义。

## 独立性边界

ORB 与模板匹配算法不同，但**两者仍依赖同一张原书图与同一 MinerU 提取图**，不是两个独立人工来源。ORB 图案特征会受到重复纹理、裁剪、旋转、插值及原图尺寸影响；没有足够稳定的匹配特征时返回 `INSUFFICIENT_INDEPENDENT_FEATURE_EVIDENCE`，不虚构“通过”。

即使得到较高 IoU 和 RANSAC 内点比例，也只是 `GEOMETRY_CANDIDATES_CROSS_METHOD_CONSISTENT_UNVERIFIED`，不是核准的像素配准或图例/曲线文字对应。对照存储的所有权威布尔值仍为 false，`independent_gold_available=false`、`cer=null`。

## 安全与不可变性

- 严格复核 v1/v3 的原书 SHA、图像身份、未核准权威标志及 v3 真实模板候选范围，拒绝伪造参考。
- v4 私有 JSON 与 overlay PNG **成对 O_EXCL 首创、随后 audit-only 字节比较**。如只有一个输出存在，Windows 门禁拒绝，不覆盖任何历史 v1/v2/v3 或原始文件。
- 实机只使用 D: 已装的 Python/Pillow/OpenCV，不下载 OCR 模型、不调用 GLM 或其他付费视觉接口。
- 原图、叠加图片、私有 OCR 字符、坐标、完整 SHA 均不进公共 GitHub、Actions Artifact 或日志。公开只允许合成测试与白名单匿名状态。
- Windows 工作流读取准确 PR HEAD 与既有固定私有证据；若 #168 的 v3 尚不存在，则应明确拒绝而不是重跑或生成假的 v3。

## 仍待完成

此 PR 仅提供 **几何候选的第二算法信号和供离线核查的原图可视化**。下一步仍需真正独立核对图号、四类图例符号、曲线及对应文字标签；将 OCR 坐标系统与原图的数学变换验收后，方能形成权威图表语义评测。Issue #161 保持 OPEN，PDF 引擎路由与 CER 均 NOT_FROZEN / UNVERIFIED。任何 Draft PR 未经用户明确授权不合并。
