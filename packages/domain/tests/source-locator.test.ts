import { describe, expect, it } from "vitest";
import {
  blockExtractionProvenanceSchema,
  CANONICAL_SCHEMA_VERSION,
  canonicalBlockMetadataSchema,
  canonicalSourceLocatorSchema,
  extractionQualityMetadataSchema,
  EXTRACTION_QUALITY_STATUSES,
  parseCanonicalBlockMetadata,
  parseSourceBlockBbox,
  pdfSourceLocatorSchema,
  sourceBlockBboxSchema,
  tryParseCanonicalBlockMetadata,
  tryParseSourceBlockBbox,
  tryParseSourceLocator,
} from "../src/index.js";

describe("canonical source locator contract", () => {
  it("accepts a valid PDF locator", () => {
    expect(pdfSourceLocatorSchema.parse({ kind: "pdf", physicalPageIndex: 3, printedPageLabel: null })).toEqual({ kind: "pdf", physicalPageIndex: 3, printedPageLabel: null });
    expect(pdfSourceLocatorSchema.parse({ kind: "pdf", physicalPageIndex: 0 })).toEqual({ kind: "pdf", physicalPageIndex: 0 });
  });

  it("accepts a valid EPUB locator with unknown fields null", () => {
    expect(canonicalSourceLocatorSchema.parse({ kind: "epub", spineIndex: 2, href: "OPS/chapter-1.xhtml", fragmentId: null, elementPath: null })).toEqual({ kind: "epub", spineIndex: 2, href: "OPS/chapter-1.xhtml", fragmentId: null, elementPath: null });
  });

  it("rejects a physical page on an EPUB locator", () => {
    expect(canonicalSourceLocatorSchema.safeParse({ kind: "epub", spineIndex: 0, href: "OPS/a.xhtml", physicalPageIndex: 4 }).success).toBe(false);
  });

  it("requires physicalPageIndex on a PDF locator", () => {
    expect(pdfSourceLocatorSchema.safeParse({ kind: "pdf", printedPageLabel: "xvii" }).success).toBe(false);
  });

  it("rejects a negative page index", () => {
    expect(pdfSourceLocatorSchema.safeParse({ kind: "pdf", physicalPageIndex: -1 }).success).toBe(false);
    expect(pdfSourceLocatorSchema.safeParse({ kind: "pdf", physicalPageIndex: 1.5 }).success).toBe(false);
  });

  it("rejects EPUB absolute paths", () => {
    expect(canonicalSourceLocatorSchema.safeParse({ kind: "epub", spineIndex: 0, href: "/OPS/a.xhtml" }).success).toBe(false);
    expect(canonicalSourceLocatorSchema.safeParse({ kind: "epub", spineIndex: 0, href: "\\OPS\\a.xhtml" }).success).toBe(false);
    expect(canonicalSourceLocatorSchema.safeParse({ kind: "epub", spineIndex: 0, href: "C:/OPS/a.xhtml" }).success).toBe(false);
  });

  it("rejects EPUB traversal segments", () => {
    expect(canonicalSourceLocatorSchema.safeParse({ kind: "epub", spineIndex: 0, href: "../escape.xhtml" }).success).toBe(false);
    expect(canonicalSourceLocatorSchema.safeParse({ kind: "epub", spineIndex: 0, href: "OPS/../../escape.xhtml" }).success).toBe(false);
  });

  it("rejects percent-encoded EPUB traversal", () => {
    expect(canonicalSourceLocatorSchema.safeParse({ kind: "epub", spineIndex: 0, href: "OPS/%2e%2e/escape.xhtml" }).success).toBe(false);
    expect(canonicalSourceLocatorSchema.safeParse({ kind: "epub", spineIndex: 0, href: "%2fOPS/a.xhtml" }).success).toBe(false);
    expect(canonicalSourceLocatorSchema.safeParse({ kind: "epub", spineIndex: 0, href: "OPS%5ca.xhtml" }).success).toBe(false);
  });

  it("rejects external URL hrefs", () => {
    expect(canonicalSourceLocatorSchema.safeParse({ kind: "epub", spineIndex: 0, href: "https://example.test/a.xhtml" }).success).toBe(false);
    expect(canonicalSourceLocatorSchema.safeParse({ kind: "epub", spineIndex: 0, href: "http://example.test/a.xhtml" }).success).toBe(false);
    expect(canonicalSourceLocatorSchema.safeParse({ kind: "epub", spineIndex: 0, href: "file:///etc/passwd" }).success).toBe(false);
  });

  it("discriminates the union and reports unknown kinds", () => {
    expect(tryParseSourceLocator({ kind: "txt", line: 1 })).toBeNull();
    expect(tryParseSourceLocator({ kind: "pdf", physicalPageIndex: 1 })?.kind).toBe("pdf");
  });
});

