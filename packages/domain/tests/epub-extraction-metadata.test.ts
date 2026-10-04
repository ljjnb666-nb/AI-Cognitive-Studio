import { describe, expect, it } from "vitest";
import { EXTRACTION_QUALITY_WARNING_CODES, epubExtractionMetadataSchema, parseEpubExtractionMetadata, tryParseEpubExtractionMetadata } from "../src/index.js";

const validNavigation = [
  { ordinal: 0, depth: 0, label: "Chapter One", href: "OEBPS/text/ch1.xhtml", fragmentId: null },
  { ordinal: 1, depth: 1, label: "Section 2", href: "OEBPS/text/ch1.xhtml", fragmentId: "section-2" },
];

const validMetadata = {
  kind: "epub" as const,
  epubVersion: "3.0",
  packagePath: "OEBPS/content.opf",
  renditionLayout: "REFLOWABLE" as const,
  spineItemCount: 3,
  navigationSource: "EPUB3_NAV" as const,
  navigation: validNavigation,
  dcTitle: "Test Book",
  dcLanguage: "en",
  dcIdentifier: "urn:uuid:1234",
};

describe("epub extraction metadata contract", () => {
  it("accepts valid metadata and preserves optional package descriptors", () => {
    expect(parseEpubExtractionMetadata(validMetadata)).toEqual(validMetadata);
  });

  it("accepts NONE navigation only with an empty list", () => {
    expect(epubExtractionMetadataSchema.parse({ ...validMetadata, navigationSource: "NONE", navigation: [] }).navigationSource).toBe("NONE");
    expect(epubExtractionMetadataSchema.safeParse({ ...validMetadata, navigationSource: "NONE", navigation: validNavigation }).success).toBe(false);
    expect(epubExtractionMetadataSchema.safeParse({ ...validMetadata, navigationSource: "EPUB2_NCX", navigation: [] }).success).toBe(false);
  });

  it("requires contiguous navigation ordinals starting at zero", () => {
    expect(() => parseEpubExtractionMetadata({ ...validMetadata, navigation: [validNavigation[1]!] })).toThrow();
    const shifted = [{ ...validNavigation[0]!, ordinal: 1 }, validNavigation[1]!];
    expect(epubExtractionMetadataSchema.safeParse({ ...validMetadata, navigation: shifted }).success).toBe(false);
  });

  it("rejects non-integer or negative depth/ordinal", () => {
    expect(epubExtractionMetadataSchema.safeParse({ ...validMetadata, navigation: [{ ...validNavigation[0]!, depth: -1 }] }).success).toBe(false);
    expect(epubExtractionMetadataSchema.safeParse({ ...validMetadata, navigation: [{ ...validNavigation[0]!, ordinal: 0.5 }] }).success).toBe(false);
  });

  it.each([
    ["external scheme", "https://example.test/ch1.xhtml"],
    ["file scheme", "file:///etc/passwd"],
    ["absolute path", "/etc/passwd"],
    ["drive path", "C:\\book.xhtml"],
    ["traversal", "OEBPS/../escape.xhtml"],
    ["encoded traversal", "OEBPS/%2e%2e/escape.xhtml"],
  ])("rejects an unsafe navigation href (%s)", (_name, href) => {
    expect(epubExtractionMetadataSchema.safeParse({ ...validMetadata, navigation: [{ ...validNavigation[0]!, href }] }).success).toBe(false);
  });

  it("rejects an unsafe package path and unknown fields", () => {
    expect(epubExtractionMetadataSchema.safeParse({ ...validMetadata, packagePath: "../escape.opf" }).success).toBe(false);
    expect(epubExtractionMetadataSchema.safeParse({ ...validMetadata, navData: {} }).success).toBe(false);
  });

  it("keeps tolerant reads null for legacy or malformed rows", () => {
    expect(tryParseEpubExtractionMetadata(null)).toBeNull();
    expect(tryParseEpubExtractionMetadata({ spineIndex: 3 })).toBeNull();
    expect(tryParseEpubExtractionMetadata(validMetadata)).toEqual(validMetadata);
  });

  it("extends the stable warning vocabulary additively", () => {
    expect(EXTRACTION_QUALITY_WARNING_CODES).toContain("EPUB_NAVIGATION_DEGRADED");
    expect(EXTRACTION_QUALITY_WARNING_CODES).toContain("EPUB_FIXED_LAYOUT");
    expect(EXTRACTION_QUALITY_WARNING_CODES).toContain("TABLE_FLATTENED");
  });
});
