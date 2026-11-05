import { estimateAnalysisTokens } from "@ai-cognitive/book-intelligence";

/** Budget the exact serialized payload, retaining whole evidence and every selected source. */
export function boundVideoContext<T extends { source: { sourceDocumentId: string } }>(
  candidates: T[],
  envelope: Record<string, unknown>,
  budget: number,
): T[] {
  const tokens = (context: T[]) => estimateAnalysisTokens(JSON.stringify({ ...envelope, context }));
  const groups = new Map<string, T[]>();
  for (const item of candidates) {
    const key = item.source.sourceDocumentId;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  if (!groups.size) throw new Error("SHORT_VIDEO_CONTEXT_BUDGET_VIOLATION");
  const ranked = [...groups.values()];
  // Reserve the smallest complete item from each remaining source before spending on relevance.
  const smallest = ranked.map(items => items.reduce((best, item) =>
    tokens([item]) < tokens([best]) ? item : best));
  if (tokens(smallest) > budget) throw new Error("SHORT_VIDEO_PROVIDER_INPUT_BUDGET_EXCEEDED");
  const selected: T[] = [];
  for (let i = 0; i < ranked.length; i++) {
    const item = ranked[i]!.find(candidate => tokens([...selected, candidate, ...smallest.slice(i + 1)]) <= budget);
    if (!item) throw new Error("SHORT_VIDEO_PROVIDER_INPUT_BUDGET_EXCEEDED");
    selected.push(item);
  }
  for (const candidate of candidates) {
    if (!selected.includes(candidate) && tokens([...selected, candidate]) <= budget) selected.push(candidate);
  }
  // Preserve retrieval order so retries produce the same provider request fingerprint.
  return candidates.filter(item => selected.includes(item));
}