describe("block extraction provenance contract", () => {
  it("accepts valid NATIVE_TEXT provenance", () => {
    expect(blockExtractionProvenanceSchema.parse({ sourceMethod: "NATIVE_TEXT", parserName: "pdfjs-isolated", parserVersion: "pdf-isolation-v3" })).toEqual({ sourceMethod: "NATIVE_TEXT", parserName: "pdfjs-isolated", parserVersion: "pdf-isolation-v3" });
  });

  it("accepts valid OCR provenance with a parser mode", () => {
    expect(blockExtractionProvenanceSchema.parse({ sourceMethod: "OCR", parserName: "mineru", parserVersion: "0.9.3", parserMode: "ocr-fallback", confidence: 0.87 })).toEqual({ sourceMethod: "OCR", parserName: "mineru", parserVersion: "0.9.3", parserMode: "ocr-fallback", confidence: 0.87 });
  });

  it("accepts null and absent confidence", () => {
    expect(blockExtractionProvenanceSchema.safeParse({ sourceMethod: "NATIVE_TEXT", parserName: "p", parserVersion: "v", confidence: null }).success).toBe(true);
    expect(blockExtractionProvenanceSchema.safeParse({ sourceMethod: "NATIVE_TEXT", parserName: "p", parserVersion: "v" }).success).toBe(true);
  });

  it("rejects NaN confidence", () => {
    expect(blockExtractionProvenanceSchema.safeParse({ sourceMethod: "NATIVE_TEXT", parserName: "p", parserVersion: "v", confidence: Number.NaN }).success).toBe(false);
  });

  it("rejects infinite confidence", () => {
    expect(blockExtractionProvenanceSchema.safeParse({ sourceMethod: "NATIVE_TEXT", parserName: "p", parserVersion: "v", confidence: Number.POSITIVE_INFINITY }).success).toBe(false);
  });

  it("rejects confidence outside [0, 1]", () => {
    expect(blockExtractionProvenanceSchema.safeParse({ sourceMethod: "NATIVE_TEXT", parserName: "p", parserVersion: "v", confidence: 1.5 }).success).toBe(false);
    expect(blockExtractionProvenanceSchema.safeParse({ sourceMethod: "NATIVE_TEXT", parserName: "p", parserVersion: "v", confidence: -0.1 }).success).toBe(false);
  });

  it("rejects unknown source methods and empty parser identity", () => {
    expect(blockExtractionProvenanceSchema.safeParse({ sourceMethod: "MAGIC", parserName: "p", parserVersion: "v" }).success).toBe(false);
    expect(blockExtractionProvenanceSchema.safeParse({ sourceMethod: "NATIVE_TEXT", parserName: "", parserVersion: "v" }).success).toBe(false);
  });
});

describe("source block bbox contract", () => {
  it("accepts a well-formed bbox without assuming units", () => {
    expect(parseSourceBlockBbox({ x0: 0, y0: 10.5, x1: 200, y1: 40 })).toEqual({ x0: 0, y0: 10.5, x1: 200, y1: 40 });
    expect(parseSourceBlockBbox({ x0: -5, y0: -5, x1: -1, y1: -1 })).toEqual({ x0: -5, y0: -5, x1: -1, y1: -1 });
  });

  it("rejects non-finite bbox coordinates", () => {
    expect(tryParseSourceBlockBbox({ x0: 0, y0: 0, x1: Number.NaN, y1: 1 })).toBeNull();
    expect(sourceBlockBboxSchema.safeParse({ x0: 0, y0: 0, x1: Number.POSITIVE_INFINITY, y1: 1 }).success).toBe(false);
    expect(sourceBlockBboxSchema.safeParse({ x0: 0, y0: 0, x1: 1 }).success).toBe(false);
  });

  it("rejects inverted bbox edges", () => {
    expect(tryParseSourceBlockBbox({ x0: 10, y0: 0, x1: 5, y1: 10 })).toBeNull();
    expect(tryParseSourceBlockBbox({ x0: 0, y0: 10, x1: 10, y1: 5 })).toBeNull();
  });
});

