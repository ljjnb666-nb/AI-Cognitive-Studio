import { deflateRawSync } from "node:zlib";
import { PassThrough } from "node:stream";
import PDFDocument from "pdfkit";
import { describe, expect, it } from "vitest";
import { extractNativePdf, parseDocument, DEFAULT_PARSER_LIMITS } from "../src/document-parsers.js";
import {
  assertRoutingPlanReplay,
  evaluatePdfExtractionQuality,
  inspectPdfPage,
  parseRoutingPlan,
  pdfRoutingOutcome,
  PDF_INSPECTOR_VERSION,
  PDF_ROUTING_OUTCOME_SCHEMA_VERSION,
  PDF_ROUTING_PLAN_SCHEMA_VERSION,
  planPdfRouting,
  type PdfPageEvidence,
  type PdfPageExtractionOutcome,
  type PdfPageInspection,
} from "../src/pdf-routing.js";

// ---------------------------------------------------------------------------
// Deterministic fixtures (pdfkit → the REAL isolated pdfjs child path for
// evidence tests; hand-built evidence for pure policy tests).
// ---------------------------------------------------------------------------

/** 1x1 PNG — raster evidence without any text. */
const png1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function buildPdf(pages: Array<(document: InstanceType<typeof PDFDocument>) => void>): Promise<Uint8Array> {
  const document = new PDFDocument({ autoFirstPage: false });
  const stream = new PassThrough(), chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  const complete = new Promise<Uint8Array>((resolve) => stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks)))));
  document.pipe(stream);
  for (const draw of pages) {
    document.addPage();
    draw(document);
  }
  document.end();
  return complete;
}

const evidence = (overrides: Partial<PdfPageEvidence> = {}): PdfPageEvidence => ({ rawTextLength: 0, significantTextLength: 0, imageCount: 0, vectorPathCount: 0, annotationCount: 0, ...overrides });

function inspect(overrides: { physicalPageIndex?: number; text?: string; nativeBlockCount?: number; evidence?: PdfPageEvidence }): PdfPageInspection {
  return inspectPdfPage({ physicalPageIndex: overrides.physicalPageIndex ?? 0, text: overrides.text ?? "", nativeBlockCount: overrides.nativeBlockCount ?? 0, evidence: overrides.evidence ?? evidence() });
}

// ---------------------------------------------------------------------------
// Page inspection policy (pure).
// ---------------------------------------------------------------------------

