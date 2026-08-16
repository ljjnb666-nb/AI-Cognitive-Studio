# Phase 8B text provider adapters

Verified 2026-08-16. Phase 8B has one provider-neutral `ProviderGateway`; provider wire differences stay in its adapters. Runtime text input is limited to `system`, ordered `messages`, `generation`, and `structuredOutput`. It has no provider-native request JSON, headers, tools, web/search, files, code execution, computer use, or reasoning controls. Runtime content is hashed for idempotency and is not persisted.

| Provider identity | Protocol and approved API variant | Authentication | Official documentation |
| --- | --- | --- | --- |
| OpenAI | Responses: `POST /v1/responses`; `text.format` | Bearer | https://platform.openai.com/docs/api-reference/responses |
| Anthropic | Messages: `POST /v1/messages`; `output_config.format` for strict JSON | `x-api-key`, `anthropic-version: 2023-06-01` | https://platform.claude.com/docs/en/api/messages and https://platform.claude.com/docs/en/build-with-claude/structured-outputs |
| Gemini | Gemini API `v1beta`: `models/{model}:generateContent` | `x-goog-api-key` | https://ai.google.dev/api/generate-content |
| DeepSeek | OpenAI-compatible Chat Completions: `POST /chat/completions` | Bearer | https://api-docs.deepseek.com/api/create-chat-completion |
| Qwen | Model Studio OpenAI-compatible `POST /compatible-mode/v1/chat/completions` | Bearer | https://www.alibabacloud.com/help/en/model-studio/what-is-model-studio |
| MiniMax | OpenAI-compatible Chat Completions: base `https://api.minimax.io/v1`, `POST /chat/completions` | Bearer | https://platform.minimax.io/docs/api-reference/text-openai-api |

DeepSeek, Qwen, and MiniMax deliberately share the OpenAI-compatible wire adapter while retaining distinct provider identities, profiles, and registry-declared capabilities. No model-name inference or arbitrary base URL is available; custom endpoints remain Phase 8E.

`STRICT_JSON_SCHEMA` requires a JSON-object schema that passes the shared local AJV compilation before routing or HTTP, then validates the JSON provider response locally. `JSON_MODE` only requires parseable JSON. `PROMPT_ONLY` neither parses JSON nor sends provider structured-output configuration. Gemini sends neither `responseMimeType` nor `responseJsonSchema` for omitted structured output or `PROMPT_ONLY`; it sends `responseMimeType: application/json` for `JSON_MODE`, and both it and the exact schema for strict mode. Anthropic sends `output_config.format` only for strict mode.

Workspace BYOK routing takes precedence. If no workspace route exists, the platform resolver obtains a platform credential lazily at execution time; there is no runtime provider fallback. Credentials, raw prompts/responses, and provider reasoning/thinking are excluded from durable execution records and normalized errors. CI uses deterministic transports and no real external AI calls. All adapters are POST-only, use an internal authentication-header whitelist, reject redirects, and bound response bodies.

For Qwen, Beijing and Singapore use workspace-specific `*.maas.aliyuncs.com` compatible-mode profiles with an allowlisted workspace-ID label; US (Virginia) uses `dashscope-us.aliyuncs.com`. This prevents a workspace value from becoming an arbitrary host.
