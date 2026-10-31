# PDF 混合页图结构闭环（2026-10-31）

## 技术基线与复用
在 #225 HEAD `14e45031d78eb19eb38de8e82f7ee84ab2d812fe` 上选择性回收旧 Draft #201/#203。主干已包含 #202 的 Provider Gateway PDF_VISUAL_STRUCTURE 路由、GLM-4.6v 模型声明、授权、预算、图片验证和加密回执，所以**不再移植旧版供应商直连代码，也不重复修改 Gateway**。

## 交付能力
- `inspectPdfMixedPageVisualStructure`：显式启用 PDF.js 真源页 PNG → 外部注入的结构模型 → 完整来源/页/PNG SHA/图节点与方向验证。严格检查 JSON 结构，假 Gold、额外字段、越界位置、悬空边 fail closed；失败返回 `REVIEW_REQUIRED`，不编造成功。
- `executeOnDemandPdfVisualReview`：先鉴权工作区，核实 run SUCCEEDED / 原书 PDF SHA / MIME / 存储元数据 / 字节流 / 完整路线重放，然后仅调用现有经授权 Provider Gateway；显式用户同意图像外发 `allowExternalVisualModel:true`；至多两页。
- `createOnDemandPdfVisualWorkerRuntime` 仅是显式创建 API，**不注册生产队列或自动触发模型、没有外部真实调用**。资源按需关闭。
- 使用无版权合成 PDF+真实 PDF.js 像素、模拟 Gateway 检验完整链路，并验证跨租户、来源篡改、错误页/路由与未经同意的情况在付费前拒绝。

## 范围外
图结构始终 `UNVERIFIED_VISUAL_CANDIDATE`，未写 canonical SourceBlock、Book Intelligence 或播客内容；尚未接入用户界面授权、图候选持久化、用户审核/撤销、Gold/CER、实际私有书页端到端。保持 Docling 默认关闭。#225 与本 PR 为堆叠 Draft；**需要准确 HEAD 的 6 项 CI、types、lint、unit、真实 PNG+Worker 模拟模型验证；未经用户新授权不合并、无部署、无付费调用**。
