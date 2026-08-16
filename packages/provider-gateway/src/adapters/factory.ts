import type { ProviderAdapter } from "../types.js";
import { AnthropicCompatibleAdapter } from "./anthropic-compatible.js";
import { GeminiNativeAdapter } from "./gemini-native.js";
import type { ProviderHttpTransport } from "./http-transport.js";
import { OpenAICompatibleAdapter } from "./openai-compatible.js";
import { OpenAIResponsesAdapter } from "./openai-responses.js";
export function createTextAdapterResolver(transport: ProviderHttpTransport): (providerKey: string) => ProviderAdapter | undefined {
  const adapters: Record<string, ProviderAdapter> = { openai: new OpenAIResponsesAdapter(transport), anthropic: new AnthropicCompatibleAdapter(transport), gemini: new GeminiNativeAdapter(transport) }; const compatible = new OpenAICompatibleAdapter(transport); for (const key of ["deepseek", "qwen", "minimax"]) adapters[key] = compatible; return providerKey => adapters[providerKey];
}
