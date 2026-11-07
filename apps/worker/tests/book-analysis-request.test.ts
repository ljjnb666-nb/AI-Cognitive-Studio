import { describe, expect, it } from "vitest";
import { bookAnalysisMessage, bookAnalysisSpanReferenceInstruction, bookAnalysisSpanReferenceVersion, resolveBookAnalysisSpanReferences } from "../src/book-analysis-request.js";
describe("lossless bounded Book request", () => {
  const spans = [{ sourceBlockId: "actual-block", startOffset: 9, endOffset: 13, text: "事实一。" }, { sourceBlockId: "actual-block-2", startOffset: 0, endOffset: 4, text: "观点二。" }];
  it("sends complete source once and preserves ordered IDs and exact offsets", () => {
    const content = spans.map(s => s.text).join("\n\n");
    const wire = bookAnalysisMessage({ content, sourceSlices: spans });
    expect(JSON.parse(wire)).toEqual({ sourceSlices: spans });
    expect(wire.match(/事实一。/g)).toHaveLength(1);
    expect(JSON.parse(wire).sourceSlices.map((s: { text: string }) => s.text).join("\n\n")).toBe(content);
  });
  it("never discards content absent from evidence", () => {
    expect(JSON.parse(bookAnalysisMessage({ content: "重要的限定条件", sourceSlices: spans }))).toEqual({ content: "重要的限定条件", sourceSlices: spans });
  });
  it("preserves derived summaries with no source evidence", () => { expect(bookAnalysisMessage({ content: "章节综合" })).toBe("章节综合"); });
});

describe("version-pinned spanIndex citations (v3)", () => {
  const spans = [
    { sourceBlockId: "long-real-id", startOffset: 40, endOffset: 46, text: "中文😀事实" },
    { sourceBlockId: "partial", startOffset: 0, endOffset: 13, text: "abcdefghijklm" },
  ];
  const raw = (evidence: unknown, type = "CLAIM") => ({
    summary: "grounded", memory: [{ type, content: type === "QUOTE" ? "😀" : "fact", evidence: [evidence] }],
  });
  it("keeps v2 unchanged, and sends v3 source text exactly once with no IDs or raw offsets", () => {
    const content = spans.map(s => s.text).join("\n\n");
    const old = JSON.parse(bookAnalysisMessage({ content, sourceSlices: spans }));
    expect(old.sourceSlices).toEqual(spans);
    const wire = bookAnalysisMessage({ content, sourceSlices: spans }, true);
    expect(JSON.parse(wire)).toEqual({ sourceSlices: spans.map((s, spanIndex) => ({ spanIndex, text: s.text })) });
    expect(wire.match(/中文😀事实/g)).toHaveLength(1);
    expect(wire).not.toContain("long-real-id");
    expect(wire).not.toContain("startOffset");
    expect(bookAnalysisSpanReferenceVersion).toBe("book-evidence-span-v3");
    expect(bookAnalysisSpanReferenceInstruction(2)).toContain("0 through 1");
  });
  it("resolves full non-QUOTE source tuple without mutating raw result", () => {
    const value = raw({ spanIndex: 1 });
    const copy = JSON.stringify(value);
    expect(resolveBookAnalysisSpanReferences(value, spans)).toMatchObject({
      memory: [{ evidence: [{ sourceBlockId: "partial", startOffset: 0, endOffset: 13 }] }],
    });
    expect(JSON.stringify(value)).toBe(copy);
  });
  it("resolves a unique UTF-16 direct quote to original absolute offsets", () => {
    expect(resolveBookAnalysisSpanReferences(raw({ spanIndex: 0, quoteText: "😀" }, "QUOTE"), spans)).toMatchObject({
      memory: [{ evidence: [{ sourceBlockId: "long-real-id", startOffset: 42, endOffset: 44, quoteText: "😀" }] }],
    });
  });
  it.each([-1, 2, 1.5, "0", null, Number.MAX_SAFE_INTEGER + 1])(
    "fails closed for invalid spanIndex %s", spanIndex => {
      expect(() => resolveBookAnalysisSpanReferences(raw({ spanIndex }), spans)).toThrow("CHUNK_EVIDENCE_INVALID");
    },
  );
  it("never silently repairs forged IDs, mixed fields or a legacy v2 response", () => {
    expect(() => resolveBookAnalysisSpanReferences(raw({ sourceBlockId: "typo", startOffset: 40, endOffset: 46 }), spans)).toThrow("CHUNK_EVIDENCE_INVALID");
    expect(() => resolveBookAnalysisSpanReferences(raw({ spanIndex: 0, endOffset: 999 }), spans)).toThrow("CHUNK_EVIDENCE_INVALID");
    expect(() => resolveBookAnalysisSpanReferences(raw({ spanIndex: 1, quoteText: "abc" }), spans)).toThrow("CHUNK_EVIDENCE_INVALID");
  });
  it("rejects fabricated, ambiguous or unmatching direct quotations", () => {
    expect(() => resolveBookAnalysisSpanReferences(raw({ spanIndex: 0, quoteText: "not in source" }, "QUOTE"), spans)).toThrow("INVALID_DIRECT_QUOTE");
    expect(() => resolveBookAnalysisSpanReferences(raw({ spanIndex: 1, quoteText: "a" }, "QUOTE"), [{...spans[0]!,text:"aa"}, {...spans[1]!,text:"aa"}])).toThrow("INVALID_DIRECT_QUOTE");
    expect(() => resolveBookAnalysisSpanReferences({ summary: "x", memory: [{ type: "QUOTE", content: "not the original", evidence: [{ spanIndex: 0, quoteText: "😀" }] }] }, spans)).toThrow("INVALID_DIRECT_QUOTE");
  });
  it("does not drop the seventh memory or accept ungrounded entries", () => {
    const item = raw({ spanIndex: 0 }).memory[0]!;
    const seven = { summary: "x", memory: Array.from({ length: 7 }, () => item) };
    expect(() => resolveBookAnalysisSpanReferences(seven, spans)).toThrow("CHUNK_MEMORY_QUALITY_FAILED");
    expect(seven.memory).toHaveLength(7);
    expect(() => resolveBookAnalysisSpanReferences({ summary: "x", memory: [] }, spans)).toThrow("CHUNK_MEMORY_QUALITY_FAILED");
    expect(() => resolveBookAnalysisSpanReferences({ summary: "x", memory: [{ type: "CLAIM", content: "no source" }] }, spans)).toThrow("CHUNK_EVIDENCE_INVALID");
  });
  it("requires server-side slices for opted-in wire format", () => {
    expect(() => bookAnalysisMessage({ content: "x" }, true)).toThrow("ANALYSIS_SOURCE_SLICE_INVALID");
  });
});
