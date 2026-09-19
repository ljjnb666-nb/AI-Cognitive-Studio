import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { assertAllowed, assertFixturePath, DATA_ROOT, InvalidOutputPathError, validateNormalizedPayloadShape } from "../src/filesystem-guard.js";

describe("filesystem guard", () => {
  it("accepts paths inside the allowlist roots", () => {
    expect(() => assertAllowed(join(DATA_ROOT, "temp", "x"))).not.toThrow();
    expect(() => assertAllowed(join(DATA_ROOT, "outputs", "x.json"))).not.toThrow();
  });

  it("rejects traversal outside the data root", () => {
    expect(() => assertAllowed("D:\\ai-cognitive-pdf-benchmark-data\\..\\escape.txt")).toThrow(InvalidOutputPathError);
    expect(() => assertAllowed("C:\\Windows\\system32\\config")).toThrow(InvalidOutputPathError);
    expect(() => assertAllowed("D:\\ai-cognitive-pdf-benchmark-data-evil\\x")).toThrow(InvalidOutputPathError);
  });

  it("rejects non-pdf fixture inputs", () => {
    expect(() => assertFixturePath("D:\\ai-cognitive-pdf-benchmark-data\\fixtures\\notes.txt")).toThrow(InvalidOutputPathError);
  });

  it("rejects absurd payload shapes", () => {
    expect(() => validateNormalizedPayloadShape({})).toThrow(InvalidOutputPathError);
    const oversized = { pages: [{ blocks: new Array(20_001).fill(0) }] };
    expect(() => validateNormalizedPayloadShape(oversized as unknown as { pages?: Array<{ blocks?: unknown[] }> })).toThrow(InvalidOutputPathError);
  });
});
