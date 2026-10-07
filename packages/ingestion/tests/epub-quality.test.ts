import { describe, expect, it } from "vitest";
import { evaluateEpubExtractionQuality } from "../src/epub-quality.js";

describe("EPUB extraction quality authority", () => {
  it("accepts usable canonical content with no warnings", () => {
    expect(evaluateEpubExtractionQuality(3, [])).toEqual({ status: "ACCEPTED", reasonCodes: [], qualityWarnings: [] });
  });

  it.each([
    ["TABLE_FLATTENED"],
    ["PARTIAL_EXTRACTION"],
    ["EPUB_NAVIGATION_DEGRADED"],
    ["EPUB_FIXED_LAYOUT"],
  ] as const)("degrades warned usable content: %j", (...warnings) => {
    expect(evaluateEpubExtractionQuality(2, warnings)).toEqual({
      status: "DEGRADED",
      reasonCodes: ["QUALITY_WARNING_PRESENT"],
      qualityWarnings: [...warnings],
    });
  });

  it("rejects zero usable canonical blocks defensively", () => {
    expect(evaluateEpubExtractionQuality(0, ["PARTIAL_EXTRACTION"])).toEqual({
      status: "REJECTED",
      reasonCodes: ["NO_USABLE_CONTENT"],
      qualityWarnings: ["PARTIAL_EXTRACTION"],
    });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid block counts: %s", (count) => {
    expect(() => evaluateEpubExtractionQuality(count, [])).toThrow(RangeError);
  });
});
