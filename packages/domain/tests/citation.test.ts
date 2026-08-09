import { describe, expect, it } from "vitest";
import { buildSourceSpan, sha256Utf8, validateSourceSpan } from "../src/citation.js";

describe("citation protocol", () => {
  it("uses UTF-16 code-unit offsets for ASCII, Chinese, emoji, and combining marks", () => {
    expect(validateSourceSpan("abcdef", 1, 4, "bcd")).toBe(true);
    expect(validateSourceSpan("人工智能改变世界", 2, 4, "智能")).toBe(true);
    const emojiText = "A🤖B";
    expect(emojiText.length).toBe(4);
    expect(emojiText.slice(1, 3)).toBe("🤖");
    expect(validateSourceSpan(emojiText, 1, 3, "🤖")).toBe(true);
    expect(validateSourceSpan(emojiText, 1, 2, "🤖")).toBe(false);
    const combiningText = "Cafe\u0301";
    expect(combiningText).toBe("Cafe\u0301");
    expect(combiningText).not.toBe("Café");
    expect(validateSourceSpan(combiningText, 3, 5, "e\u0301")).toBe(true);
  });

  it("rejects invalid offsets and mismatched quotes", () => {
    expect(validateSourceSpan("abcdef", -1, 2, "ab")).toBe(false);
    expect(validateSourceSpan("abcdef", 2, 2, "")).toBe(false);
    expect(validateSourceSpan("abcdef", 4, 2, "")).toBe(false);
    expect(validateSourceSpan("abcdef", 0, 7, "abcdef")).toBe(false);
    expect(validateSourceSpan("abcdef", 1.5, 3, "bc")).toBe(false);
    expect(validateSourceSpan("abcdef", 1, 3, "zz")).toBe(false);
  });

  it("derives quoteText and lowercase UTF-8 SHA-256 quoteHash", () => {
    const span = buildSourceSpan("A🤖B", 1, 3);
    expect(span).toEqual({
      startOffset: 1,
      endOffset: 3,
      quoteText: "🤖",
      quoteHash: "b0d125182029e6c500cbcc81011341df77de8fe24d9e80190c32be390c916ec2",
    });
    expect(span.quoteHash).toBe(sha256Utf8(span.quoteText));
    expect(() => buildSourceSpan("abcdef", 2, 2)).toThrow("INVALID_SOURCE_SPAN");
  });
});
