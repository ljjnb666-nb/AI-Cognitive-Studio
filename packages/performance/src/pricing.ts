export type PricingUnit = "TOKENS" | "CHARACTERS" | "AUDIO_DURATION";
export type ProviderPricingEntry = { providerKey: string; modelId: string; capability: string; unit: PricingUnit; inputMicrosPerMillion?: bigint; cachedInputMicrosPerMillion?: bigint; outputMicrosPerMillion?: bigint; embeddingMicrosPerMillion?: bigint; speechMicrosPerMillion?: bigint };
export type ProviderPricingCatalog = { version: string; entries: readonly ProviderPricingEntry[] };

/** Versioned fixture catalog for engineering estimates only; it is deliberately not a billing source. */
export const phase16PricingCatalog: ProviderPricingCatalog = { version: "phase16-fixture-v1", entries: [
  { providerKey: "benchmark", modelId: "text-v1", capability: "TEXT_GENERATION", unit: "TOKENS", inputMicrosPerMillion: 1_000_000n, cachedInputMicrosPerMillion: 250_000n, outputMicrosPerMillion: 2_000_000n },
  { providerKey: "benchmark", modelId: "embedding-v1", capability: "EMBEDDING", unit: "TOKENS", embeddingMicrosPerMillion: 200_000n },
  { providerKey: "benchmark", modelId: "speech-v1", capability: "SPEECH", unit: "CHARACTERS", speechMicrosPerMillion: 1_500_000n },
] };
export function findPricing(catalog: ProviderPricingCatalog, event: Pick<ProviderUsageForCost, "providerKey" | "modelId" | "capability">): ProviderPricingEntry | undefined { return catalog.entries.find(entry => entry.providerKey === event.providerKey && entry.modelId === event.modelId && entry.capability === event.capability); }
export type ProviderUsageForCost = { providerKey: string; modelId: string; capability: string; inputTokens?: number | null; cachedInputTokens?: number | null; outputTokens?: number | null; embeddingInputTokens?: number | null; speechInputCharacters?: number | null; audioDurationMs?: number | null; usageQuality?: "ACTUAL_PROVIDER_USAGE" | "LOCAL_DETERMINISTIC_ESTIMATE" };
