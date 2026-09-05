import { estimateProviderCost } from "./cost.js";
import { phase16PricingCatalog, type ProviderUsageForCost } from "./pricing.js";

/** Input-only deterministic engineering profiles. Costs are always calculated, never authored here. */
export const phase16ScenarioProfiles = [
  { scenario: "BOOK_SMALL", usage: { providerKey: "benchmark", modelId: "text-v1", capability: "TEXT_GENERATION", inputTokens: 120_000, cachedInputTokens: 12_000, outputTokens: 24_000 } },
  { scenario: "BOOK_MEDIUM", usage: { providerKey: "benchmark", modelId: "text-v1", capability: "TEXT_GENERATION", inputTokens: 430_000, cachedInputTokens: 43_000, outputTokens: 86_000 } },
  { scenario: "BOOK_LARGE", usage: { providerKey: "benchmark", modelId: "text-v1", capability: "TEXT_GENERATION", inputTokens: 1_250_000, cachedInputTokens: 125_000, outputTokens: 250_000 } },
  { scenario: "PODCAST_15_MIN", usage: { providerKey: "benchmark", modelId: "text-v1", capability: "TEXT_GENERATION", inputTokens: 190_000, cachedInputTokens: 19_000, outputTokens: 38_000 } },
  { scenario: "PODCAST_30_MIN", usage: { providerKey: "benchmark", modelId: "text-v1", capability: "TEXT_GENERATION", inputTokens: 370_000, cachedInputTokens: 37_000, outputTokens: 74_000 } },
  { scenario: "PODCAST_60_MIN", usage: { providerKey: "benchmark", modelId: "text-v1", capability: "TEXT_GENERATION", inputTokens: 760_000, cachedInputTokens: 76_000, outputTokens: 152_000 } },
] as const satisfies readonly { scenario: string; usage: ProviderUsageForCost }[];

export function calculatePhase16Scenarios() {
  return phase16ScenarioProfiles.map(profile => {
    const cost = estimateProviderCost(phase16PricingCatalog, { ...profile.usage, usageQuality: "LOCAL_DETERMINISTIC_ESTIMATE" });
    if (cost.estimatedCostMicros === null || (cost.quality !== "ACTUAL_PROVIDER_USAGE" && cost.quality !== "LOCAL_DETERMINISTIC_ESTIMATE")) throw new Error(`PHASE16_SCENARIO_UNPRICED:${profile.scenario}`);
    return { scenario: profile.scenario, scenarioType: "SYNTHETIC_ESTIMATE" as const, ...profile.usage, estimatedCostMicros: cost.estimatedCostMicros, pricingCatalogVersion: cost.pricingCatalogVersion, usageQuality: cost.quality };
  });
}
