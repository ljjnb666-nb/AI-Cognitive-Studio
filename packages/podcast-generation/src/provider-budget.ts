import { estimateAnalysisTokens } from "@ai-cognitive/book-intelligence";

export const PODCAST_PROVIDER_INPUT_BUDGETS = { EPISODE_PLANNING: 20_000, NARRATIVE_DESIGN: 12_000, SEGMENT_OUTLINE: 16_000, SEGMENT_DRAFTING: 20_000, HUMANIZATION: 16_000 } as const;
export function estimatePodcastProviderInputTokens(input: unknown): number { return estimateAnalysisTokens(JSON.stringify(input)); }
export function assertPodcastProviderInputBudget(input: unknown, tokenBudget: number): void { if (estimatePodcastProviderInputTokens(input) > tokenBudget) throw new Error("PODCAST_PROVIDER_INPUT_BUDGET_EXCEEDED"); }
