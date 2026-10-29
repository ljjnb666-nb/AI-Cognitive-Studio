# STEP6-2A — 执行准入预判与 OCR 质量风险信号（2026-10-29）

## 准入范围
- 本切片是纯函数、类型和单测，不涉及生产 Worker、数据库 schema、MinerU 4.0.3 执行器、默认 flash、自动发布或常驻服务器。
- 分支堆叠在 Draft PR #213（STEP6-1）上；#213 未合并前，此 PR 不得直接合并 main。
- 已有 `OCR_TIER_STANDARD_EXPERIMENTAL_ENABLED` 与新的 `OCR_TIER_STANDARD_EXECUTION_ADMISSION_ENABLED` 必须均为字面值 true，且 `parseStep62aConfig` 会拒绝半开启与非法值。**这两个开关目前没有接入生产环境，不构成正式启用。**
- 仅在可信上游页面检测给出“无原生文本+有图像且无向量/注释歧义”、页面身份相符、来源与像素 SHA256 信息及验证声明有效、像素预算和 host 容量快照满足时，返回 `ELIGIBLE_FOR_RUNTIME_RECHECK`。它不是执行授权；`executionAuthorized` 永远为 false。
- 内存阈值 2.5 GiB、像素阈值 12MP 是保守**实验预检常数**，非生产资源证明；未来执行端须重新核验实际内存、独占 host lease、claim fencing、原书完整 SHA256、模型清单、限时和权限。当前纯函数不能验证声明的真实性。
- `assessOcrCandidateQuality` 保守拒绝空白/控制字符/超长输出；轴标签数字行泄漏与 `![Chart block]` 仅触发复核。普通非空文本仍是 `CANDIDATE_ONLY`，`publicationAuthorized` 永远为 false。文本 marker 可以由 OCR 伪造，不能作为正确结构证据。
- 标记/数字启发式源自 B15 真实样本观察，但仍可能误报漏报；人工 Gold、正式 CER、结构学验证均未通过。

## 下一切片（不在本 PR 内）
1. 设计可信的来源和像素 attestation 提供方，绑定唯一 source/run/physicalPageIndex 与模型 manifest SHA；审计记录不能由未授权调用者自行声明。
2. 定义严格的执行预算和 per-claim 去重/权限门禁；支持 standard 之前先通过准确 HEAD 的真实 PostgreSQL、MinIO、模型验证与端到端测试。
3. 在不改 per-claim 服务器生命周期的前提下，谨慎将标准 tier 和 fallback 接线，保持原 production flash 默认与失败状态不变量。
4. 做 B03/B15/B16 实机验证、冷启动与热态资源采样；不能把 benchmark 的 MinerU 常驻服务测量直接外推到 production per-claim 架构。

## 验收证据
- 源码与 24 项新单测见 `packages/ingestion/src/ocr-step6-2a.ts`、`packages/ingestion/tests/ocr-step6-2a.test.ts`。
- CI 必须按本 PR 最新 HEAD 检查；提交/测试编写本身不表示测试已通过。
- GitHub PR 保持 Draft，不自动合并或生产启用。
