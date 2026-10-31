import { describe, expect, it } from "vitest";
import { projectPdfPageEvidence, PDF_REVIEW_PREVIEW_MAX_BLOCKS, PDF_REVIEW_PREVIEW_MAX_CHARS } from "../lib/pdf-page-review";

const SHA = "a".repeat(64);
const block = (n: number, text = "原始 PDF.js 提取文字") =>
  ({ id: `block-${n}`, ordinal: n, kind: "PARAGRAPH", text });
const make = (overrides: Partial<Parameters<typeof projectPdfPageEvidence>[0]> = {}) =>
  projectPdfPageEvidence({
    sourceSha256: SHA, physicalPageIndex: 3, recordedPageIndex: 3,
    sourceBlockCount: 2, blocks: [block(10), block(11)],
    ...overrides,
  });

describe("PDF physical-page evidence review view policy", () => {
  it("presents source-linked parsed text but never invents independent Gold or visual approval", () => {
    const result = make();
    expect(result).toMatchObject({
      authority: "SOURCE_EXTRACTION_ONLY_NOT_GOLD", sourceSha256: SHA,
      physicalPageIndex: 3, sourceBlockCount: 2,
      reviewStatus: "NOT_REVIEWED", visualStatus: "NO_DURABLE_REVIEW_CANDIDATE",
      approvedForPodcast: false, approvedForBookIntelligence: false,
      previewTruncated: false,
    });
    expect(result.parsedBlocks.map((b) => b.excerpt))
      .toEqual(["原始 PDF.js 提取文字", "原始 PDF.js 提取文字"]);
  });
  it("rejects wrong-book SHA and cross-page evidence instead of mixing sources", () => {
    expect(() => make({ sourceSha256: "notsha" })).toThrow("PDF_REVIEW_SOURCE_IDENTITY_INVALID");
    expect(() => make({ recordedPageIndex: 4 })).toThrow("PDF_REVIEW_SOURCE_IDENTITY_INVALID");
    expect(() => make({ physicalPageIndex: -1, recordedPageIndex: -1 }))
      .toThrow("PDF_REVIEW_SOURCE_IDENTITY_INVALID");
  });
  it("truncates a long block without claiming the excerpt is the whole page", () => {
    const result = make({ sourceBlockCount: 1, blocks: [block(0, "X".repeat(8_000))] });
    expect(result.visibleCharacters).toBe(PDF_REVIEW_PREVIEW_MAX_CHARS);
    expect(result.parsedBlocks[0]?.excerpt.length).toBe(PDF_REVIEW_PREVIEW_MAX_CHARS);
    expect(result.parsedBlocks[0]?.excerptTruncated).toBe(true);
    expect(result.previewTruncated).toBe(true);
  });
  it("bounds a page with many blocks and retains the actual block count", () => {
    const blocks = Array.from({ length: PDF_REVIEW_PREVIEW_MAX_BLOCKS + 1 },
      (_, n) => block(n, `block ${n}`));
    const result = make({ sourceBlockCount: 31, blocks });
    expect(result.parsedBlocks).toHaveLength(PDF_REVIEW_PREVIEW_MAX_BLOCKS);
    expect(result.sourceBlockCount).toBe(31);
    expect(result.previewTruncated).toBe(true);
  });
  it("distinguishes a genuinely empty recorded block list from any OCR inference", () => {
    const result = make({ sourceBlockCount: 0, blocks: [] });
    expect(result.parsedBlocks).toEqual([]);
    expect(result.visualStatus).toBe("NO_DURABLE_REVIEW_CANDIDATE");
    expect(result.reviewStatus).toBe("NOT_REVIEWED");
    expect(result.approvedForPodcast).toBe(false);
  });
  it("rejects forged record counts or excess preview input", () => {
    expect(() => make({ sourceBlockCount: 0 })).toThrow("PDF_REVIEW_SOURCE_IDENTITY_INVALID");
    expect(() => make({ sourceBlockCount: 40,
      blocks: Array.from({length:PDF_REVIEW_PREVIEW_MAX_BLOCKS + 2},(_,i)=>block(i)) }))
      .toThrow("PDF_REVIEW_SOURCE_IDENTITY_INVALID");
  });
  it("rejects invalid block shape and retains explicit empty-visual status", () => {
    expect(() => make({ sourceBlockCount: 1,
      blocks: [block(-1)] })).toThrow("PDF_REVIEW_BLOCK_INVALID");
    expect(() => make({ sourceBlockCount: 1,
      blocks: [{...block(0), text: null as unknown as string}] }))
      .toThrow("PDF_REVIEW_BLOCK_INVALID");
  });
});
