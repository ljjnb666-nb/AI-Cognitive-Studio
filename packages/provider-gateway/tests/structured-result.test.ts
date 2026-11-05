import { describe, expect, it } from "vitest";
import { validateTextGenerationResponse } from "../src/text/result-validation.js";
describe("structured result JSON safety", () => {
  it("accepts shared evidence references that serialize as ordinary JSON", () => {
    const evidence = [{ sourceBlockId: "block", startOffset: 0, endOffset: 5 }];
    const result = { type: "STRUCTURED", structured: { memory: [{ evidence }, { evidence }] } };
    expect(validateTextGenerationResponse(result)).toBe(result);
    expect(validateTextGenerationResponse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });
  it("still rejects direct and indirect cycles", () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => validateTextGenerationResponse({ type: "STRUCTURED", structured: cyclic })).toThrow("Invalid text generation response");
    const root: unknown[] = [], child = { root }; root.push(child);
    expect(() => validateTextGenerationResponse({ type: "STRUCTURED", structured: root })).toThrow("Invalid text generation response");
  });
  it("rejects non-JSON values and non-finite numbers", () => {
    for (const value of [undefined, NaN, Infinity, () => 1, new Date()]) expect(() => validateTextGenerationResponse({ type: "STRUCTURED", structured: { value } })).toThrow("Invalid text generation response");
  });
});