describe("PDF page inspection policy", () => {
  it("routes trustworthy native text to NATIVE_TEXT", () => {
    const page = inspect({ text: "Hello PDF", nativeBlockCount: 1, evidence: evidence({ rawTextLength: 9, significantTextLength: 8 }) });
    expect(page).toMatchObject({ contentEvidence: "TEXT", route: "NATIVE_TEXT", hasTextEvidence: true, hasImageEvidence: false, hasVectorEvidence: false, hasAnnotationEvidence: false, reasonCodes: ["NATIVE_TEXT_PRESENT"], nativeTextCharacterCount: 9, nativeBlockCount: 1 });
  });

  it("routes image-only content without text to OCR_REQUIRED", () => {
    const page = inspect({ evidence: evidence({ imageCount: 2 }) });
    expect(page.contentEvidence).toBe("NON_TEXT_CONTENT");
    expect(page.route).toBe("OCR_REQUIRED");
    expect(page.reasonCodes).toEqual(["IMAGE_CONTENT_WITHOUT_TEXT"]);
  });

  it("routes vector-only content without text to OCR_REQUIRED", () => {
    const page = inspect({ evidence: evidence({ vectorPathCount: 3 }) });
    expect(page.route).toBe("OCR_REQUIRED");
    expect(page.reasonCodes).toEqual(["VECTOR_CONTENT_WITHOUT_TEXT"]);
  });

  it("never classifies annotation-only appearance as blank", () => {
    const page = inspect({ evidence: evidence({ annotationCount: 1 }) });
    expect(page.contentEvidence).toBe("NON_TEXT_CONTENT");
    expect(page.route).toBe("OCR_REQUIRED");
    expect(page.reasonCodes).toEqual(["ANNOTATION_CONTENT_WITHOUT_TEXT"]);
  });

  it("routes a genuinely empty page to NATIVE_TEXT as an explicit EMPTY page (never OCR)", () => {
    const page = inspect({ evidence: evidence() });
    expect(page).toMatchObject({ contentEvidence: "EMPTY", route: "NATIVE_TEXT", reasonCodes: ["EMPTY_PAGE"] });
  });

  it("records whitespace-only text as INSUFFICIENT_NATIVE_TEXT alongside non-text evidence", () => {
    const page = inspect({ evidence: evidence({ rawTextLength: 12, significantTextLength: 0, vectorPathCount: 1 }) });
    expect(page.hasTextEvidence).toBe(false);
    expect(page.route).toBe("OCR_REQUIRED");
    expect(page.reasonCodes).toEqual(["INSUFFICIENT_NATIVE_TEXT", "VECTOR_CONTENT_WITHOUT_TEXT"]);
  });

  it("RF01: raw text signal that canonicalizes to zero blocks never authorizes usable native text", () => {
    const canonicalZero = inspect({ evidence: evidence({ rawTextLength: 5, significantTextLength: 5 }), nativeBlockCount: 0 });
    expect(canonicalZero.hasTextEvidence).toBe(false);
    expect(canonicalZero.contentEvidence).toBe("EMPTY");
    expect(canonicalZero.route).toBe("NATIVE_TEXT");
    expect(canonicalZero.reasonCodes).toEqual(["INSUFFICIENT_NATIVE_TEXT", "EMPTY_PAGE"]);
    // With non-text evidence present the page still requires OCR instead.
    const withVector = inspect({ evidence: evidence({ rawTextLength: 5, significantTextLength: 5, vectorPathCount: 1 }), nativeBlockCount: 0 });
    expect(withVector.contentEvidence).toBe("NON_TEXT_CONTENT");
    expect(withVector.route).toBe("OCR_REQUIRED");
    expect(withVector.reasonCodes).toEqual(["INSUFFICIENT_NATIVE_TEXT", "VECTOR_CONTENT_WITHOUT_TEXT"]);
    // Usable canonical content keeps full text authority.
    const usable = inspect({ text: "alpha", nativeBlockCount: 2, evidence: evidence({ rawTextLength: 5, significantTextLength: 5 }) });
    expect(usable).toMatchObject({ contentEvidence: "TEXT", route: "NATIVE_TEXT", hasTextEvidence: true, reasonCodes: ["NATIVE_TEXT_PRESENT"] });
  });
});

// ---------------------------------------------------------------------------
// Routing plan: deterministic, versioned, complete, immutable-by-replay.
// ---------------------------------------------------------------------------

const sharedInspections = [
  inspect({ physicalPageIndex: 0, text: "alpha", nativeBlockCount: 1, evidence: evidence({ rawTextLength: 5, significantTextLength: 5 }) }),
  inspect({ physicalPageIndex: 1, evidence: evidence({ imageCount: 1 }) }),
  inspect({ physicalPageIndex: 2, text: "gamma", nativeBlockCount: 1, evidence: evidence({ rawTextLength: 5, significantTextLength: 5 }) }),
];

