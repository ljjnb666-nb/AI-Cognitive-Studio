import { describe, expect, it } from "vitest";
import { buildBenchmarkResult, parseBenchmarkResult, parseNormalizedOutput, SchemaValidationError } from "../src/schema.js";

const validNormalized = {
  parser: { name: "unit-parser", version: "1.0.0" },
  fixtureId: "F1-native-cn",
  readingOrderAvailable: true,
  pages: [
    {
      pageIndex: 0,
      printedPageLabel: null,
      blocks: [
        { kind: "heading", text: "标题", pageIndex: 0, bbox: null, confidence: null, sourceMethod: "native-text" },
        { kind: "paragraph", text: "正文内容", pageIndex: 0, bbox: { x0: 1, y0: 2, x1: 3, y1: 4 }, confidence: null, sourceMethod: "native-text" },
      ],
    },
  ],
};

const validResultSkeleton = {
  run: { id: "r1", startedAt: "2026-09-19T00:00:00Z", finishedAt: "2026-09-19T00:00:01Z", coldStart: true },
  parser: { name: "unit-parser", version: "1.0.0" },
  document: { fixtureId: "F1-native-cn", inputSha256: "a".repeat(64), bytes: 1234, detectedPages: 1 },
  performance: { wallTimeMs: 5, cpuTimeMs: null, peakRssMb: null, peakGpuMb: null },
  reliability: { exitCode: 0, timeout: false, crashed: false, oom: false, partialOutput: false, warnings: [] },
  normalized: validNormalized,
};

describe("benchmark result schema", () => {
  it("accepts a valid normalized output and derived result", () => {
    expect(() => parseNormalizedOutput(validNormalized)).not.toThrow();
    const result = buildBenchmarkResult(validResultSkeleton);
    expect(() => parseBenchmarkResult(result)).not.toThrow();
    expect(result.extraction.characters).toBe(6);
    expect(result.extraction.headings).toBe(1);
    expect(result.evidence.bbox).toBe(true);
    expect(result.evidence.confidence).toBe(false);
  });

  it("rejects NaN and Infinity anywhere in the tree", () => {
    const infected = structuredClone(validNormalized);
    const bbox = infected.pages[0]!.blocks[1]!.bbox as { x1: number };
    bbox.x1 = Number.NaN;
    expect(() => parseNormalizedOutput(infected)).toThrow(SchemaValidationError);
  });

  it("rejects negative page indexes", () => {
    const infected = structuredClone(validNormalized);
    infected.pages[0]!.pageIndex = -1;
    expect(() => parseNormalizedOutput(infected)).toThrow(SchemaValidationError);
  });

  it("keeps unsupported capabilities null instead of fabricated zero", () => {
    const result = buildBenchmarkResult(validResultSkeleton);
    expect(result.extraction.tables).toBeNull();
    expect(result.extraction.figures).toBeNull();
    expect(result.extraction.ocrPages).toBeNull();
  });

  it("rejects non-object garbage", () => {
    expect(() => parseNormalizedOutput("not an object")).toThrow(SchemaValidationError);
  });
});
