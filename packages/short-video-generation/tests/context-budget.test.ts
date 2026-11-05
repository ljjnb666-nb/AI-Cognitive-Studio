import { describe, expect, it } from "vitest";
import { estimateAnalysisTokens } from "@ai-cognitive/book-intelligence";
import { boundVideoContext } from "../src/context-budget.js";
const item = (source: string, size: number) => ({ source: { sourceDocumentId: source }, content: "x".repeat(size), evidence: [{ sourceBlockId: source, startOffset: 0, endOffset: 20, quoteText: "e".repeat(20) }] });
const cost = (context: unknown[], envelope = {}) => estimateAnalysisTokens(JSON.stringify({ ...envelope, context }));
describe("serialized video context budgeting", () => {
  it("counts evidence and the style/plan envelope, retaining complete items", () => {
    const candidates = [item("a", 150), item("a", 140), item("a", 130)];
    const envelope = { plan: "p".repeat(300) };
    const budget = cost([candidates[0]], envelope);
    const result = boundVideoContext(candidates, envelope, budget);
    expect(result).toEqual([candidates[0]]);
    expect(result[0]).toBe(candidates[0]);
    expect(cost(result, envelope)).toBeLessThanOrEqual(budget);
  });
  it("reserves space for every source instead of starving later sources", () => {
    const candidates = [item("a", 800), item("a", 40), item("b", 60)];
    const budget = cost(candidates.slice(1));
    expect(boundVideoContext(candidates, {}, budget)).toEqual(candidates.slice(1));
  });
  it("skips oversized items without truncating quotes or offsets", () => {
    const candidates = [item("a", 1000), item("a", 20)];
    expect(boundVideoContext(candidates, {}, cost([candidates[1]]))).toEqual([candidates[1]]);
  });
  it("fails closed when no complete multi-source payload fits", () => {
    expect(() => boundVideoContext([item("a", 100), item("b", 100)], {}, 1)).toThrow("SHORT_VIDEO_PROVIDER_INPUT_BUDGET_EXCEEDED");
    expect(() => boundVideoContext([], {}, 4000)).toThrow("SHORT_VIDEO_CONTEXT_BUDGET_VIOLATION");
  });
  it("is deterministic and preserves the ranked order", () => {
    const candidates = [item("a", 20), item("b", 20), item("a", 30)];
    expect(boundVideoContext(candidates, {}, cost(candidates))).toEqual(candidates);
    expect(boundVideoContext(candidates, {}, cost(candidates))).toEqual(boundVideoContext(candidates, {}, cost(candidates)));
  });
});
