# PDF-FIGURE-STRUCTURE-03E-02｜已有裁剪图片的一站式按需预览

**2026-10-21**。实施于 Draft PR #100，仍 **未合并**。此前 03E-01 已能自动发现原书 RB-PDF-12/13 的 15 个私有图像区域（其中 1 个 P127 具有 GLM 图关系，其余 14 个仅有裁剪证据）。本阶段补足**同一审核页内逐项查看已有图像**的能力，目标是你最后只需要核查已有材料，而不是反复导入 JSON/PNG。

## 一、使用方式

在 Windows 私有 Benchmark 工作区**确认已安全同步本切片**后，运行：

```powershell
cd "D:\所有项目\90_Worktrees\AI-Cognitive-Studio-pdf-parser-benchmark\tools\pdf-parser-benchmark"
node scripts/serve_gt_annotation.mjs --auto-import-p127
```

在本机 Edge 打开终端输出的 `ACS_P127_GRAPH_REVIEW_LOCAL_URL` **完整地址**（带临时 URL fragment 凭据；不要分享）。页面自动生成“已有证据发现队列”。对于来源/裁剪 SHA 校验有效的所有条目，点击 **“查看局部图片”**，即可在队列下方预览当前选中区域，不必挑选私人文件。预览不要求再次调用 OCR 或 GLM。

有真实图关系的 **RB-PDF-13 原书物理 P127** 仍可点击 **“进入 P127 人工审核”**，人工对照 9 个节点、10 条候选关系并保存未认证草稿。剩余 14 个区域只提供图片预览，不会虚构图关系、箭头或可靠性分数，也不会变成正式 GT。

## 二、读盘、来源与浏览器边界

- 新增 `GET /api/private-graph/crop?item=<fixtureId:regionId>`，沿用原来的本机 127.0.0.1 Host/Origin/Fetch-Site 与会话 token 检查。只接收 `RB-PDF-(12|13):page-NNN-region-NN` 的**唯一、严格编码** item 查询；拒绝任意路径、重复参数、跨站、非 GET 和未授权请求。默认纯静态模式仍关闭该 API。
- 后端 `readPrivateGraphCropPreview()` **仅按固定文件夹和受控 Manifest 选择一个区域**；重新校验 Manifest schema、源书身份、subset 与 region 序号、物理页、区域 bbox、SHA、PNG IHDR/像素大小，拒绝 symlink、超限、截断和来源不一致。绝不通过 HTTP 暴露自由路径查询、磁盘列表或原书 PDF。
- 浏览器的 `graph-crop-preview.mjs` 对这张图片的**原始二进制字节重新计算 SHA-256**；实际 `createImageBitmap` 解码并核对宽高；只将验证后的图像绘制在临时 canvas 中。切换所选区域、刷新队列后旧请求不可覆盖新选择。
- 只预览一张，避免一次性把所有原书图片加载入浏览器内存。页面节点、标签、日志、模型回答、图片或审阅草稿均不允许上传 GitHub；不调用 GLM，不创建、批准或自动提交人工 GT。HTTP 响应中保留 `CROP_ONLY_UNVERIFIED` 和 `graphVerified:false`。
- 现有 P127 的专用 GLM 图关系验收仍独立于裁剪图片预览。看得到图片并不代表图中的关系已识别正确。默认模式下未经人工确认的内容不能进入播客正式知识输出。

## 三、合成与 Windows Edge 验收证据

- [PDF 专项 CI #39562145830](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39562145830)：合成门禁 SUCCESS（Python 50/50；JavaScript 61/61）。新增 5 个负向测试覆盖 SHA 替换、PNG 非法、跨站无 token、穿越路径、重复 URL 参数、审阅草稿不被预览更改。
- [真实 Windows Edge 合成流程 #39562283442](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39562283442)：SUCCESS；合成裁剪图浏览器 SHA 检查、队列显示、原本的自动保存/刷新恢复回归通过。
- [真实 P127 Edge 私有只读样例 #39562294469](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39562294469)：SUCCESS；从 14 个只有裁剪的区域中选择一个，真实图片显示、SHA 验证通过，用户私人草稿不变。
- **批量覆盖验收** [#39562553594](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39562553594)：SUCCESS；实际 Windows Edge 在同一个只读页面顺序点开全部 **15/15 张**经发现的真实私人裁剪图片，全部通过服务器和浏览器校验、PNG 解码、canvas 显示；最后 `graphVerified=false`，真实 P127 人工草稿 SHA/不存在状态不变。只记录脱敏成功数量，没有录屏、截图或发布图像。
- 本轮 Edge 程序化验收**不等于人类准确性复核**；生产可信状态继续为 UNVERIFIED。综合主 CI 最终应以最新准确代码 HEAD 的 6/6 作业结论为准，后续推送可能将旧运行取消，不得把 cancel 当成功。

## 四、尚未完成

- 目前只对 **已有 15 个裁剪区域**完成自动发现与按需预览；其他没有云端图关系的 14 个区域无法直接做箭头/节点关系的“最终审核”。将其视为仅图像原始证据，而非完成的图理解任务。
- 多页**统一图关系提案契约和每区域审核状态机**、跨书草稿独立保存、争议裁决/审核者签名，以及其他 14 张图的推理费用授权仍是后续切片；未经新授权不自动触发付费 GLM。
- 仅在本机实际安全同步且 Edge 打开有临时 token 的私有服务时支持此功能；不能从 GitHub Actions 通过推断用户 Windows Worktree 已被更新。本地路径不一定与此前文档完全一致，应检查实际目录。
