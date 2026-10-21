# PDF-FIGURE-STRUCTURE-03B-CLOUD：GLM 云端视觉优先（先做云端，后做本地）

## 决策与范围

2026-10-21 用户明确同意：优先使用 GLM 云端视觉模型提取图形结构，待云端准确率和结果验收完成后再完善本地视觉模型。

**本阶段云端传输范围有变化**：得到用户授权后，可将经过源 PDF、Markdown、完整页 PNG 与裁剪图 SHA 核验的**选定局部 PNG** 发送给智谱模型 API。裁剪图可能包含原书的文字及图片；智谱是外部服务提供商。**不会**发送整本 PDF、完整 OCR Markdown、全书全部页面、GitHub artifacts；不会把云端模型输出发布在 GitHub Actions 日志。请确认书籍内容拥有适当处理权限。

以前“私有书籍绝不出本机”仅适用于离线阶段；此云端选项仅在 **显式 `--allow-cloud-upload`** 且提供 API Key 时执行，默认仍不调用云端。

## 正式模型、端点和认证

官方文档核验：

- 模型默认 `glm-5.3-flash`，官方描述其支持多模态图片和 Base64 Data URL。也允许选择 `glm-5.3-flashx` 或 `glm-4.6v-flash`，均以账户权限和服务实际返回为准。
- 标准模型 API 采用固定端点 `https://open.bigmodel.cn/api/paas/v4/chat/completions`、`Authorization: Bearer ...`。
- 智谱自 **2026-10-16** 起将新建标准 API Key 与 Coding Plan Key 分开管理。**本脚本固定为标准 API 端点**，使用标准 API Key，按标准 API 规则计费。不能假定 Coding Plan 套餐 Key 在该端点通用或免费。
- API Key 只从执行主机的环境变量 `ZHIPU_API_KEY` 读取；**禁止粘贴在对话、GitHub Issues、PR、仓库文件、Actions 日志或模型提示词中**。在 GitHub Runner 使用时，通过该仓库 Settings → Secrets and variables → Actions 新建 Repository Secret `ZHIPU_API_KEY`；只在受信任工作流显式引用该 secret，不在普通 PR workflow 中提供。
- 模型可用性、图片限制、配额和账单以实际服务响应和账号为准；本地单测不等于 GLM 真的接受了图片。

参考：https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash 、
https://docs.bigmodel.cn/cn/guide/develop/http/introduction 、
https://docs.bigmodel.cn/cn/coding-plan/notice/api-key-management

## 本阶段代码

`python/cloud_glm_vision.py`（新）：

1. 使用上一阶段 `local_vision_proposals.verify_regions` 与 `vision_graph_proposal_contract.validate_candidate`，强制核验选中的裁剪 PNG 是源完整页正确像素范围，且与原书的物理页、SHA 绑定。
2. 仅向固定 HTTPS 智谱域名请求，**不接受任意 API URL、不走 HTTP 代理、不跟随重定向**，请求大小、响应大小、超时和模型名单有限制；不主动下载模型。
3. 单次请求默认仅 1 张（硬上限 3 张）；不自动重试、不自动跑满 15 张。在真实 GLM 成功返回并通过首张审计前，不应扩大批次。
4. 采用与现有本地 03B 相同的节点与箭头 JSON 契约。模型只能建议 `nodes/edges`，每条边必须给出节点 ID、箭头尖端和线段的局部像素坐标；凡是缺证据、坐标越界、伪造审核结果或输出非 JSON 的一律拒绝。
5. 输出仅写入 D 盘对应 run 的独立 `glm-cloud-v1-...` 目录，并保留 `PROPOSED_UNVERIFIED / NOT_REVIEWED`。不声称已确认方向、因果或时序，也不自动进入播客文本生成。
6. 云端尝试前原子创建持久的 `.cloud-attempted` 标记。API 失败时不自动重发，避免重复付费和重复发送页面；需要复核上一次发送/扣费状态后，再明确批准新的一次请求。
7. 不修改原生 MinerU、正式数据导入或旧测试结果。此前 LM Studio 本地方案保留，未来可实现同一结构契约下的后端切换。

## 预期的第一轮真实测试

在 Windows Runner 上使用经过审查的准确 Git Blob SHA 的脚本及依赖，读取 `D:\ai-cognitive-pdf-benchmark-data\reports\real-mineru-39440805765-1` 下对应私人区域。

**密钥配置完毕后才允许调用**，第一轮只发**一张**选定的局部裁剪图，使用模型 `glm-5.3-flash`，观察是否支持图像输入、是否给出严格 JSON、是否通过关系坐标门禁。只有返回可信的来源坐标与人工复核后，再逐步扩至 P51/P127/P379 和 P261。当前 15 个区域的内容质量尚未人工 GT 验收。

命令示例（请勿把密钥写在命令行）：

    python cloud_glm_vision.py --fixture RB-PDF-13 --model glm-5.3-flash --region-id page-002-region-01 --max-regions 1 --allow-cloud-upload

该示例会把一张包含书页内容的裁剪 PNG 上传到智谱。**仅应在确保密钥配置、了解云端传输和计费后运行。**

## 通过/不通过口径

- `GLM_CLOUD_PROPOSALS_SAVED_UNREVIEWED`：云端返回了格式与来源符合约束的节点/箭头**候选**；不代表内容语义准确。
- 正文 OCR CER、图形节点与箭头方向准确率：仍未测量。不能凭候选数量声称理解成功。
- 主流程（PDF 导入 → 章节理解 → 自然播客）不从该实验性路径直接读取未经人工复核的关系。

保持 Draft PR；不合并，不上传私人书页到代码仓库。
