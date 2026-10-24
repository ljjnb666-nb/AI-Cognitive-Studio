import { PassThrough } from "node:stream";
import PDFDocument from "pdfkit";
import { describe, expect, it } from "vitest";
import { DEFAULT_PARSER_LIMITS, extractNativePdf } from "../src/document-parsers.js";
import { inspectPdfPage, type PdfPageEvidence } from "../src/pdf-routing.js";
import { assessPdfVisualFidelity } from "../src/pdf-visual-fidelity.js";

const evidence = (patch: Partial<PdfPageEvidence> = {}): PdfPageEvidence => ({
  rawTextLength: 0, significantTextLength: 0, imageCount: 0,
  vectorPathCount: 0, annotationCount: 0, ...patch,
});
const inspect = (index: number, overrides: Partial<PdfPageEvidence>, nativeBlockCount = 0) =>
  inspectPdfPage({
    physicalPageIndex: index,
    text: nativeBlockCount ? "Example source text" : "",
    nativeBlockCount,
    evidence: evidence(overrides),
  });
const blocks = (index: number, kinds: string[]) => ({
  physicalPageIndex: index,
  blocks: kinds.map((kind) => ({ kind })),
});

describe("PDF visual source retention is independent of text routing", () => {
  it("keeps clean text-only PDF pages outside a visual review requirement", () => {
    const page = inspect(0, { rawTextLength: 12, significantTextLength: 12 }, 1);
    const result = assessPdfVisualFidelity([page], [blocks(0, ["PARAGRAPH"])]);
    expect(result.status).toBe("NO_VISUAL_SOURCE_EVIDENCE");
    expect(result.visualEvidencePageCount).toBe(0);
    expect(result.pages[0]!.reasonCodes).toEqual([]);
    expect(result.figureSemanticsVerified).toBe(false);
  });

  it("flags raster figure loss even if a native text paragraph publishes successfully", () => {
    const page = inspect(0, { rawTextLength: 12, significantTextLength: 12, imageCount: 2 }, 1);
    expect(page.route).toBe("NATIVE_TEXT");
    const result = assessPdfVisualFidelity([page], [blocks(0, ["PARAGRAPH"])]);
    expect(result.status).toBe("VISUAL_REVIEW_REQUIRED");
    expect(result.mixedTextVisualPageCount).toBe(1);
    expect(result.rasterPageMissingImageBlockCount).toBe(1);
    expect(result.pages[0]!.reasonCodes).toEqual([
      "MIXED_TEXT_AND_VISUAL_EVIDENCE",
      "RASTER_IMAGE_NOT_REPRESENTED_AS_CANONICAL_IMAGE_BLOCK",
    ]);
    expect(result.imageToTextAnchorsVerified).toBe(false);
  });

  it("flags raster loss when OCR provided valid words but no image blocks", () => {
    const page = inspect(0, { imageCount: 1 });
    expect(page.route).toBe("OCR_REQUIRED");
    const result = assessPdfVisualFidelity([page], [blocks(0, ["PARAGRAPH"])]);
    expect(result.visualEvidencePageCount).toBe(1);
    expect(result.rasterPageMissingImageBlockCount).toBe(1);
    expect(result.pages[0]!.requiresVisualReview).toBe(true);
  });

  it("does not pretend an IMAGE block proves exact image preservation or chart semantics", () => {
    const page = inspect(0, { imageCount: 2, rawTextLength: 3, significantTextLength: 3 }, 1);
    const result = assessPdfVisualFidelity([page], [blocks(0, ["PARAGRAPH", "IMAGE"])]);
    expect(result.rasterPageMissingImageBlockCount).toBe(0);
    expect(result.pages[0]!.reasonCodes).toContain("RASTER_IMAGE_BLOCK_EXISTENCE_NOT_FIDELITY_PROOF");
    expect(result.pages[0]!.visualFidelityVerified).toBe(false);
    expect(result.figureSemanticsVerified).toBe(false);
  });

  it("tracks vector/annotation source even without embedded raster images", () => {
    const page = inspect(0, { vectorPathCount: 4, annotationCount: 1 });
    const result = assessPdfVisualFidelity([page], [blocks(0, ["PARAGRAPH"])]);
    expect(result.visualEvidencePageCount).toBe(1);
    expect(result.pages[0]!.reasonCodes).toEqual([
      "VECTOR_CONTENT_NOT_STRUCTURALLY_VERIFIED",
      "ANNOTATION_CONTENT_NOT_STRUCTURALLY_VERIFIED",
    ]);
    expect(result.rasterPageMissingImageBlockCount).toBe(0);
  });

  it("rejects missing, duplicated, unordered or invalid publication page identities", () => {
    const a = inspect(0, {}, 0), b = inspect(1, { imageCount: 1 }, 0);
    expect(() => assessPdfVisualFidelity([a, b], [blocks(0, [])])).toThrow("SOURCE_PDF_VISUAL_AUDIT_CONTRACT_INVALID");
    expect(() => assessPdfVisualFidelity([a, b], [blocks(0, []), blocks(0, [])])).toThrow("SOURCE_PDF_VISUAL_AUDIT_CONTRACT_INVALID");
    expect(() => assessPdfVisualFidelity([a, { ...b, physicalPageIndex: 0 }], [blocks(0, []), blocks(1, [])])).toThrow("SOURCE_PDF_VISUAL_AUDIT_CONTRACT_INVALID");
    expect(() => assessPdfVisualFidelity([a], [{ physicalPageIndex: 0, blocks: [{ kind: 4 as unknown as string }] }])).toThrow("SOURCE_PDF_VISUAL_AUDIT_CONTRACT_INVALID");
  });

  it("is strictly deterministic and does not leak source text", () => {
    const input = [inspect(0, { imageCount: 1, rawTextLength: 12, significantTextLength: 12 }, 1)];
    const output = [blocks(0, ["PARAGRAPH"])];
    const one = assessPdfVisualFidelity(input, output);
    const two = assessPdfVisualFidelity(input, output);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    expect(JSON.stringify(one)).not.toContain("Example source text");
    expect(one.independentImageReferenceAvailable).toBe(false);
  });

  it("reproduces actual native-text-with-image fidelity gap using the isolated PDF.js child", async () => {
    const onePixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const doc = new PDFDocument({ autoFirstPage: false });
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    const ready = new Promise<Uint8Array>((resolve) => stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks)))));
    doc.pipe(stream);
    doc.addPage();
    doc.fontSize(12).text("Actual text layer with a source raster illustration", 55, 60);
    doc.image(onePixel, 55, 110, { width: 120, height: 75 });
    doc.end();
    const native = await extractNativePdf(await ready, DEFAULT_PARSER_LIMITS);
    expect(native.inspections[0]!.route).toBe("NATIVE_TEXT");
    expect(native.inspections[0]!.hasImageEvidence).toBe(true);
    const audit = assessPdfVisualFidelity(native.inspections, native.pages);
    expect(audit.visualEvidencePageCount).toBe(1);
    expect(audit.rasterPageMissingImageBlockCount).toBe(1);
    expect(audit.pages[0]!.reasonCodes).toContain("RASTER_IMAGE_NOT_REPRESENTED_AS_CANONICAL_IMAGE_BLOCK");
  });
});
