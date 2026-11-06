# 模型目录更新验收记录（2026-11-06）

本轮更新新配置可选模型，不修改已有数据库绑定、历史执行快照或任务默认路由，不调用收费接口。

## 模型与用途

- 国内阿里云百炼：新增 `qwen3.8-flash`、`qwen3.8-max`、`qwen3.7-plus`，按官方文档登记原生严格 JSON Schema 能力，可选择用于理解验证。既有 `qwen-plus` 保持 JSON 模式，不升级能力声明。
- OpenAI：新增 `gpt-5.4-mini`；`gpt-4o-mini` 标记为旧型号，不再推荐新选，但保留既有显式绑定的解析能力。
- Claude：新增 `claude-haiku-4-5-20251001`、`claude-sonnet-4-6`；保留退役 Haiku 3.5 的历史身份，阻止新执行。
- Gemini：新增 `gemini-3.8-flash`；保留退役 Gemini 2.0 Flash 的历史身份，阻止新执行。
- MiniMax、智谱、DeepSeek 现有 JSON 模式能力保持不变，不冒充原生严格结构输出，不强行加入理解验证选项。
- Embedding、音频、OCR、视频路由保持原样。显式运维模型清单仍拥有完整优先权，本机未配置覆盖清单。

## 请求及安全边界

千问发送原始严格 JSON Schema。新增 Claude、Gemini 型号按各自官方支持的 Schema 子集生成传输结构，将不支持的约束写入描述；本机仍用完整原始 Schema 和业务规则校验响应。原 Schema、请求身份输入及历史快照不被转换函数修改。新增 GPT 与 Claude 型号不发送不兼容的采样参数，旧型号传输保持原样。

旧型号、停服型号不会被自动替换。停服绑定在页面明确提示重新选择；新选择列表不再返回停服或旧型号。能力登记为文档声明，不标记为真实调用验证通过。

## 验证结果

- Gateway：5 文件，72 项通过。
- Web 与独立测试数据库：5 文件，66 项通过。
- 合计 138 项通过。覆盖真实理解验证 Schema、供应商传输格式、完整本机约束、虚构引用、重复评分项、历史绑定不改写、停服模型拒绝、运维清单优先及配置保存。
- Web、Gateway TypeScript 类型检查通过；变更文件 ESLint 通过。
- Web 生产构建通过，37 个静态页面生成完成。已有 ingestion `import.meta` 构建警告仍存在，本轮未改动该模块。
- 实际组件浏览器测试：千问理解验证下拉框列出三款新增型号，选择与保存反馈正确。浏览器接口使用确定性替身；数据库测试单独验证保存行为。
- 本地服务 `/api/health` 返回 200。
- 未发送真实云端模型请求，未验证账户权限、供应商实时可用性或真实模型回答质量。不能将上述结果视为真实模型验收。
- 未推送、合并主分支、部署或修改生产数据库；保留已有 `apps/web/AGENTS.md` 独立修改。

浏览器证据保存于私有目录 `D:/ai-cognitive-pdf-benchmark-data/private/model-catalog-update-20261106/qwen-review-options.png`，不提交私有截图或凭据。

## 官方依据

- [百炼结构化输出](https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-structured-output)
- [百炼模型列表](https://docs.bailian.console.aliyun.com/zh/model-studio/models)
- [GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini)
- [GPT-4o mini](https://developers.openai.com/api/docs/models/gpt-4o-mini)
- [Claude 结构化输出](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Claude 型号生命周期](https://platform.claude.com/docs/en/about-claude/model-deprecations)
- [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
- [Gemini 结构化输出](https://ai.google.dev/gemini-api/docs/structured-output)
