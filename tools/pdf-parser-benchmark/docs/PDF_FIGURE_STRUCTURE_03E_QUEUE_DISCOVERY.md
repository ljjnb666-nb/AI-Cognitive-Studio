# PDF-FIGURE-STRUCTURE-03E-01：已有私有图像证据自动发现与审核队列

**状态**：Draft PR #100 内增量开发；不合并，不产生新的 GLM/OCR 请求，不把已识别节点或边晋级 GT。

## 一、切片目标

打开此前 P127 自动导入页面，先看到可审核与尚不能审核的**证据队列**，不再手动寻找已有图片和 Manifest。03E-01 是**已有证据发现**而非云端识别调度系统。

在显式启动 `node scripts/serve_gt_annotation.mjs --auto-import-p127` 后，前端调用已受原 256-bit 会话 token、Host/Origin/Fetch-Site 和本机回环地址限制的 `GET /api/private-graph/queue`。服务端仅使用现有受控根 `D:\ai-cognitive-pdf-benchmark-data\reports\real-mineru-39440805765-1`。

## 二、固定可信的发现边界

- 仅检查 `region-proposals-v1-RB-PDF-12/region-proposals.json`、`region-proposals-v1-RB-PDF-13/region-proposals.json`；无任意路径参数，绝不递归扫描整个 D 盘或用户家目录。
- 对每个 Manifest 校验真实 `sourceRun`、书籍 fixture ID、机器未审核标志、物理页、subsetPageIndex、regionId 序列、bbox 和 crop SHA；每书最多 3 页、每页最多 4 个区域，整个队列最多 32 项。
- 仅对 Manifest 内的对应 `crops/<regionId>.png` 读取有界字节，检查 PNG IHDR 尺寸与来源 SHA；读取失败、SHA 不符或缺失会记录**单项阻断**，不影响其他有效区域。
- 前端只接收 ID、书籍 fixture ID、物理页、regionId、三种证据状态及少量数量。**不返回 crop 内容、节点标签、箭头坐标、原始 JSON、目录路径、任何 Key 或原始模型回答**。
- 只允许已通过严格模型结果契约校验的 `RB-PDF-13:page-002-region-01` 进入原有图节点/关系审核页面。目前没有任何根据候选框自动伪造 12/13 其他页的图结果的机制。

## 三、状态（必须中文 UI）

| 内部状态 | 页面含义 | 是否允许终审 |
|---|---|---|
| `GRAPH_READY_FOR_HUMAN_REVIEW` | 图关系已存在，待人工复核 | 是，当前仅 P127 |
| `CROP_READY_NO_GRAPH` | 已有局部图像、无有效图关系候选 | 否 |
| `CROP_MISSING_OR_BLOCKED` | 裁剪缺失、文件异常、SHA 或尺寸不一致 | 否 |
| `GRAPH_EVIDENCE_BLOCKED` | 模型输出或审阅草稿校验失败 | 否 |

队列状态是**发现层**，不代表任何 OCR 成功率、图理解准确率、视觉方向正确性。机器置信度不能自动变为人工认证。P127 详情页仍保存 `REVIEW_DRAFT_UNATTESTED`、`graphVerified=false`。

## 四、验收和剩余工作

- 云端合成专项必须覆盖：跨书 fixture 隔离、来源 SHA 验证、裁剪坏文件的单项隔离、伪造页码及节点拒绝、默认关闭的私有 API、同源 token、禁止队列写入。
- 真正 Windows Runner 私有数据审核只记录状态计数，不打印私人内容或保存新的草稿；**当前既有图结果仅 P127 一项**，不能从合成素材推断其他页已有图关系。
- 后续 03E-02 才能实现多书页选择、逐项预览及统一审阅状态机。还应研究跨服务多进程草稿并发、审批绑定/审计和批量计费授权。本切片不自动点击人工确认按钮。
