# PDF 原始页面视觉资源的不可变存储基础（VF02）

## 目标：为图文完整性建真正的资源保留能力，而非继续只统计 OCR 字符

已验收的 VF01（#175）证明：生产 PDF.js 能从图文混排页面提取有效正文并直接发布 PARAGRAPH，但原书图像不一定转成 IMAGE Block；OCR checkpoint 只持久化 .txt，不含像素信息。

VF02 是**可选、未启用到生产管线的最小存储基础**：由后续受信任的 PDF 页面渲染器提供真实 PNG 与不可变 PDF 来源上下文，再用租户隔离、内容寻址和条件写入保存；与当前 Book Ingestion 的页面级 text-first 路由并行，绝不改变原有解析和发布结果。

## 本 PR 的完成能力

- `packages/storage/src/index.ts` 为 S3CompatibleStorageProvider 新增 `putObjectIfAbsent`，由服务端原子 `PutObject IfNoneMatch="*"` 决定首次写入。只有 HTTP 412 才返回 ALREADY_EXISTS；HTTP 409/权限/网络错误作为真实失败而不是伪装成“已存在”，禁止 HEAD+PUT 竞态。
- `packages/ingestion/src/pdf-source-visual-assets.ts` 新增 `planPdfSourcePageVisual`、`persistPdfSourcePageVisual`、`auditPdfSourcePageVisual`。来源标识绑定 workspaceId / sourceDocumentId / PDF SHA / 0-based 物理页序号 / PNG SHA。所有对象位于私有 `workspaces/.../pdf-visuals/...` 名字空间，拒绝路径穿越和不合法 ID。
- 新的图像只允许体积受限的 PNG，逐个校验 PNG chunk CRC、IHDR dimensions、压缩数据大小、解压后长度与行滤波器取值；避免将假 PNG 或压缩炸弹送入后续分析。
- 创建或重复调用都执行读回验收：既存内容的 SHA/长度/MIME 必须和预期一致，出现不一致拒绝；重放另行只读复核，不对已有对象覆盖或产生新的 OCR。
- 单测覆盖同源重放、故意破坏对象、六路重复执行、不同租户／书籍／页／PDF 内容寻址隔离、错误路径／非法图片、伪造 authority flags、错误信息不泄漏源 ID。真实 MinIO 集成测试验证 HTTP 条件写在服务器上的语义，而不仅是 Fake Storage。
- `sourcePdfToPageImageVerified=false`、`imageToTextAnchorsVerified=false`、`figureSemanticsVerified=false`、`independentImageGoldAvailable=false` 均不能被存储层擅自标记为 true。**图片存进 MinIO 不等于已经证明图片确实来自指定 PDF**，更不是图表语义验收。

## 刻意不做

这份 PR **不自动渲染现有全部 PDF 页、不迁移历史数据、不修改数据库 schema、不新增生产 Side Effect、不可自动加入解析返回状态、不能直接触发下游播客分析**。正式接线需要后续独立确认可信来源渲染、二次 PDF SHA 对账、page anchors、容量并发调度、幂等/lease、回滚与旧任务重放、一致性 outbox。

不要把本 PR 的通过写成“所有书籍图片已完整保留”。#161 仍 OPEN，B03 全页 CER 和 B15 图例曲线仍未有完整独立金标准；OCR engine 主备架构 NOT_FROZEN。

未经用户授权不合并。本 PR 基于 #175，Draft/Open/Unmerged，生产系统不变。
