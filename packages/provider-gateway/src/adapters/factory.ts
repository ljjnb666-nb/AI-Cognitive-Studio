import type { ProviderAdapter, ProviderAdapterResolver } from "../types.js";
import { AnthropicCompatibleAdapter } from "./anthropic-compatible.js";
import { GeminiNativeAdapter } from "./gemini-native.js";
import type { ProviderHttpTransport } from "./http-transport.js";
import { OpenAICompatibleAdapter } from "./openai-compatible.js";
import { OpenAIResponsesAdapter } from "./openai-responses.js";
import { CohereEmbeddingAdapter, GeminiEmbeddingAdapter, OpenAIEmbeddingAdapter, QwenEmbeddingAdapter, VoyageEmbeddingAdapter } from "./embeddings.js";
export function createTextAdapterResolver(transport: ProviderHttpTransport): ProviderAdapterResolver {
  const adapters: Record<string, ProviderAdapter> = { openai: new OpenAIResponsesAdapter(transport), anthropic: new AnthropicCompatibleAdapter(transport), gemini: new GeminiNativeAdapter(transport) }; const compatible = new OpenAICompatibleAdapter(transport); for (const key of ["deepseek", "qwen", "minimax"]) adapters[key] = compatible; return input => input.family === "TEXT_GENERATION" ? adapters[input.providerKey] : undefined;
}
export function createProviderAdapterResolver(transport: ProviderHttpTransport): ProviderAdapterResolver { const text = createTextAdapterResolver(transport); const embedding: Record<string, ProviderAdapter> = { openai: new OpenAIEmbeddingAdapter(transport), gemini: new GeminiEmbeddingAdapter(transport), qwen: new QwenEmbeddingAdapter(transport), cohere: new CohereEmbeddingAdapter(transport), voyage: new VoyageEmbeddingAdapter(transport) }; return input => input.family === "EMBEDDING" ? embedding[input.providerKey] : text(input); }
