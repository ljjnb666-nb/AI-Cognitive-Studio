# PDF-FIGURE-STRUCTURE-03E-04B-02B｜签名授权证据验证与永久去重模拟

**日期：2026-10-21。代码归属：PR #100（Draft / Open / Unmerged）。阶段性质：安全内核与模拟验收，不是实际付费 GLM 执行器。**

## 一、与最终“自动识别、最后人工审核”目标的关系

- 03E-04A：已经在用户 D 盘私有数据上读出 15 个区域，1 个 P127 有未经人工确认的 GLM 图关系候选，另外 14 个只有经过校验的裁剪图（当前尚未收费推理）。
- 03E-04B-01：已经实现 SHA 绑定的 `DRAFT_NOT_AUTHORIZED` 申请、最大调用次数及拟定金额上限、离线不可重复预留。
- 03E-04B-02A：已实现官方公开价的模拟报价及旧 GLM 回执/结果目录的只读对账；账户实际价格、图片 Token 最大值及真实货币预算约束**未确认**。
- **本 03E-04B-02B**：进一步验证具有正确签名的授权*证据*以及进程并发下“一个区域只能被一方领取”的不可重放模拟；仍**没有发起云端请求的执行路径**。

## 二、新增源码与不可跨越的权限边界

### `annotation/graph-batch-consent-proof.mjs`

- 在合成测试里生成 Ed25519 密钥对，签名 JSON 的精确字节。验证时绑定完整 `planSha256`、`requestSha256`、候选 `cropSha256` 列表、区域 ID、模型、来源、最大次数、拟定金额/币种、签发/到期时间。
- 验证明确的 `trustedKeys`，不从 HTTP 请求、模型响应或需要审核的数据中读取“可信公钥”。**生产默认的 `TRUSTED_PRODUCTION_SIGNERS` 为空对象**；本切片没有给真实操作员或服务部署授权签名公钥。
- 通过签名只代表“指定私钥签过这些字节”，不代表已验证用户真实授权权限、身份、图像最高输入 token、账户最终价格或总费用上限。即使签名核验通过，`billableBudgetVerified=false`、`accountPriceVerified=false`、`imageTokenMaximumVerified=false`、`providerExecutionApproved=false`、`dispatchEnabled=false`。
- `assertBillableReady()` 总是拒绝；本切片不能把合成签名转换成实际批准，也不能在现有本机审核 API 中提交签名获得调用资格。

### `annotation/graph-batch-simulated-attempt.mjs`

- **仅供模拟**的“先领取再观察”文件状态。必须由调用方明确准备隔离根目录，并放入精确 `ACS_SYNTHETIC_ONLY.marker`；不会修改既有 D 盘原书数据或旧 P127 GLM 结果。
- 固定子目录 `private-synthetic-attempts-04b02b`，规范区域 ID 生成唯一 Windows 安全文件名，**无论更换拟定授权申请或结果 SHA，同一区域仍不能重复领取**。
- 操作前只读检查旧 `.cloud-attempted` 请求回执、`-stage`、正式结果和同书 batch 命名空间，发现旧结果/不确定请求一律禁止模拟领取。
- O_EXCL 排他创建、写入并 `fsync`；同区域多进程或多标签页的并发尝试至多一个成功。记录标记 `SIMULATED_UNCERTAIN_OUTCOME_NO_NETWORK`、`mayAutoReplay=false`、`networkAllowed=false`，不可自动删除/解锁/重试。读取损坏、截断、来源或授权版本不匹配时 fail-closed。
- **请勿把此模拟标记称为正式账单回执**。当前没有网络发送回调、没有使用 API Key、没有任何状态可升级成模型请求。Windows 系统完全断电下目录项持久性的边界，还需要正式计费执行器额外的 fsync/恢复策略及实际故障注入验证。

## 三、测试和审计事实（失败原貌保留）

- **第一次测试失败**：[专项 #39591044842](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39591044842)：JavaScript **107 通过、2 失败**。具体是 Ed25519 `publicKey` 已经是公钥 KeyObject，直接再调用 `createPublicKey(publicKey)` 会触发 Node API 类型错误，导致有效签名误拒绝；RSA 公钥类型错误也被错误地折叠成签名错误。修复：已为 KeyObject 使用原对象，PEM/SPKI 才交给 `createPublicKey`。
- [修复后 PDF 专项 #39591176044](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39591176044)：**SUCCESS**，新的 7 项合成签名/模拟并发回归与此前测试均通过。
- [Windows 自托管 Runner 合成 #39591382066](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39591382066)：**SUCCESS**，来源 Git Blob SHA 精确匹配；真实 NTFS 上 Ed25519 范围与时效验证、签名后仍禁止付费、模拟预留一次成功一次冲突、读回“不得重试”，**PRIVATE_IMAGES_TOUCHED=false，PROVIDER_CALLS=0**。
- 后续发现原负向测试用字符 `A` 替换签名首字符时，有 1/64 概率不产生实际改变；已改成必然不同的字符选择。必须以**最终准确 HEAD** 的合成 CI 作为最终门禁，不能沿用旧成功。
- 之前上一阶段 [完整主 CI #39588989984](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39588989984) 完成后 **CORE-TESTS FAILURE**：播客集成测试 `A2_PODCAST_CLAIM_DID_NOT_REACH_PROVIDER_RESOLVER`（167/168 通过），导致最终 `validate` 失败。该问题非 PDF 专项、且原因尚未查明；新 PDF 测试 PASS **不能冒称完整主 CI PASS**。原首次失败、资源警告和潜在 flaky 均必须保留。

## 四、距离真实付费执行仍有的明确缺口

当前不能把“允许继续开发”当作对剩余 14 张图片的费用授权。真正执行前应另起 03E-04B-02C，完成**独立、不可伪造且可撤销的真实操作员身份与授权管理**、账户实际计费/图片 token 上限和货币预算硬控、与旧 Python provider 完全兼容的正式计费尝试先写后发、请求结果不确定禁止重发、真实停止/失败恢复/跨区域隔离、结果 SHA/图关系契约检验及可信登记，最后仍由人审核图谱。

**生产可信状态 UNVERIFIED；14 张真实图片未新增识别，P127 未完成最终人类审核。未经用户批准，PR #100 不合并。**
