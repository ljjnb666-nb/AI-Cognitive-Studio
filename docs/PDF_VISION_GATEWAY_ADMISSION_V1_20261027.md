# PDF Vision v1｜Provider Gateway 受控图像输入阶段（2026-10-27）

状态：**Draft / 开发与测试**；不构成生产启用或五书质量认证。基于 #201 的真实 PDF.js → PNG → 非权威图表结构，新增独立网关路由与授权，不修改既有发布路线。

## 已实现

- 新 `PDF_VISUAL_STRUCTURE` route slot：仍依托 `TEXT_GENERATION` 的已有数据库凭证/工作区路由、幂等 claim、调用计费/限流、加密文本回执与完整重放授权；不新建数据库 schema，也不改变 BOOK/PODCAST 的路由。
- 仅显式 `visionInput:true` 的已登记供应商 `zhipu`/模型 `glm-4.6v` 可申请此路由；它是 **EXPERIMENTAL** 清单能力，不代表真实服务已核实或默认被启用。普通书稿生成/自定义兼容服务携带图像均被拒绝。
- 上传前检查实际 PNG 签名与 IHDR、宽高、物理页码、`sha256`、`sourceSha256` 字形、最多 8MB 的严格 Base64 与 byte budget，预先比较用户预算和实际字节数；失败在发起模型请求与创建持久化 claim 之前结束。
- `canonicalTextInputHash` 对图像采用**摘要和页来源元数据**，不将 Base64 的私有原书像素写入指纹、日记或公共 CI；远端协议仅构造一条用户图像输入，使用已有已批准 Zhipu 端点，不能自定义任意 URL。
- `createGatewayPdfVisualExecutor` 输出类型兼容 ingestion 的 `VisualPageExecutor`，负责把物理页/源 PDF/PNG 哈希绑定到稳定调用身份，以原网关执行及既有 JSON 加密回执返回候选；缺少可恢复结构结果就 fail-closed。设置 `maxAttempts=1`，避免自动重复付费视觉请求。
- 图结构的合法性仍由 #201 严格独立复验，且任何视觉结果一律为 `UNVERIFIED_VISUAL_CANDIDATE`，不能写入 canonical 文本或冒充五书 Gold。

## 仍未满足的门禁

1. 此路由在生产中**未被任何工作流自动调用**；工作区需明确配置模型/凭证后才能进入执行。
2. 快速 CI 仅使用合成 PNG 与模拟 GLM 返回，不消耗真实模型额度。完整持久化 PostgreSQL 回执重放及真实供应商额度应后续验证；此次不宣称已完成两项。
3. 当前上游图像判别是来源 PNG，不是图像对象精确定位；正文/图表关联展示、结构原始证据审计及正式五书质量评分尚未完成。
4. 仍保持生产 Docling OFF，五书独立 Gold 0/5、CER=null、相关 PR Draft/unmerged。

## 隐私和安全

原文、完整私有 PDF SHA/PNG SHA、图片 Base64 均不写入 GitHub 代码、Issue、公共日志或 CI artifact。密钥通过既有 Gateway `beforeAttempt` / 密文凭证存取，不嵌入应用源码；模型见到内容仅在明确授权 API 远端调用时发生。固定图像大小约束不是视觉模型 token 的精确成本估计；未来上线需要按供应商的图像计费量测补充成本预算。

## 验收入口

- `pnpm --filter @ai-cognitive/provider-gateway exec vitest run tests/pdf-vision-gateway.test.ts tests/phase9-model-manifest.test.ts`
- `pnpm --filter @ai-cognitive/provider-gateway typecheck`
- `pnpm --filter @ai-cognitive/provider-gateway lint`
- 准确 HEAD 的独立 GitHub Actions + 全量主 CI（不得以跳过或旧 SHA 代替）。
