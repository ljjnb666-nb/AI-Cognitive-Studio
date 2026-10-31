import { PassThrough } from "node:stream";
import PDFDocument from "pdfkit";
import { describe, expect, it } from "vitest";
import { extractNativePdf, DEFAULT_PARSER_LIMITS } from "../src/document-parsers.js";
import { inspectPdfPage, planPdfRouting, assertRoutingPlanReplay, type PdfPageEvidence } from "../src/pdf-routing.js";
import { inspectPdfMixedContentShadow, PDF_MIXED_CONTENT_SHADOW_AUTHORITY } from "../src/pdf-mixed-content-shadow.js";

const evidence = (values: Partial<PdfPageEvidence> = {}): PdfPageEvidence => ({
  rawTextLength: 0, significantTextLength: 0, imageCount: 0,
  vectorPathCount: 0, annotationCount: 0, ...values,
});
const inspect = (physicalPageIndex: number, signals: Partial<PdfPageEvidence>, blocks = 1) =>
  inspectPdfPage({ physicalPageIndex, text: "visible", nativeBlockCount: blocks,
    evidence: evidence({ rawTextLength: 7, significantTextLength: 7, ...signals }) });

// Synthetic 1x1 test image only. Never copy private book content into tests.
const syntheticPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
async function makeMixedPdf(): Promise<Uint8Array> {
  const doc = new PDFDocument({ autoFirstPage: false });
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Uint8Array>((resolve) => stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks)))));
  doc.pipe(stream);
  doc.addPage(); doc.text("Native text beside a figure", 50, 50); doc.image(syntheticPng, 70, 100, { width: 30, height: 30 });
  doc.addPage(); doc.text("Plain native page", 50, 50);
  doc.end();
  return await finished;
}

describe("PDF mixed-content observation only", () => {
  it("flags image/vector/annotation separately without rewriting the persisted legacy route", () => {
    const inspections = [
      inspect(0, { imageCount: 1, vectorPathCount: 3, annotationCount: 2 }),
      inspect(1, {}),
      inspect(2, { imageCount: 1, rawTextLength: 0, significantTextLength: 0 }, 0),
    ];
    const before = JSON.stringify(inspections);
    const plan = planPdfRouting({ parser: { name: "pdfjs-isolated", version: "pdf-isolation-v3" }, inspections });
    const original = JSON.stringify(plan);
    const report = inspectPdfMixedContentShadow(inspections);
    expect(report).toMatchObject({
      authority: PDF_MIXED_CONTENT_SHADOW_AUTHORITY, pageCount: 3,
      mixedPageCount: 1, imagePageCount: 1, vectorPageCount: 1,
      annotationPageCount: 1, ocrAccuracy: null, graphAccuracy: null,
    });
    expect(report.pages).toEqual([{ physicalPageIndex: 0, nativeRoute: "NATIVE_TEXT",
      evidenceKinds: ["IMAGE", "VECTOR", "ANNOTATION"], figureSemantics: "UNVERIFIED" }]);
    expect(plan.pages.map((p) => p.route)).toEqual(["NATIVE_TEXT", "NATIVE_TEXT", "OCR_REQUIRED"]);
    expect(JSON.stringify(plan)).toBe(original);
    expect(JSON.stringify(inspections)).toBe(before);
    expect(() => assertRoutingPlanReplay(plan, planPdfRouting({ parser: { name: "pdfjs-isolated", version: "pdf-isolation-v3" }, inspections }))).not.toThrow();
    expect(inspectPdfMixedContentShadow(inspections)).toEqual(report);
  });

  it("does not flag zero canonical blocks, image-only or empty pages as mixed", () => {
    const pages = [inspect(0, { imageCount: 1 }, 0),
      inspectPdfPage({ physicalPageIndex: 1, nativeBlockCount: 0, text: "", evidence: evidence({ imageCount: 1 }) }),
      inspectPdfPage({ physicalPageIndex: 2, nativeBlockCount: 0, text: "", evidence: evidence() })];
    expect(inspectPdfMixedContentShadow(pages).mixedPageCount).toBe(0);
  });

  it("leaves graph and OCR accuracy unverified regardless of rendered vector evidence", () => {
    const report = inspectPdfMixedContentShadow([inspect(0, { vectorPathCount: 4 })]);
    expect(report.pages[0]?.figureSemantics).toBe("UNVERIFIED");
    expect(report.graphAccuracy).toBeNull();
    expect(report.ocrAccuracy).toBeNull();
  });

  it("detects mixed evidence on REAL synthetic PDF.js child output, preserving plan-v1", async () => {
    const native = await extractNativePdf(await makeMixedPdf(), DEFAULT_PARSER_LIMITS);
    expect(native.pageCount).toBe(2);
    expect(native.inspections[0]?.hasTextEvidence).toBe(true);
    expect(native.inspections[0]?.hasImageEvidence).toBe(true);
    expect(native.routingPlan.pages[0]?.route).toBe("NATIVE_TEXT");
    const report = inspectPdfMixedContentShadow(native.inspections);
    expect(report.mixedPageCount).toBe(1);
    expect(report.pages[0]).toMatchObject({ physicalPageIndex: 0, figureSemantics: "UNVERIFIED" });
    expect(report.pages[0]?.evidenceKinds).toContain("IMAGE");
    expect(native.routingPlan.schemaVersion).toBe("pdf-routing-plan-v1");
    expect(() => assertRoutingPlanReplay(native.routingPlan, native.routingPlan)).not.toThrow();
  }, 30_000);
});
