# PDF-FIGURE-STRUCTURE-03C｜P127 图关系私有审阅台

**状态**：代码与合成测试阶段；真实人工审阅未完成，不生成图表准确率，不发布知识图谱。

## 目标与证据范围

- 目标固定为原书 **RB-PDF-13 物理 P127** 的 `page-002-region-01`。
- 使用已经由 [GLM 真实运行 39551952707](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39551952707) 完成、并通过 [独立只读核验 39552195333](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39552195333) 的**私有** r02 结果。
- 该次模型提出 **9 节点、10 关系**；这些数字只代表来源/坐标格式合法，绝非视觉准确率。
- 现有 GT 标注台针对正文、表格与 OCR，不能把模型图关系回填为人工 GT；新增 `graph-review.html` 单独承担图形逐条肉眼对照，严格保持非认证草稿状态。

## 运行方式：本机浏览器，无上传

在**已经安全同步的指定 PDF Benchmark 工作区**安装过 npm 依赖之后，可在其 `tools/pdf-parser-benchmark` 目录执行：

```powershell
node scripts/serve_gt_annotation.mjs
```

服务仅绑定 `127.0.0.1` 动态端口，屏幕显示的地址末尾加 `graph-review.html`，例如 `http://127.0.0.1:<本机端口>/graph-review.html`。不要把固定端口当作已知事实；浏览器不能访问外部网络服务。本页通过三个 `<input type=file>` 用户动作读取**本机**文件，服务器不提供 PDF 或私人目录接口。

需手动选择：

1. `D:\ai-cognitive-pdf-benchmark-data\reports\real-mineru-39440805765-1\glm-cloud-v1-RB-PDF-13-page-002-region-01-retry-p127-r02-20261021\cloud-vision-proposals.json`
2. `D:\ai-cognitive-pdf-benchmark-data\reports\real-mineru-39440805765-1\region-proposals-v1-RB-PDF-13\region-proposals.json`
3. `D:\ai-cognitive-pdf-benchmark-data\reports\real-mineru-39440805765-1\region-proposals-v1-RB-PDF-13\crops\page-002-region-01.png`

页面使用浏览器 WebCrypto **重新计算**文件 SHA-256，与模型结果中的 Manifest SHA、区域 crop SHA 和页码映射核对；然后解码 PNG、校验像素宽高，叠加节点框、线段和箭头尖端。

**局限**：这不是从 GitHub 端重新验证原书 SHA 或对纸质原图进行人工独立确认。文件之间的自洽 SHA 校验不等于对抗已经整体替换的伪造证据；可信源仍须追溯此前 Windows 独立核验及私有 Manifest。本 UI 不打开全原书 PDF；审核时可用本地系统阅读器额外检查原书 **物理 P127**。

## 人工审阅流程与状态机

- 初始所有节点/边为 `UNREVIEWED`；从图片看清且实在一致可选 `VISIBLE_MATCH`，明确不符选 `VISIBLE_MISMATCH`，方向模糊、不完整或其他疑问必须选 `UNCERTAIN`。
- 同一图关系同时检查可见连线、箭头尖端、端点和方向。必须拒绝根据 TCP 协议常识填补图中缺失的箭头。
- 备注与选择只在当前浏览器标签页内存更新；点击“导出草稿”会发起本地 JSON 下载请求，请核实文件保存位置。可再次载入**同一来源 SHA** 的草稿继续修改。
- 导出的 JSON 永远标记 `REVIEW_DRAFT_UNATTESTED`、`humanVerified:false`、`graphVerified:false`。对全部条目标记 VISIBLE_MATCH 也不会生成 VERIFIED 或提升生产权威。
- 两位独立人类复核者的正式审核、争议裁决及质量指标属于后续受控门禁；当前阶段不把该草稿用作 Ground Truth，不输出准确率，不进入播客内容。

## 隐私、安全与安全失败口径

- CSP：`connect-src 'none'`，只允许本地同源静态脚本、CSS；无上传、POST、遥测、外部图片请求，节点字符串通过 `textContent` 呈现，不执行模型输出。
- 不自动下载、读取整个 PDF、运行 OCR、复用 GLM API Secret 或重试付费请求。
- 导入文件有确定名称、大小上限、来源、状态、Manifest/crop SHA、坐标合法性与关系端点门禁；重复 ID、越界坐标、错物理页、伪造认证状态、草稿来源切换、畸形 JSON 一律拒绝。
- 不要把含有私人模型标签、审阅备注、图像、原书名称的草稿上传到 GitHub / CI / 聊天中。
- 合成门禁运行 `tests/graph-review.test.mjs`（拒绝伪造节点、箭头和来源、回执不变性及本地服务固定路由），以及 `node --check`。**合成 PASS 不等于真实 Edge 实机人工复核 PASS。**
