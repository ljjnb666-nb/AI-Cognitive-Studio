import { describe, expect, it } from "vitest";
import {
  assertAnalysisRelationsWithinMemory,
  bookAnalysisRelationsContractVersion,
  bookAnalysisRelationsInstruction,
  estimateAnalysisTokens,
  guardedGenerateStructured,
  type AnalysisProvider,
  type AnalysisRequest,
  type AnalysisResponse,
} from "../src/analysis.js";

const six = Array.from({ length: 6 }, (_, i) => ({ type: "CLAIM" as const, content: `claim-${i}` }));
const relation = (fromOrdinal: number, toOrdinal: number) => ({
  fromOrdinal, toOrdinal, type: "SUPPORTS" as const,
});
describe("fresh Book relation contract", () => {
  it("pins the zero-based contract identity and clarifies six-memory indices", () => {
    expect(bookAnalysisRelationsContractVersion).toBe("book-relations-zero-based-v1");
    expect(bookAnalysisRelationsInstruction).toContain("0,1,2,3,4,5");
  });
  it("accepts first and last indices of the response memory array", () => {
    expect(() => assertAnalysisRelationsWithinMemory({ memory: six, relations: [relation(0, 5), relation(5, 0)] })).not.toThrow();
    expect(() => assertAnalysisRelationsWithinMemory({ memory: [], relations: [] })).not.toThrow();
  });
  it.each([[-1, 0], [0, 6], [6, 0], [1.5, 0], [0, Number.MAX_SAFE_INTEGER + 1]])(
    "rejects out-of-range and non-safe indices %s -> %s",
    (fromOrdinal, toOrdinal) => {
      expect(() => assertAnalysisRelationsWithinMemory({ memory: six, relations: [relation(fromOrdinal, toOrdinal)] })).toThrow("ANALYSIS_RELATION_INVALID");
    },
  );
  it("rejects relations when no memory was returned", () => {
    expect(() => assertAnalysisRelationsWithinMemory({ relations: [relation(0, 0)] })).toThrow("ANALYSIS_RELATION_INVALID");
  });
  it("rejects an invalid fresh provider result before it can be persisted", async () => {
    const request: AnalysisRequest = {
      stage: "SECTION", content: "derived evidence summary", sourceBlockIds: [],
      correlationId: "relation-test", tokenBudget: estimateAnalysisTokens("derived evidence summary"),
      systemInstructions: "Only return grounded structured results.",
    };
    const provider: AnalysisProvider = {
      async generateStructured(): Promise<AnalysisResponse> {
        return { summary: "bounded summary", memory: six, relations: [relation(0, 6)] };
      },
    };
    const source = [{ id: "original-source", ordinal: 0, kind: "PARAGRAPH" as const, text: "Original material, not the derived parent summary." }];
    await expect(guardedGenerateStructured(provider, request, source, 2048)).rejects.toThrow("ANALYSIS_RELATION_INVALID");
  });
});


describe("sourceSlices provenance bounds in new Book CHUNK outputs", () => {
  const slices = [
    { sourceBlockId: "s1", startOffset: 5, endOffset: 10, text: "abcde" },
    { sourceBlockId: "s1", startOffset: 13, endOffset: 18, text: "vwxyz" },
  ];
  const make = (sourceBlockId: string, startOffset: number, endOffset: number, quoteText?: string) => ({
    summary: "bounded", memory: [{
      type: "CLAIM" as const, content: "grounded statement",
      evidence: [{ sourceBlockId, startOffset, endOffset, ...(quoteText ? { quoteText } : {}) }],
    }],
  });
  it("accepts exact and internal ranges without changing the original values", async () => {
    const { assertAnalysisEvidenceWithinRequest } = await import("../src/analysis.js");
    const response = make("s1", 6, 9, "bcd");
    const before = JSON.stringify(response);
    expect(() => assertAnalysisEvidenceWithinRequest(response, { stage: "CHUNK", sourceSlices: slices })).not.toThrow();
    expect(JSON.stringify(response)).toBe(before);
  });
  it.each([
    ["s1", 5, 18], ["s1", 10, 13], ["s1", 4, 6],
    ["s1", 17, 19], ["other", 5, 10], ["s1", 8, 8],
  ])("rejects a crossing, missing or out-of-scope span %s:%i-%i", async (id, start, end) => {
    const { assertAnalysisEvidenceWithinRequest } = await import("../src/analysis.js");
    expect(() => assertAnalysisEvidenceWithinRequest(make(id, start, end), { stage: "CHUNK", sourceSlices: slices })).toThrow("CHUNK_EVIDENCE_INVALID");
  });
  it("rejects a forged quote even when the coordinates fall inside a real slice", async () => {
    const { assertAnalysisEvidenceWithinRequest } = await import("../src/analysis.js");
    expect(() => assertAnalysisEvidenceWithinRequest(make("s1", 6, 9, "xxx"), { stage: "CHUNK", sourceSlices: slices })).toThrow("CHUNK_EVIDENCE_INVALID");
  });
  it("permits derived BOOK stages without a source slice assertion", async () => {
    const { assertAnalysisEvidenceWithinRequest } = await import("../src/analysis.js");
    expect(() => assertAnalysisEvidenceWithinRequest(make("other", 100, 200), { stage: "BOOK" })).not.toThrow();
  });
  it("rejects mixed valid and forged citations before exposing the generated chunk", async () => {
    const { assertAnalysisEvidenceWithinRequest } = await import("../src/analysis.js");
    const response = make("s1", 5, 10);
    response.memory[0]!.evidence.push({ sourceBlockId: "s1", startOffset: 0, endOffset: 18 });
    expect(() => assertAnalysisEvidenceWithinRequest(response, { stage: "CHUNK", sourceSlices: slices })).toThrow("CHUNK_EVIDENCE_INVALID");
  });
});
