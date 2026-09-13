import { describe, expect, it } from "vitest";
import { isBookAnalysisIdentityUniqueViolation } from "../src/pipeline.js";

describe("BookAnalysis request create-race classification", () => {
  it("does not classify a non-unique failure as an identity race", () => {
    expect(isBookAnalysisIdentityUniqueViolation({ code: "P2003", meta: { field_name: "BookAnalysisRun_jobId_fkey" } })).toBe(false);
  });

  it("classifies only the durable analysisIdentityHash unique collision", () => {
    expect(isBookAnalysisIdentityUniqueViolation({ code: "P2002", meta: { target: ["analysisIdentityHash"] } })).toBe(true);
    expect(isBookAnalysisIdentityUniqueViolation({ code: "P2002", meta: { target: "BookAnalysisRun_analysisIdentityHash_key" } })).toBe(true);
  });

  it("does not classify another unique constraint as the analysis identity race", () => {
    expect(isBookAnalysisIdentityUniqueViolation({ code: "P2002", meta: { target: ["idempotencyKey"] } })).toBe(false);
  });
});
