import { describe, expect, it } from "vitest";
import {
  classifyProductIdentifierForPromotion,
  isPromotableProductLanguage,
  normalizeIsbnForComparison,
  normalizeProductIdentityTitleForComparison,
} from "../src/product-identity-promotion.js";

describe("controlled product identity promotion helpers", () => {
  it("normalizes titles only for comparison", () => {
    expect(normalizeProductIdentityTitleForComparison("  Ａ   Book\nTitle ")).toBe("A Book Title");
  });

  it.each(["en", "zh-CN", "sr-Latn-RS"])("accepts conservative BCP47-like languages: %s", (value) => {
    expect(isPromotableProductLanguage(value)).toBe(true);
  });

  it.each(["", "english language", "zh_CN", "x", "a".repeat(65)])("rejects unsafe language promotion: %s", (value) => {
    expect(isPromotableProductLanguage(value)).toBe(false);
  });

  it("promotes only explicitly marked, checksum-valid ISBN values", () => {
    expect(classifyProductIdentifierForPromotion("urn:isbn:978-0-306-40615-7")).toEqual({ kind: "ISBN13", value: "9780306406157" });
    expect(classifyProductIdentifierForPromotion("ISBN 0-306-40615-2")).toEqual({ kind: "ISBN10", value: "0306406152" });
  });

  it("never infers ISBN from bare digits and rejects invalid explicit ISBN", () => {
    expect(classifyProductIdentifierForPromotion("9780306406157")).toEqual({ kind: "UNCLASSIFIED" });
    expect(classifyProductIdentifierForPromotion("urn:isbn:9780306406158")).toEqual({ kind: "INVALID_EXPLICIT_ISBN" });
    // Valid EAN-13 checksum, but not an ISBN Bookland 978/979 prefix.
    expect(classifyProductIdentifierForPromotion("ISBN: 1234567890128")).toEqual({ kind: "INVALID_EXPLICIT_ISBN" });
  });

  it("normalizes only conventional ISBN presentation separators for comparison", () => {
    expect(normalizeIsbnForComparison("978-0-306-40615-7")).toBe("9780306406157");
    expect(normalizeIsbnForComparison("0 306 40615 x")).toBe("030640615X");
  });
});
