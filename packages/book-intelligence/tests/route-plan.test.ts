import { describe, expect, it } from "vitest";
import { bookRoutePlanHash, fullBookRoutePlanHash, normalizeBookRoutePlan, type BookAnalysisRoutePlan } from "../src/index.js";

const entry = (modelId: string, extra: Record<string, unknown> = {}) => ({ providerKey: "fixture", protocol: "OPENAI_COMPATIBLE", modelId, configuration: { region: "test", ...extra }, configurationHash: "a".repeat(64), connectionId: "connection", credentialVersionId: "credential", endpoint: "https://provider.example.test/v1", adapterVersion: "fixture-v1" });
const plan = (): BookAnalysisRoutePlan => ({ version: 1, routes: {
  BOOK_CHUNK_ANALYSIS: { ...entry("chunk"), structuredOutput: "JSON_MODE" },
  BOOK_REDUCTION_ANALYSIS: { ...entry("reduction"), structuredOutput: "STRICT_JSON_SCHEMA" },
  BOOK_SYNTHESIS: { ...entry("synthesis"), structuredOutput: "JSON_MODE" },
  EMBEDDING: { ...entry("embedding", { embeddingDimensions: 768 }), dimensions: 768 },
} });

describe("Book route plan", () => {
  it("hashes all four result-semantic bindings canonically", () => {
    const first = plan(), reordered = structuredClone(first);
    reordered.routes.EMBEDDING.configuration = { embeddingDimensions: 768, region: "test" };
    expect(bookRoutePlanHash(first)).toBe(bookRoutePlanHash(reordered));
    const changed = plan(); changed.routes.BOOK_SYNTHESIS.modelId = "synthesis-v2";
    expect(bookRoutePlanHash(changed)).not.toBe(bookRoutePlanHash(first));
  });
  it("keeps credential and connection rotation out of semantic identity while sealing full execution locators", () => {
    const baseline = normalizeBookRoutePlan(plan());
    const rotated = structuredClone(baseline);
    rotated.routes.BOOK_CHUNK_ANALYSIS.connectionId = "connection-rotated";
    rotated.routes.BOOK_CHUNK_ANALYSIS.credentialVersionId = "credential-rotated";
    expect(bookRoutePlanHash(rotated)).toBe(bookRoutePlanHash(baseline));
    expect(fullBookRoutePlanHash(rotated)).not.toBe(baseline.integrityHash);
    expect(() => normalizeBookRoutePlan(rotated)).toThrow("BOOK_ROUTE_PLAN_INTEGRITY_FAILED");
  });
  it("changes semantic identity for model, version, configuration, output and embedding dimensions", () => {
    const baseline = bookRoutePlanHash(plan());
    for (const mutate of [
      (value: BookAnalysisRoutePlan) => { value.routes.BOOK_CHUNK_ANALYSIS.providerKey = "other"; },
      (value: BookAnalysisRoutePlan) => { value.routes.BOOK_CHUNK_ANALYSIS.modelId = "other"; },
      (value: BookAnalysisRoutePlan) => { value.routes.BOOK_CHUNK_ANALYSIS.modelVersion = "v2"; },
      (value: BookAnalysisRoutePlan) => { value.routes.BOOK_CHUNK_ANALYSIS.configuration = { region: "other" }; },
      (value: BookAnalysisRoutePlan) => { value.routes.BOOK_CHUNK_ANALYSIS.structuredOutput = "STRICT_JSON_SCHEMA"; },
      (value: BookAnalysisRoutePlan) => { value.routes.EMBEDDING.dimensions = 1024; },
    ]) { const changed = plan(); mutate(changed); expect(bookRoutePlanHash(changed)).not.toBe(baseline); }
  });
  it("changes whenever any independently pinned route changes", () => {
    const baseline = bookRoutePlanHash(plan());
    for (const slot of ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS", "EMBEDDING"] as const) {
      const changed = plan();
      changed.routes[slot].modelId = `${changed.routes[slot].modelId}-v2`;
      expect(bookRoutePlanHash(changed)).not.toBe(baseline);
    }
  });
  it("rejects incomplete or non-pinned durable route data", () => {
    const invalid = plan(); invalid.routes.EMBEDDING.credentialVersionId = "";
    expect(() => normalizeBookRoutePlan(invalid)).toThrow("BOOK_ROUTE_PLAN_INVALID");
  });
});
