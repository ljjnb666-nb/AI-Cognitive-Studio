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
    await expect(guardedGenerateStructured(provider, request, [], 2048)).rejects.toThrow("ANALYSIS_RELATION_INVALID");
  });
});
