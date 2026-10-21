# 03E-04B-02C｜标准 GLM 结果的安全接收与多区域待审总览

**日期：2026-10-21。范围：离线文件来源校验、仅本机状态读取、未批准的注册候选。不包括付费模型请求和最终 GT 认证。**

## 交付内容

1. 修正 `annotation/graph-result-registry.mjs`：此前严格校验器仅接受 `glm-cloud-v1-<book>-<region>-<suffix>/cloud-vision-proposals.json`，而现有生产 Python `cloud_glm_vision.py` **首次单区域调用**实际写入 `glm-cloud-v1-<book>-<region>/cloud-vision-proposals.json`，并将尝试标记为 `INITIAL_ATTEMPT`。现在既支持精确标准首次调用格式，也保留此前用于合成隔离测试的后缀形式。标准形式只接受 `INITIAL_ATTEMPT`。无论哪种路径，最终必须同时登记真实 result/manifest/crop 的三个 SHA-256、书籍、物理页及模型尝试类别，不因为存在目录就给予审核权限。
2. `inspectCanonicalGraphResultForRegistration(root,itemId)`：仅允许规范 `RB-PDF-12/13:page-NNN-region-NN`、且禁止 P127 旧结果改走新路径。使用既有带无符号链接、文件大小、mtime/inode 检查的安全读取器读取固定结果、固定 Manifest、裁剪 PNG 与生产 `.cloud-attempted` 请求预留回执。对整个 JSON 按现有 `validateRegionGraphCandidate` 校验模型、单区域结果数量、未人工认证、节点/箭头以及坐标来源，生成 `REGISTRATION_CANDIDATE_NOT_APPROVED`。不会向登记表或私有审核目录写入文件，不自动推理、不发布。
3. `annotation/graph-result-intake-queue.mjs` + 本机 `GET /api/private-graph/intake/overview`：按既有可信 Manifest 清单，只读分类每个区域：`REGISTERED_PENDING_HUMAN_REVIEW`、`WAITING_FOR_EXPLICIT_PAID_AUTHORIZATION`、`PRIOR_ATTEMPT_UNCERTAIN_NO_REPLAY`、`MODEL_RESULT_BLOCKED_MANUAL_INVESTIGATION` 或 `SOURCE_VERIFIED_REGISTRATION_NOT_APPROVED`。接口受原有回环地址、Token、Origin/Fetch-Site 保护，仅允许 GET、无 query，不提供私有图像/模型文字/原始路径/结果 SHA/任何授权功能。
4. 正式生产登记仍只包含 P127 既有独立审核路径。对未来新的真实结果，仅在来源审核、候选签名/登记策略完善后才能进入通用人工审核，**不准直接作为已验证知识发布**。最终目标是由可信本地工作流自动产生可审计登记，用户只做最后语义审核；本切片尚未实现这种无需代码登记的自动放行。

## 失败、回归与限制

- 首次标准输出单测发现构造的“篡改 PNG”实际将零字节写成零，测试误以为已经改变，已改成 XOR，确保真实发生 SHA 不匹配。首次失败 CI 保留：[39593986917](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39593986917)。
- 接收总览首次测试将“输出目录仍存在但内部 JSON 丢失”错误地预期为“仅历史回执”，实际系统安全地标记 `MODEL_RESULT_BLOCKED_MANUAL_INVESTIGATION`。现已把“目录残留”和“只有回执”分成独立断言，保留原失败：[39594629824](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39594629824)。
- 新测试保证：Python 标准路径可提取候选但不会直接自动注册，P127 旧版不迁移；伪造模型尝试、篡改裁剪 SHA、遗漏请求回执全部拒绝；无凭据及试图通过 POST 授权的访问被拒绝；输出残留/不确定账务均不会变成自动重发资格。
- 仍有相互独立的阻断：GLM 账户实际计价与图片 token 最大上界未核实，真实付费授权与计费执行器未实现，剩余 14 个区域没有图关系候选，最终人工语义审核未进行。此前播客集成测试曾出现 `A2_PODCAST_CLAIM_DID_NOT_REACH_PROVIDER_RESOLVER`；其后 PR HEAD 的 6/6 主 CI 通过，但没有根因修复证据，仍须作为潜在 flaky/并发缺口跟踪。
- 当前完整主 CI、专项以及真实 Windows 独立回归，需以**各自准确 HEAD 和最终 conclusion**为准；不许将旧 SHA 成功冒充新 SHA 验收。

**PR #100 维持 Draft / Open / Unmerged；未收到新的付费 GLM 或 PR 合并授权，本切片 providerRequestsIssued=0。**
