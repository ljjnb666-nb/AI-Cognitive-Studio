# AI Cognitive Studio

面向书籍理解、个人思考训练和内容生成的工作室。当前提供文档上传与解析、带来源跨度的书籍分析、认知条目与复习、Thinking Session、Teach Back、播客脚本与音频，以及本地 FFmpeg 短视频生成。

项目目前应按 **Beta 工具**使用。结构化证据、任务恢复和媒体工程测试不等于真实模型语义准确率或生产可靠性认证。修复范围和尚未关闭的事项见 [审计修复台账](docs/audit-remediation-20261026.md)。

## 架构与数据边界

- `apps/web`：Next.js App Router、Better Auth、Studio 页面与 API。
- `apps/worker`：BullMQ 后台解析、分析、播客和视频任务；PostgreSQL Outbox 负责可靠派发。
- `packages/db`：Prisma 模型、迁移、工作区约束和持久化任务状态。
- `packages/ingestion`：受限上传、文档规范化、PDF/OCR 路由、来源与提取谱系。
- `packages/book-intelligence`：分块分析、保留证据的分层综合、认知条目和数据库内向量排序。
- `packages/provider-gateway`：用户自带密钥、模型路由、加密凭据、付费调用回执、重试及资源预算。
- `packages/podcast-generation` / `short-video-generation`：脚本、语音、音频质量测量与视频渲染。
- `packages/product-analytics` / `performance`：Beta 反馈、运行诊断和基准证据。

数据库是身份、任务状态和调用回执的权威来源；对象存储保留原始文件和生成媒体。Redis 队列不能代替数据库中的执行身份。恢复已付费任务时不得删除回执或更换幂等键来强行重试。

## 本地运行

需要 Node.js 24、pnpm 10.30.3、Docker，以及 PATH 中可用的 FFmpeg/FFprobe、OpenSSL（真实 TLS 回归）。视频中文字形需要系统安装中文字体。

PowerShell：

```powershell
pnpm install --frozen-lockfile
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
# 已有 .env 请直接编辑，勿覆盖。
# 使用随机值填写 BETTER_AUTH_SECRET（至少 32 字符）。
docker compose up -d
pnpm db:generate
pnpm db:migrate:deploy
pnpm dev
```

打开 http://localhost:3001。`pnpm dev` 同时启动 Web 和 Worker；只启动 Web 无法完成后台解析和生成。根目录 `.env` 是本地配置唯一入口，显式进程环境变量优先。

在设置中配置 Provider、保存密钥并绑定模型路由。没有配置 AI 服务时，可以上传解析，但无法完成付费分析。原始文档会作为不可信输入传给所选服务，来源引用以原文 UTF-16 偏移校验。

`WEB_DEV_BOOTSTRAP_IDENTITY` 仅用于开发；正式身份流程应将其设为 `false` 并注册账户。配置 `SMTP_HOST` 和 `SMTP_FROM` 后启用邮件验证和密码找回；生产 SMTP 强制 TLS。未配置邮件服务时，找回页会明确显示不可用。

扫描 PDF 需要另行安装并配置受支持的 MinerU 本地模型环境；默认 Docker 应用镜像不包含该模型。复杂分栏、表格和公式的准确性仍须以实际样本验收。

## 验证

集成测试需要独立的、名称以 `_test` 结尾的数据库：

```powershell
docker compose exec postgres createdb -U app ai_cognitive_studio_test
$env:DATABASE_URL_TEST='postgresql://app:app@localhost:5432/ai_cognitive_studio_test?schema=public'
$env:DATABASE_URL=$env:DATABASE_URL_TEST
pnpm db:migrate:deploy
Remove-Item Env:DATABASE_URL
pnpm lint
pnpm typecheck
node --env-file=.env scripts/run-pnpm-with-root-env.mjs test:unit
node --env-file=.env scripts/run-pnpm-with-root-env.mjs test:integration
pnpm --filter @ai-cognitive/web exec playwright install chromium
$env:POSTGRES_HOST_PORT='5432'
pnpm test:phase9:release
pnpm build
```

内存有限时将构建、类型检查、容器构建和集成测试逐项运行；类型检查可用 `pnpm --workspace-concurrency=1 -r --if-present typecheck`，避免多个编译器同时占用内存。

`test:unit` 自动发现核心包中的单元用例；`test:integration` 在随机命名的独立数据库内迁移并串行运行数据库相关套件，包含 Gateway、Analytics 和 Worker 队列隔离。测试数据库用户需要建库权限。成功后删除本次数据库；失败时保留现场，数据库名称与结果记录在 `output/integration/`，不会清空原有测试库。仅在已准备好独立数据库时使用底层 `test:integration:suites`。FFmpeg 诊断压力测试默认跳过，需使用各自诊断运行器；不能把跳过报告成通过。浏览器、真实 AI、压力和恢复演练是不同证据层级。

Phase 9 使用随机隔离数据库、私有桶和队列前缀，以真实登录、真实数据库和真实媒体处理验证流程；其 AI 响应来自测试适配器，不证明真实模型质量。

## 预算、部署与维护

默认工作区资源预算为每天 1,000,000 单位、单次运行 300,000 单位，可由 Owner 在设置中调整。文本使用保守的 UTF-8 输入体积及输出上限，语音使用字符数；这是资源限额，**不是人民币或美元账单**。未知远端结果保留预算占用，避免重试绕过限额。取消任务会阻止后续调用，但不能追回已发送给供应商的请求或费用。

生产部署、迁移顺序、恢复演练和发布门禁见 [运维手册](docs/operations.md)。开发 Compose 中的账户和密码仅用于本地测试，不应用于生产。

账户设置支持下载个人学习记录 JSON；书籍详情页支持下载原始上传文件。两者的范围、限制和租户边界见 [数据生命周期说明](docs/personal-data-lifecycle.md)。完整工作区归档和可验证删除生命周期仍未完成。
