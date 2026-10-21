# PDF-FIGURE-STRUCTURE-03E-04B-01｜授权申请草稿与离线持久预留

**日期：2026-10-21 · PR #100（Draft，未合并） · 无新增 GLM/OCR 付费调用**

## 1. 本切片完成的真实功能

上一阶段 03E-04A 已在 Windows 私有 D 盘核验：两本书现有 15 个区域，P127 一项已有严格校验的 GLM 图关系，另外 14 个仅有原图裁剪，符合**离线**模型调用预检条件。用户希望未来能自动完成导入和预处理，仅最终确认图关系，因此必须在计费/并发/失败恢复之前建立不可伪造的授权边界。

本次新增了两个内部模块，不暴露对外执行接口：

1. `annotation/graph-batch-authorization.mjs`：对 03E-04A 的完整 `planSha256` 和不可重复书页来源进行重验；根据**明确指定**的区域 ID、最大次数、拟定货币金额上限（以货币最小单位表示）、币种和到期时间，生成确定性的 `requestSha256`。该数据始终是 `DRAFT_NOT_AUTHORIZED`，`pricingVerification=NOT_VERIFIED`，`dispatchEnabled=false`，`providerRequestsIssued=0`，没有 `approvalReceipt`。伪造 APPROVED、价格已核实或修改任何计划、区域、次数、金额与来源 SHA 都必须失败。公开守卫 `guardBatchDispatch` 当前**始终拒绝执行**。
2. `annotation/graph-batch-offline-ledger.mjs`：仅适用于**合成/未授权离线准备**的持久预留。每区域文件名由完整授权申请 SHA 与规范区域 ID 派生，Windows 文件名不含冒号。采用排他 `O_CREAT | O_EXCL`、文件 `fsync`、固定无符号链接目录检查与只读核验。重复写入同一区域必须拒绝；文件损坏、路径替换、未知区域、变更授权、授权到期亦 fail-closed。崩溃留下的已有标记不能被自动当成“重试许可”。所有状态统一 `OFFLINE_PREPARED_NOT_DISPATCHED`，**并不是已向云端发出请求的计费回执**。

**重要边界：拟定 maxSpendMinorUnits 并不是有效的实际付费预算上限**。没有证据证明 provider 实际模型单价、图像输入处理方式、token 上限及是否有账户活动折扣，当前不可据此授权真实收费操作。授权草稿完全不具备 API 调用资格，也没有任何自动生成用户审批签名的行为。

## 2. 本阶段绝对没有做的操作

- 未调用 `cloud_glm_vision.py`、`request_glm` 或其他在线 GLM，未读取用户真实私有原书，未从 GitHub Actions 上传书页图片。
- 没有新增 HTTP /api/approve、/api/dispatch、自动执行按钮或付费调度作业；未读取任何 Secret/API Key。
- Windows 自托管 Runner 只在 OS `Temp` 创建并清除合成测试文件；真实私有 `D:\ai-cognitive-pdf-benchmark-data` 保持不变。
- 未把 14 张真实裁剪图改成机器图理解成功/人工审核通过，也未移动或改写旧 P127 草稿、原有计费回执。

## 3. 测试与证据

- **首次专项失败**：[GitHub Actions #39586217307](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39586217307)，94 项 JavaScript 中 93 PASS、1 FAIL。损坏预留文件不足最低长度，安全代码提前返回 `BATCH_LEDGER_RESERVATION_UNSAFE`，但测试误预期 `BATCH_LEDGER_CORRUPT`。修正断言（保留早期拒绝逻辑）后：
- [准确代码 HEAD 专项 #39586350905](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39586350905)：**SUCCESS，Python 50/50 + JS 94/94 = 144/144**，仍保留历史 checkout/setup-node 的 Node24 兼容警告。
- [真实 Windows NTFS 合成授权/锁 #39586526514](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39586526514)：**SUCCESS**，固定 Git Blob SHA 验证、未授权拦截、单区域真实 NTFS fsync 存储、读回、重复预留拒绝；只在 Temp 内测试，`providerCalls=0`。
- [此阶段完整主 CI #39586348198](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39586348198)：应按该 run 的准确 SHA 和最终 conclusion 验收；未来文档提交会改变 HEAD，不能以旧 SHA 的通过替代新 SHA。

## 4. 下阶段 03E-04B-02 与执行前硬门禁

真正按批次联网推理前仍必须独立完成：

- 官方/账户计费单价核验（按模型输入/输出 token、图片计量及任何附加项）、可测的**实际金额**上限；超限前拒绝网络请求，不能以 14 张数量替代货币预算。
- 独立显式用户审批和不可转移的授权凭据，绑定精确计划 SHA、单次模型、区域/图片 SHA、金额和到期时刻，**禁止直接把草稿标记为 APPROVED**。
- 正式计费回执必须是跨进程 durable 的 **先保留后发送**；一旦发出请求但结果不明，状态归为“不确定、人工核验”，不得自动重发。还要检查与旧 `.cloud-attempted`、stage 及结果目录的交叉冲突。
- 失败隔离、结果 SHA-256 和完整模型契约验收、批准后登记、人工审核 UI 引导、明确全链路退款/取消/清理边界与最终真实 Edge 验收。
- 上述 04B-02 未独立验收与用户明确授权以前，**14 张 PNG 不会发送云端，不能进入正式 GT 或播客发布管线**。

PR #100 保持 Draft/Open/Unmerged，未经用户明确授权不得合并。
