# MiniMax M3 无效响应接入修复

## 已知事实及定位边界

真实恢复请求约 38.1 秒后以 INVALID_PROVIDER_RESPONSE 失败，超过旧 30 秒限制，说明本轮失败已不同于旧超时。旧适配器未在 MiniMax 无效结构响应路径保留报告用量或安全诊断，原始回执没有可恢复副本；不能断言该次具体属于内嵌思考、截断、JSON 语法或结构错误，也不能追认其 Token 或费用为零。

代码检查确认两个接入缺口：M3 未显式分离思考内容；校验失败的数据丢失分支只覆盖智谱，不覆盖 MiniMax。官方文档说明 reasoning_split 控制思考内容是否独立返回，且思考 token 计入输出上限。上述为可验证的协议缺口，不冒充历史真实回执的根因结论。

## 最小修复

- 仅对 `minimax / MiniMax-M3` 发送 `reasoning_split: true`，从 `content` 严格解析最终结果，不使用、保存或展示 reasoning_content 的正文。
- 使用官方推荐的 `max_completion_tokens`，数值沿用原有输出限制，不与 max_tokens 同时发送。不增加 Token 额度，不关闭思考，不开启收费优先服务，不增加 response_format 原生严格 Schema 声明。
- 不在本地剥离 think 标签、不移除代码围栏、不修补 JSON。输出截断（包括恰好可解析的截断片段）仍拒绝；明确 content_filter 则归为 CONTENT_REJECTED。
- 外层 HTTP JSON 异常、缺失最终内容、JSON 或 Schema 校验失败时保留非重试错误；报告的输入/输出 Token、HTTP 状态、标准化结束原因、长度与布尔诊断通过既有账本落库。没有报告用量时保持未知，不伪造数字。原文、思考正文、密钥及供应商自由文本不进入诊断。
- MiniMax 默认目录适配版本更新为 builtin-v2，供新解析的执行快照识别协议变更。不迁移、改写已有 Run、冻结快照或旧费用记录。显式部署目录保持权威。旧失败调用不自动恢复或重放，恢复须走正常创建新执行尝试的入口。
- 页面以“模型响应异常”说明格式校验失败、结果保留及可能计费，并继续展示安全错误编号。

## 验证

- Gateway 单元回归 82 项通过。
- Worker 请求完整性与超时策略回归 11 项通过。
- 独立 PostgreSQL Gateway 回归 10 项通过，包含新增 MiniMax 失败用量与安全诊断持久化、无成功成果写入，以及失败幂等回放不再请求供应商。
- 页面状态回归 24 项通过。合计 127 项通过。
- Gateway、Worker、Web 类型检查及变更文件 ESLint、Git 空白检查通过。
- 浏览器通过 Playwright 验证实际状态组件（Browser 插件不可用），异常标签、具体原因、费用提示可见；没有点击恢复。
- 只读复核原任务仍为 FAILED/INVALID_PROVIDER_RESPONSE；3 条历史调用、7 次历史尝试保持原样。本轮没有真实模型调用，旧未知费用不改写。

## 验收状态

ENGINEERING_FIX_VERIFIED：通过。真实模型复测未执行，不能宣布实际分块或全书理解成功。若后续仍失败，新诊断可区分最终内容缺失、截断、非法 JSON 与已解析内容的结构校验问题，而不是继续丢失依据。

官方依据：[MiniMax OpenAI 兼容接口参数](https://platform.minimax.cn/docs/api-reference/text-openai-api)。
