import { describe, expect, it } from "vitest";
import { splitCanonicalBlock } from "../src/canonical-text.js";

describe("splitCanonicalBlock", () => {
  it("splits deterministically without separating a surrogate pair", () => {
    const value = `${"中".repeat(3)}😀${"a".repeat(8)}`;
    const chunks = splitCanonicalBlock(value, 5);
    expect(chunks.join("")).toBe(value);
    expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
  });
});
