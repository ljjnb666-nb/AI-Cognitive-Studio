# PDF v1 视觉链：真实 PostgreSQL + MinIO + Gateway 加密回执验收

日期：2026-10-28。状态：**Draft / synthetic-only / production OFF**。

## 为什么新增这项验证

上游 #203、#204 已验证本地合成 PDF 的 PDF.js 图结构和 Worker 并发资源生命周期，但 #203 的 Gateway 是 mock，不能据此声称真正持久化了视觉调用回执。此次补上真实存储与真实 SQL 持久化一环，不调用真实外部 AI，也不使用用户私有电子书。

## 硬件 / 测试数据边界

- PostgreSQL 17 + 真实 Prisma 迁移，不是 sqlite / 内存 mock。
- MinIO 使用 Docker 服务和真实 S3 get/head/put；原书是测试现场使用 PDFKit 生成的两页无版权 PDF（第一页文字+示意图，第二页纯文本）。
- 真实 `ProviderGatewayRepository` 创建测试用户、工作区、受控 zhipu 连接与 `PDF_VISUAL_STRUCTURE` 路由；`createBookProductionGatewayRuntime` 用真实 PostgreSQL 持久化 invocation / 加密 text receipt / usage 统计。
- 唯一模拟部分是 Gateway provider adapter 的视觉响应；测试凭证从不发往网络，`adapterResolver` 只返回确定性结构化图。
- `executeOnDemandPdfVisualReview` 通过真实 S3 流读取原书并校验 SHA256、路由重放；完成候选结构解析、独立 gateway 计费/权限路径。
- 二次相同调用检查相同 `idempotencyKey` 不重复执行 mock provider，历史结果必须可恢复；修改 S3 对象后再次调用须被原书大小或 SHA 校验拒绝，不能继续调用模型。
- 回执仅是加密、未消费的短期 Gateway 结果，**不是**已审核的图表事实；不提交原书正文或像素，不写成播客数据。
- 每次测试用随机工作区与 MinIO key，销毁测试用 S3 对象和 DB 关联记录。

## 验收定义

专用 GitHub workflow `.github/workflows/pdf-visual-durable-receipt-proof.yml` 必须：
1. 检查精确 HEAD，不可使用相邻 PR 旧 CI 结果。
2. 在真实 PostgreSQL17 + MinIO 上应用迁移，运行 `pdf-visual-durable-receipt.integration.test.ts`。
3. 断言 provider 加密结果、幂等、原书防篡改和纯文本页不调用视觉模型。
4. 同次通过 Worker typecheck、ESLint；主 CI 也要全部 SUCCESS。任何 SKIPPED、安装超时、flaky 都不能当作通过。
5. 不增加 ffmpeg / apt 依赖；专项只验证 PDF + SQL + object-store + adapter mock 的限定范围。

## 未通过的门槛

真实云端 GLM 质量、取消/超时 no-commit fence、人工核验 UI、五书 Gold 0/5、CER=null、图候选生产持久化及发布授权均仍未完成。生产 Docling 保持 OFF。所有相关 PR 继续 Draft、未经授权不得合并。
