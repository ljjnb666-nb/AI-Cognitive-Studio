# Phase 8B text provider adapters

Verified 2026-08-16. The adapters use direct POST-only protocols with internally controlled authentication headers, manual redirects, bounded response bodies, and no tools or raw vendor request escape hatch.

| Provider protocol | Official documentation |
| --- | --- |
| OpenAI Responses API (`/v1/responses`, `text.format`, usage) | https://platform.openai.com/docs/api-reference/responses |
| OpenAI-compatible Chat Completions | https://api-docs.deepseek.com/api/create-chat-completion |
| Anthropic Messages (`/v1/messages`, `x-api-key`, `anthropic-version`) | https://docs.anthropic.com/en/api/messages |
| Gemini GenerateContent (`x-goog-api-key`, `systemInstruction`, `generationConfig`) | https://ai.google.dev/gemini-api/docs/text-generation |

The Gemini structured-output mapping uses `responseMimeType: application/json` and `responseJsonSchema`, as documented at https://ai.google.dev/gemini-api/docs/structured-output. Qwen, DeepSeek, and MiniMax retain separate approved profiles while sharing the OpenAI-compatible wire adapter; model capabilities remain registry-declared.
