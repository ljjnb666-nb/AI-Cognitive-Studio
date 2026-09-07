import { ProviderGatewayError } from "../errors.js";
import { parseProviderModelManifest, type ProviderModelManifest } from "../model-manifest.js";
import type { ProviderDefinition } from "../types.js";

const text = (modelId: string, structuredOutput: "STRICT_JSON_SCHEMA" | "JSON_MODE" = "JSON_MODE") => ({ modelId, families: ["TEXT_GENERATION"] as const, confidence: "DECLARED" as const, structuredOutput });

/** Safe capability metadata only. API credentials never belong in this catalog. */
export const builtInProviderCatalog: ProviderModelManifest = {
  providers: [
    { providerKey: "openai", displayName: "OpenAI", protocol: "OPENAI_RESPONSES", capabilityProtocols: { EMBEDDING: "OPENAI_EMBEDDINGS", SPEECH: "CUSTOM_SPEECH" }, adapterVersion: "builtin-v1", models: [text("gpt-4o-mini", "STRICT_JSON_SCHEMA"), { modelId: "text-embedding-3-small", families: ["EMBEDDING"], confidence: "DECLARED", embeddingDimensions: 1536 }, { modelId: "gpt-4o-mini-tts", families: ["SPEECH"], confidence: "DECLARED", speechFormats: ["mp3", "wav", "opus", "aac", "flac", "pcm"] }] },
    { providerKey: "anthropic", displayName: "Anthropic", protocol: "ANTHROPIC_COMPATIBLE", adapterVersion: "builtin-v1", models: [text("claude-3-5-haiku-latest", "STRICT_JSON_SCHEMA")] },
    { providerKey: "gemini", displayName: "Google Gemini", protocol: "GEMINI_NATIVE", capabilityProtocols: { EMBEDDING: "GEMINI_EMBEDDINGS" }, adapterVersion: "builtin-v1", models: [text("gemini-2.0-flash", "STRICT_JSON_SCHEMA"), { modelId: "text-embedding-004", families: ["EMBEDDING"], confidence: "DECLARED", embeddingDimensions: 768 }] },
    { providerKey: "deepseek", displayName: "DeepSeek", protocol: "OPENAI_COMPATIBLE", adapterVersion: "builtin-v1", models: [text("deepseek-chat", "JSON_MODE")] },
    { providerKey: "zhipu", displayName: "智谱 GLM", protocol: "OPENAI_COMPATIBLE", adapterVersion: "builtin-v1", models: [text("glm-4-flash", "JSON_MODE")] },
    { providerKey: "openai-compatible", displayName: "OpenAI 兼容服务 / 自定义", protocol: "OPENAI_COMPATIBLE", adapterVersion: "builtin-v1", models: [text("custom-model", "JSON_MODE")] },
  ],
};

/** An optional operator manifest may replace a built-in key or add a new key. Duplicate keys within either source remain invalid. */
export function resolveProviderCatalog(source: string | undefined): ProviderModelManifest {
  if (!source) return builtInProviderCatalog;
  const custom = parseProviderModelManifest(source);
  const definitions = new Map<string, ProviderDefinition>();
  for (const provider of builtInProviderCatalog.providers) definitions.set(provider.providerKey, provider);
  for (const provider of custom.providers) {
    if (definitions.has(provider.providerKey)) process.emitWarning(`Provider catalog override active for ${provider.providerKey}`, { code: "PROVIDER_CATALOG_OVERRIDE" });
    definitions.set(provider.providerKey, provider);
  }
  if (!definitions.size) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "PROVIDER_GATEWAY_MODEL_MANIFEST_INVALID");
  return { providers: [...definitions.values()] };
}
