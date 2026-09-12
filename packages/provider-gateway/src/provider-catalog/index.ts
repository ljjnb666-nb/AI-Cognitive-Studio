import { parseProviderModelManifest, type ProviderModelManifest } from "../model-manifest.js";

const text = (modelId: string, structuredOutput: "STRICT_JSON_SCHEMA" | "JSON_MODE" = "JSON_MODE") => ({ modelId, families: ["TEXT_GENERATION"] as const, confidence: "DECLARED" as const, structuredOutput });

/** Safe capability metadata only. API credentials never belong in this catalog. */
export const builtInProviderCatalog: ProviderModelManifest = {
  providers: [
    { providerKey: "openai", displayName: "OpenAI", protocol: "OPENAI_RESPONSES", capabilityProtocols: { EMBEDDING: "OPENAI_EMBEDDINGS", SPEECH: "CUSTOM_SPEECH" }, adapterVersion: "builtin-v1", models: [text("gpt-4o-mini", "STRICT_JSON_SCHEMA"), { modelId: "text-embedding-3-small", families: ["EMBEDDING"], confidence: "DECLARED", embeddingDimensions: 1536 }, { modelId: "gpt-4o-mini-tts", families: ["SPEECH"], confidence: "DECLARED", speechFormats: ["mp3", "wav", "opus", "aac", "flac", "pcm"] }] },
    { providerKey: "anthropic", displayName: "Anthropic", protocol: "ANTHROPIC_COMPATIBLE", adapterVersion: "builtin-v1", models: [text("claude-3-5-haiku-latest", "STRICT_JSON_SCHEMA")] },
    { providerKey: "gemini", displayName: "Google Gemini", protocol: "GEMINI_NATIVE", capabilityProtocols: { EMBEDDING: "GEMINI_EMBEDDINGS" }, adapterVersion: "builtin-v2", models: [text("gemini-2.0-flash", "STRICT_JSON_SCHEMA"), { modelId: "gemini-embedding-2", families: ["EMBEDDING"], confidence: "DECLARED", embeddingDimensions: 768, configurableEmbeddingDimensions: true, embeddingDimensionOptions: [768] }] },
    // Explicit versioned public IDs keep the catalog deterministic and easy to update.
    { providerKey: "deepseek", displayName: "DeepSeek", protocol: "OPENAI_COMPATIBLE", adapterVersion: "builtin-v2", models: [text("deepseek-v4-flash", "JSON_MODE"), text("deepseek-v4-pro", "JSON_MODE")] },
    { providerKey: "zhipu", displayName: "智谱 GLM", protocol: "OPENAI_COMPATIBLE", adapterVersion: "builtin-v1", models: [text("glm-4-flash", "JSON_MODE")] },
    // Qwen embeddings use Model Studio's typed region/workspace configuration.
    // text-embedding-v4 dimensions are the published, selectable values.
    { providerKey: "qwen", displayName: "阿里云百炼 Qwen", protocol: "OPENAI_COMPATIBLE", adapterVersion: "builtin-v1", models: [text("qwen-plus", "JSON_MODE"), { modelId: "text-embedding-v4", families: ["EMBEDDING"], confidence: "DECLARED", embeddingDimensions: 1024, configurableEmbeddingDimensions: true, embeddingDimensionOptions: [2048, 1536, 1024, 768, 512, 256, 128, 64], maxEmbeddingInputs: 10 }] },
    // MiniMax M3 has no native strict JSON Schema declaration here.  The
    // gateway prompts for JSON and keeps its existing parse/domain validation gate.
    { providerKey: "minimax", displayName: "MiniMax", protocol: "OPENAI_COMPATIBLE", adapterVersion: "builtin-v1", models: [text("MiniMax-M3", "JSON_MODE")] },
    { providerKey: "openai-compatible", displayName: "OpenAI 兼容服务 / 自定义", protocol: "OPENAI_COMPATIBLE", adapterVersion: "builtin-v1", models: [text("custom-model", "JSON_MODE")] },
  ],
};

/**
 * The built-in catalog is the zero-configuration default. An explicit operator
 * manifest remains authoritative so existing deployments can pin their exact
 * provider surface (including deterministic release fixtures) without silently
 * acquiring additional providers.
 */
export function resolveProviderCatalog(source: string | undefined): ProviderModelManifest {
  if (!source) return builtInProviderCatalog;
  return parseProviderModelManifest(source);
}