describe("canonical block metadata contract", () => {
  it("keeps legacy metadata readable without forcing it into v1 shape", () => {
    const legacy = { spineIndex: 0, href: "OPS/b.xhtml" };
    expect(tryParseCanonicalBlockMetadata(legacy)).toBeNull();
    expect(legacy).toEqual({ spineIndex: 0, href: "OPS/b.xhtml" });
  });

  it("validates new canonical metadata strictly", () => {
    const canonical = {
      locator: { kind: "pdf", physicalPageIndex: 1, printedPageLabel: null },
      provenance: { sourceMethod: "NATIVE_TEXT", parserName: "pdfjs-isolated", parserVersion: "pdf-isolation-v3" },
    };
    expect(parseCanonicalBlockMetadata(canonical)).toEqual({
      locator: { kind: "pdf", physicalPageIndex: 1, printedPageLabel: null },
      provenance: { sourceMethod: "NATIVE_TEXT", parserName: "pdfjs-isolated", parserVersion: "pdf-isolation-v3" },
    });
    expect(canonicalBlockMetadataSchema.safeParse({ ...canonical, unexpected: true }).success).toBe(false);
  });

  it("preserves headingLevel compatibility for structure inference", () => {
    expect(canonicalBlockMetadataSchema.safeParse({
      locator: null,
      provenance: { sourceMethod: "STRUCTURED_MARKUP", parserName: "builtin-markdown", parserVersion: "markdown-parser-v1" },
      headingLevel: 2,
    }).success).toBe(true);
    expect(canonicalBlockMetadataSchema.safeParse({
      locator: null,
      provenance: { sourceMethod: "STRUCTURED_MARKUP", parserName: "builtin-markdown", parserVersion: "markdown-parser-v1" },
      headingLevel: 9,
    }).success).toBe(false);
  });

  it("requires provenance whenever canonical metadata is written", () => {
    expect(canonicalBlockMetadataSchema.safeParse({ locator: { kind: "pdf", physicalPageIndex: 0 } }).success).toBe(false);
  });
});

describe("extraction quality metadata contract", () => {
  it("accepts an evidence-free warning list", () => {
    expect(extractionQualityMetadataSchema.parse({ warnings: [] })).toEqual({ warnings: [] });
  });

  it("accepts stable warning codes and rejects arbitrary warnings", () => {
    expect(extractionQualityMetadataSchema.parse({ warnings: ["TABLE_FLATTENED", "OCR_USED"] })).toEqual({ warnings: ["TABLE_FLATTENED", "OCR_USED"] });
    expect(extractionQualityMetadataSchema.parse({ warnings: ["HEADER_FOOTER_CONTAMINATION", "PARTIAL_EXTRACTION", "STRUCTURE_DEGRADED"] })).toEqual({ warnings: ["HEADER_FOOTER_CONTAMINATION", "PARTIAL_EXTRACTION", "STRUCTURE_DEGRADED"] });
    expect(extractionQualityMetadataSchema.safeParse({ warnings: ["SOME_NEW_WARNING"] }).success).toBe(false);
    expect(extractionQualityMetadataSchema.safeParse({ warnings: ["table_flattened"] }).success).toBe(false);
    expect(extractionQualityMetadataSchema.safeParse({ warnings: "TABLE_FLATTENED" }).success).toBe(false);
    expect(extractionQualityMetadataSchema.safeParse({ warnings: [""], extra: 1 }).success).toBe(false);
    expect(extractionQualityMetadataSchema.safeParse({}).success).toBe(false);
  });

  it("keeps ACCEPTED as a valid future domain value that the parser path must not emit", () => {
    expect(EXTRACTION_QUALITY_STATUSES).toContain("ACCEPTED");
    expect(EXTRACTION_QUALITY_STATUSES).toContain("UNKNOWN");
  });
});

describe("canonical schema version", () => {
  it("pins the shared v1 constant", () => {
    expect(CANONICAL_SCHEMA_VERSION).toBe("canonical-book-v1");
  });
});