describe("deterministic PDF routing plan", () => {
  const inspections = sharedInspections;

  it("includes every physical page and serializes byte-deterministically", () => {
    const first = planPdfRouting({ parser: { name: "pdfjs-isolated", version: "pdf-isolation-v3" }, inspections });
    const second = planPdfRouting({ parser: { name: "pdfjs-isolated", version: "pdf-isolation-v3" }, inspections: inspections.map((page) => ({ ...page, reasonCodes: [...page.reasonCodes] })) });
    expect(first.pageCount).toBe(3);
    expect(first.pages.map((page) => [page.physicalPageIndex, page.route])).toEqual([[0, "NATIVE_TEXT"], [1, "OCR_REQUIRED"], [2, "NATIVE_TEXT"]]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // No timestamps/random ids: the key set is fixed by the schema.
    expect(Object.keys(first)).toEqual(["schemaVersion", "inspector", "parser", "pageCount", "pages"]);
    expect(first.schemaVersion).toBe(PDF_ROUTING_PLAN_SCHEMA_VERSION);
    expect(first.inspector).toEqual({ version: PDF_INSPECTOR_VERSION });
  });

  it("round-trips through parseRoutingPlan and rejects structural drift", () => {
    const plan = planPdfRouting({ parser: { name: "pdfjs-isolated", version: "pdf-isolation-v3" }, inspections });
    expect(parseRoutingPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(() => parseRoutingPlan({ ...plan, schemaVersion: "pdf-routing-plan-v2" })).toThrow("SOURCE_ROUTING_PLAN_CONTRACT_INVALID");
    expect(() => parseRoutingPlan({ ...plan, pageCount: 2 })).toThrow("SOURCE_ROUTING_PLAN_CONTRACT_INVALID");
    const reordered = JSON.parse(JSON.stringify(plan));
    reordered.pages = [reordered.pages[1], reordered.pages[0], reordered.pages[2]];
    expect(() => parseRoutingPlan(reordered)).toThrow("SOURCE_ROUTING_PLAN_CONTRACT_INVALID");
    const unknownCode = JSON.parse(JSON.stringify(plan));
    unknownCode.pages[1].reasonCodes = ["MADE_UP_CODE"];
    expect(() => parseRoutingPlan(unknownCode)).toThrow("SOURCE_ROUTING_PLAN_CONTRACT_INVALID");
  });

  it("fails closed on replay conflicts instead of patching persisted history", () => {
    const runtime = planPdfRouting({ parser: { name: "pdfjs-isolated", version: "pdf-isolation-v3" }, inspections });
    expect(() => assertRoutingPlanReplay(parseRoutingPlan(JSON.parse(JSON.stringify(runtime))), runtime)).not.toThrow();
    const flipped = JSON.parse(JSON.stringify(runtime));
    flipped.pages[1].route = "NATIVE_TEXT";
    expect(() => assertRoutingPlanReplay(flipped, runtime)).toThrow("SOURCE_ROUTING_PLAN_CONFLICT");
    const mutatedReasons = JSON.parse(JSON.stringify(runtime));
    mutatedReasons.pages[0].reasonCodes = ["EMPTY_PAGE"];
    expect(() => assertRoutingPlanReplay(mutatedReasons, runtime)).toThrow("SOURCE_ROUTING_PLAN_CONFLICT");
    expect(() => assertRoutingPlanReplay({ ...runtime, parser: { name: "pdfjs-isolated", version: "pdf-isolation-v2" } }, runtime)).toThrow("SOURCE_ROUTING_PLAN_CONFLICT");
    expect(() => assertRoutingPlanReplay({ ...runtime, pageCount: 2 }, runtime)).toThrow("SOURCE_ROUTING_PLAN_CONFLICT");
  });
});

// ---------------------------------------------------------------------------
// Extraction quality gate.
// ---------------------------------------------------------------------------

describe("PDF extraction quality gate", () => {
  const plan = planPdfRouting({ parser: { name: "pdfjs-isolated", version: "pdf-isolation-v3" }, inspections: sharedInspections });

  const outcomes = (values: Record<number, PdfPageExtractionOutcome>) => new Map(Object.entries(values).map(([key, value]) => [Number(key), value]));
  const blockCounts = (values: Record<number, number>) => new Map(Object.entries(values).map(([key, value]) => [Number(key), value]));

  it("accepts complete native documents (empty pages retained, never UNKNOWN)", () => {
    const decision = evaluatePdfExtractionQuality(plan, outcomes({ 0: "NATIVE_TEXT", 1: "OCR_FALLBACK", 2: "NATIVE_TEXT" }), blockCounts({ 0: 1, 1: 2, 2: 1 }));
    expect(decision.status).toBe("DEGRADED");
    expect(decision.reasonCodes).toEqual(["OCR_FALLBACK_USED"]);
    expect(decision.qualityWarnings).toEqual(["OCR_USED"]);
    expect(decision.pageDecisions.map((page) => page.outcome)).toEqual(["NATIVE_TEXT", "OCR_FALLBACK", "NATIVE_TEXT"]);
  });

  it("degrades with an explicit OCR_USED warning when fallback content is merged", () => {
    const decision = evaluatePdfExtractionQuality(plan, outcomes({ 0: "NATIVE_TEXT", 1: "OCR_FALLBACK", 2: "NATIVE_TEXT" }), blockCounts({ 0: 1, 1: 1, 2: 1 }));
    expect(decision.status).toBe("DEGRADED");
    expect(decision.qualityWarnings).toEqual(["OCR_USED"]);
  });

  it("requires fallback while any non-empty page lacks an authoritative result", () => {
    const decision = evaluatePdfExtractionQuality(plan, outcomes({ 0: "NATIVE_TEXT", 2: "NATIVE_TEXT" }), blockCounts({ 0: 1, 2: 1 }));
    expect(decision.status).toBe("REQUIRES_FALLBACK");
    expect(decision.reasonCodes).toEqual(["UNRESOLVED_FALLBACK_PAGE"]);
    expect(decision.pageDecisions.find((page) => page.physicalPageIndex === 1)?.outcome).toBe("UNRESOLVED_FALLBACK");
  });

  it("RF01: an outcome label never manufactures usability — labeled pages with zero usable blocks fail closed", () => {
    const labeledNative = evaluatePdfExtractionQuality(plan, outcomes({ 0: "NATIVE_TEXT", 1: "OCR_FALLBACK", 2: "NATIVE_TEXT" }), blockCounts({ 0: 1, 1: 0, 2: 1 }));
    expect(labeledNative.status).toBe("REQUIRES_FALLBACK");
    expect(labeledNative.pageDecisions.find((page) => page.physicalPageIndex === 1)?.outcome).toBe("UNRESOLVED_FALLBACK");
    const labeledOcr = evaluatePdfExtractionQuality(plan, outcomes({ 0: "NATIVE_TEXT", 1: "OCR_FALLBACK", 2: "NATIVE_TEXT" }), blockCounts({ 0: 1, 1: 3, 2: 0 }));
    expect(labeledOcr.status).toBe("REQUIRES_FALLBACK");
    expect(labeledOcr.pageDecisions.find((page) => page.physicalPageIndex === 2)?.outcome).toBe("UNRESOLVED_FALLBACK");
    const missingCount = evaluatePdfExtractionQuality(plan, outcomes({ 0: "NATIVE_TEXT", 1: "OCR_FALLBACK", 2: "NATIVE_TEXT" }), blockCounts({ 0: 1, 1: 1 }));
    expect(missingCount.status).toBe("REQUIRES_FALLBACK");
  });

  it("rejects documents with no usable content at all", () => {
    const allEmpty = planPdfRouting({
      parser: { name: "pdfjs-isolated", version: "pdf-isolation-v3" },
      inspections: [inspect({ physicalPageIndex: 0 }), inspect({ physicalPageIndex: 1 })],
    });
    const decision = evaluatePdfExtractionQuality(allEmpty, outcomes({ 0: "EMPTY", 1: "EMPTY" }), blockCounts({ 0: 0, 1: 0 }));
    expect(decision.status).toBe("REJECTED");
    expect(decision.reasonCodes).toEqual(["NO_USABLE_CONTENT"]);
  });

  it("summarizes unresolved pages in the routing outcome", () => {
    const decision = evaluatePdfExtractionQuality(plan, outcomes({ 0: "NATIVE_TEXT", 2: "NATIVE_TEXT" }), blockCounts({ 0: 1, 2: 1 }));
    const fallback = pdfRoutingOutcome(decision, false);
    expect(fallback).toEqual({ schemaVersion: PDF_ROUTING_OUTCOME_SCHEMA_VERSION, outcome: "REQUIRES_FALLBACK", qualityStatus: "REQUIRES_FALLBACK", unresolvedPhysicalPageIndexes: [1] });
    const published = pdfRoutingOutcome(evaluatePdfExtractionQuality(plan, outcomes({ 0: "NATIVE_TEXT", 1: "OCR_FALLBACK", 2: "NATIVE_TEXT" }), blockCounts({ 0: 1, 1: 1, 2: 1 })), true);
    expect(published).toEqual({ schemaVersion: PDF_ROUTING_OUTCOME_SCHEMA_VERSION, outcome: "PUBLISHED", qualityStatus: "DEGRADED", unresolvedPhysicalPageIndexes: [] });
  });
});

// ---------------------------------------------------------------------------
// Real isolated-child evidence: the 04B-0 empirical contract, end to end.
// ---------------------------------------------------------------------------

describe("PDF inspector through the isolated child", () => {
  it("routes text/vector/text mixed documents per physical page", async () => {
    const bytes = await buildPdf([(document) => document.text("Hello PDF"), (document) => document.rect(20, 20, 100, 100).fill(), (document) => document.text("Second Page")]);
    const native = await extractNativePdf(bytes, DEFAULT_PARSER_LIMITS);
    expect(native.pageCount).toBe(3);
    expect(native.routingPlan.pages.map((page) => page.route)).toEqual(["NATIVE_TEXT", "OCR_REQUIRED", "NATIVE_TEXT"]);
    expect(native.routingPlan.pages[1]?.reasonCodes).toEqual(["VECTOR_CONTENT_WITHOUT_TEXT"]);
    expect(native.inspections.map((inspection) => inspection.contentEvidence)).toEqual(["TEXT", "NON_TEXT_CONTENT", "TEXT"]);
    // parseDocument keeps the legacy all-or-nothing terminal: OCR required.
    await expect(parseDocument(bytes, "application/pdf")).rejects.toThrow("SOURCE_OCR_REQUIRED");
  }, 30_000);

  it("represents a genuinely blank page without routing it to OCR", async () => {
    const bytes = await buildPdf([(document) => document.text("Hello PDF"), () => undefined, (document) => document.text("Second Page")]);
    const native = await extractNativePdf(bytes, DEFAULT_PARSER_LIMITS);
    expect(native.routingPlan.pages.map((page) => [page.route, page.contentEvidence])).toEqual([["NATIVE_TEXT", "TEXT"], ["NATIVE_TEXT", "EMPTY"], ["NATIVE_TEXT", "TEXT"]]);
    expect(native.routingPlan.pages[1]?.reasonCodes).toEqual(["EMPTY_PAGE"]);
    // All-native documents still parse end to end; the blank page stays a
    // represented physical page with zero blocks.
    const parsed = await parseDocument(bytes, "application/pdf");
    expect(parsed.pages.map((page) => page.physicalPageIndex)).toEqual([0, 1, 2]);
    expect(parsed.pages[1]?.blocks).toEqual([]);
  }, 30_000);

  it("routes image-only and annotation-only pages to OCR_REQUIRED", async () => {
    const imageBytes = await buildPdf([(document) => document.text("Before"), (document) => document.image(png1x1, 50, 50, { width: 60 }), (document) => document.text("After")]);
    const imageNative = await extractNativePdf(imageBytes, DEFAULT_PARSER_LIMITS);
    expect(imageNative.routingPlan.pages.map((page) => page.route)).toEqual(["NATIVE_TEXT", "OCR_REQUIRED", "NATIVE_TEXT"]);
    expect(imageNative.routingPlan.pages[1]?.reasonCodes).toEqual(["IMAGE_CONTENT_WITHOUT_TEXT"]);

    // pdfkit reads options.Subtype at runtime and writes the key verbatim into
    // the annotation dictionary; @types/pdfkit's SubType key is never emitted.
    const annotation = { Subtype: "Text", Contents: "inspection note" } as never;
    const annotBytes = await buildPdf([(document) => document.annotate(20, 20, 100, 30, annotation)]);
    const annotNative = await extractNativePdf(annotBytes, DEFAULT_PARSER_LIMITS);
    expect(annotNative.routingPlan.pages[0]?.route).toBe("OCR_REQUIRED");
    expect(annotNative.routingPlan.pages[0]?.reasonCodes).toEqual(["ANNOTATION_CONTENT_WITHOUT_TEXT"]);
  }, 30_000);
});
