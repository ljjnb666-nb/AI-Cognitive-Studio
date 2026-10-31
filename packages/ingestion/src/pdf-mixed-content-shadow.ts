/**
 * Observational PDF mixed-content inspector. This is NOT part of the
 * durable pdf-routing-plan-v1 authority, OCR scheduling or publication gate.
 * PDF.js evidence cannot distinguish decoration from charts/diagrams.
 */
import type { PdfPageInspection } from "./pdf-routing.js";

export const PDF_MIXED_CONTENT_SHADOW_SCHEMA_VERSION = "pdf-mixed-content-shadow-v1";
export const PDF_MIXED_CONTENT_SHADOW_AUTHORITY = "NON_AUTHORITATIVE_REVIEW_CANDIDATES_ONLY";

export type PdfMixedContentEvidenceKind = "IMAGE" | "VECTOR" | "ANNOTATION";
export type PdfMixedContentShadowPage = {
  physicalPageIndex: number;
  nativeRoute: "NATIVE_TEXT";
  evidenceKinds: PdfMixedContentEvidenceKind[];
  figureSemantics: "UNVERIFIED";
};
export type PdfMixedContentShadowReport = {
  schemaVersion: typeof PDF_MIXED_CONTENT_SHADOW_SCHEMA_VERSION;
  authority: typeof PDF_MIXED_CONTENT_SHADOW_AUTHORITY;
  pageCount: number;
  mixedPageCount: number;
  imagePageCount: number;
  vectorPageCount: number;
  annotationPageCount: number;
  pages: PdfMixedContentShadowPage[];
  ocrAccuracy: null;
  graphAccuracy: null;
};

/**
 * Non-authoritative review candidates only: canonical native text PLUS
 * image/vector/annotation evidence. Never implies semantic extraction
 * succeeded or failed. No source text, coordinates or hashes are read.
 */
export function inspectPdfMixedContentShadow(inspections: readonly PdfPageInspection[]): PdfMixedContentShadowReport {
  const pages: PdfMixedContentShadowPage[] = [];
  let imagePageCount = 0;
  let vectorPageCount = 0;
  let annotationPageCount = 0;
  for (const page of inspections) {
    if (!page.hasTextEvidence || page.route !== "NATIVE_TEXT") continue;
    const evidenceKinds: PdfMixedContentEvidenceKind[] = [];
    if (page.hasImageEvidence) { evidenceKinds.push("IMAGE"); imagePageCount++; }
    if (page.hasVectorEvidence) { evidenceKinds.push("VECTOR"); vectorPageCount++; }
    if (page.hasAnnotationEvidence) { evidenceKinds.push("ANNOTATION"); annotationPageCount++; }
    if (evidenceKinds.length === 0) continue;
    pages.push({
      physicalPageIndex: page.physicalPageIndex,
      nativeRoute: "NATIVE_TEXT",
      evidenceKinds,
      figureSemantics: "UNVERIFIED",
    });
  }
  return {
    schemaVersion: PDF_MIXED_CONTENT_SHADOW_SCHEMA_VERSION,
    authority: PDF_MIXED_CONTENT_SHADOW_AUTHORITY,
    pageCount: inspections.length,
    mixedPageCount: pages.length,
    imagePageCount,
    vectorPageCount,
    annotationPageCount,
    pages,
    ocrAccuracy: null,
    graphAccuracy: null,
  };
}
