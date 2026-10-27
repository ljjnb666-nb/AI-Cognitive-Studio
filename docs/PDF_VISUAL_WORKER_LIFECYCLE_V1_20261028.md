# PDF v1 Worker 生命周期硬化（2026-10-28）

状态：**DEVELOPMENT / Draft / NOT_PRODUCTION_ENABLED**。基于 #203 正确 HEAD 建立独立增量，不合并父 PR，不启动生产视觉队列。

## 问题与修复

#203 `createOnDemandPdfVisualWorkerRuntime` 的 `close()` 没有与 `execute()` 在同一生命周期里协调：关闭时可以立即销毁私有 S3 HTTP 客户端并退出 Gateway Redis，正在下载原书、运行 PDF.js 或执行提供商请求的任务可能仍未结束；已关闭后的 `execute` 也缺少显式门禁。即使父 PR 的 PDF.js 合成 E2E 通过，也不能证明并发关停安全。

新增可注入的 `createManagedPdfVisualReviewRuntime` 并用于生产组合接口：

1. **Admission fence**：调用 `close()` 的同步瞬间立即拒绝新的任务，错误 `PDF_VISUAL_WORKER_CLOSING`。
2. **Single-flight 容量**：同一专用运行时最多一个 PDF 审阅任务；并行请求 `PDF_VISUAL_WORKER_BUSY`，减少 110MB PDF 的峰值多份占用。此容量限制只在这一个专用 runtime 实例内生效，不宣称跨进程全局限流。
3. **Graceful drain**：已接纳任务成功或失败后，才关闭 Gateway/Redis 和 Worker 自建的 S3 SDK 客户端。
4. **幂等关闭**：多次 `close()` 使用同一个 Promise；清理失败会返回同一个失败，不会静默抹除，也不会重复关闭。
5. **异常清理**：实例初始化时先创建 S3 客户端，创建网关失败则清理 S3；正常关闭时即使 S3 dispose 失败，也尝试清理 Gateway。
6. 不改变用户和工作区授权、PDF 来源 SHA 与 routing replay fence、Gateway 预算和调用幂等、未验证图结构候选的权限边界。**没有开启生产自动派单，也没有发起付费模型调用。**

## 自动化验证

- `apps/worker/tests/pdf-visual-review-lifecycle.test.ts`：等待执行完成后释放、close 后拒绝、并发拒绝且任务完成可重入、任务失败时仍排空、清理失败透传、重复 close。
- 已加入 Worker 原有 `test:unit`；新增独立 exact-head Linux Actions 专项，同次执行已有 `pdf-visual-review.test.ts` 实际合成 PDF.js 测试，以及 TypeScript / ESLint。
- CI 的首次失败、补丁、重试结果要保留；只有准确 HEAD 实测通过后才标记通过。不能以 workflow skipped 代替 pass。

## 待做及诚实边界

- **Graceful drain 未设置全任务硬超时**：若 parser / provider 永久不返回，close 仍可能等待；不能为了超时强关连接导致在途副作用。下一项应补显式取消传播、提供商远端 deadline 与 no-commit fence，实际故障注入后再采用有界停止。
- 本修复不等于跨进程并发容量控制或生产内存验证；一个进程中如果主动创建多个 runtime，仍可能并行执行。
- 仍缺真实 PostgreSQL + MinIO 持久回执循环、授权的 GLM 视觉模型实机、B08/B15/B29/B31 等真实书页 Gold/CER。
- Production Docling OFF；五书独立 Gold **0/5**，CER **null**，视觉结构 **UNVERIFIED**，正文与播客不被自动更新。
