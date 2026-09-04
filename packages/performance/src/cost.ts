import { findPricing, type ProviderPricingCatalog, type ProviderUsageForCost } from "./pricing.js";
export type CostQuality = "ACTUAL_PROVIDER_USAGE" | "LOCAL_DETERMINISTIC_ESTIMATE" | "MISSING_USAGE" | "UNPRICED" | "INVALID_METERING";
export type CostResult = { estimatedCostMicros: bigint | null; quality: CostQuality; pricingCatalogVersion: string; reasons: readonly string[] };
const million = 1_000_000n;
function price(amount: number, rate: bigint | undefined): bigint | undefined { return rate === undefined ? undefined : BigInt(amount) * rate / million; }
export function estimateProviderCost(catalog: ProviderPricingCatalog, usage: ProviderUsageForCost): CostResult {
  const entry = findPricing(catalog, usage); if (!entry) return { estimatedCostMicros: null, quality: "UNPRICED", pricingCatalogVersion: catalog.version, reasons: ["PRICING_ENTRY_NOT_FOUND"] };
  const values = [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, usage.embeddingInputTokens, usage.speechInputCharacters, usage.audioDurationMs].filter(value => value !== undefined && value !== null);
  if (!values.length) return { estimatedCostMicros: null, quality: "MISSING_USAGE", pricingCatalogVersion: catalog.version, reasons: ["NO_METERED_USAGE"] };
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) return { estimatedCostMicros: null, quality: "INVALID_METERING", pricingCatalogVersion: catalog.version, reasons: ["INVALID_USAGE_VALUE"] };
  const input = usage.inputTokens ?? 0, cached = usage.cachedInputTokens ?? 0;
  if (cached > input) return { estimatedCostMicros: null, quality: "INVALID_METERING", pricingCatalogVersion: catalog.version, reasons: ["CACHED_INPUT_EXCEEDS_INPUT"] };
  const lines: Array<bigint | undefined> = [];
  if (input - cached) lines.push(price(input - cached, entry.inputMicrosPerMillion));
  if (cached) lines.push(price(cached, entry.cachedInputMicrosPerMillion));
  if (usage.outputTokens) lines.push(price(usage.outputTokens, entry.outputMicrosPerMillion));
  if (usage.embeddingInputTokens) lines.push(price(usage.embeddingInputTokens, entry.embeddingMicrosPerMillion));
  if (usage.speechInputCharacters) lines.push(entry.unit === "CHARACTERS" ? price(usage.speechInputCharacters, entry.speechMicrosPerMillion) : undefined);
  if (usage.audioDurationMs) lines.push(entry.unit === "AUDIO_DURATION" ? price(usage.audioDurationMs, entry.speechMicrosPerMillion) : undefined);
  if (lines.some(line => line === undefined)) return { estimatedCostMicros: null, quality: "UNPRICED", pricingCatalogVersion: catalog.version, reasons: ["PRICING_UNIT_NOT_COVERED"] };
  return { estimatedCostMicros: lines.reduce<bigint>((sum, line) => sum + (line ?? 0n), 0n), quality: usage.usageQuality ?? "ACTUAL_PROVIDER_USAGE", pricingCatalogVersion: catalog.version, reasons: [] };
}
