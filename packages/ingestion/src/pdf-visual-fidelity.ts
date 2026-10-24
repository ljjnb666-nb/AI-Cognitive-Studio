/**
 * Read-only source-visual-evidence audit for PDF publication (VF01).
 *
 * The existing PDF routing contract decides whether TEXT or OCR is needed.
 * It does NOT prove that figures, vector diagrams, and annotations survive
 * that decision. This audit describes precisely that separate evidence gap.
 *
 * No OCR/model calls, no persisted routing-plan changes, no hidden fallback,
 * no extraction side effects, no image semantics or figure coordinates.
 */
import type { PdfPageInspection } from "./pdf-routing.js";

export const PDF_VISUAL_AUDIT_SCHEMA_VERSION = "pdf-visual-audit-v1" as const;

export const PDF_VISUAL_RISK_CODES = [
  "MIXED_TEXT_AND_VISUAL_EVIDENCE",
  "RASTER_IMAGE_NOT_REPRESENTED_AS_CANONICAL_IMAGE_BLOCK",
  "RASTER_IMAGE_BLOCK_EXISTENCE_NOT_FIDELITY_PROOF",
  "VECTOR_CONTENT_NOT_STRUCTURALLY_VERIFIED",
  "ANNOTATION_CONTENT_NOT_STRUCTURALLY_VERIFIED",
] as const;
export type PdfVisualRiskCode = (typeof PDF_VISUAL_RISK_CODES)[number];

export type PdfVisualAuditPage = {
  physicalPageIndex: number;
  routedAs: "NATIVE_TEXT" | "OCR_REQUIRED";
  sourceHasRasterImage: boolean;
  sourceHasVector: boolean;
  sourceHasAnnotation: boolean;
  publishedCanonicalImageBlockCount: number;
  requiresVisualReview: boolean;
  reasonCodes: PdfVisualRiskCode[];
  /** IMPORTANT: no visual source coverage or chart meaning has been verified. */
  visualFidelityVerified: false;
};

export type PdfVisualAudit = {
  schemaVersion: typeof PDF_VISUAL_AUDIT_SCHEMA_VERSION;
  status: "NO_VISUAL_SOURCE_EVIDENCE" | "VISUAL_REVIEW_REQUIRED";
  physicalPageCount: number;
  mixedTextVisualPageCount: number;
  visualEvidencePageCount: number;
  rasterPageMissingImageBlockCount: number;
  pages: PdfVisualAuditPage[];
  imageToTextAnchorsVerified: false;
  figureSemanticsVerified: false;
  independentImageReferenceAvailable: false;
};

const invalid = "SOURCE_PDF_VISUAL_AUDIT_CONTRACT_INVALID";

/**
 * Pure assessment of the *actual blocks about to be published*. A correct
 * text paragraph never proves that a nearby PDF image survives extraction.
 *
 * The audit is deliberately informative, not a routing decision: changing
 * existing ingestion OCR routing or failing formerly publishable documents
 * requires a separately approved, evidence-backed production migration.
 */
export function assessPdfVisualFidelity(
  inspections: readonly PdfPageInspection[],
  publication: readonly { physicalPageIndex: number; blocks: readonly { kind: string }[] }[],
): PdfVisualAudit {
  if (!Array.isArray(inspections) || !Array.isArray(publication) ||
      inspections.length === 0 || inspections.length !== publication.length ||
      inspections.length > 2000) throw new Error(invalid);

  let mixed = 0;
  let visual = 0;
  let rasterMissing = 0;
  const pages: PdfVisualAuditPage[] = inspections.map((page, index) => {
    const published = publication[index];
    if (!page || !published || page.physicalPageIndex !== index ||
        published.physicalPageIndex !== index || !Array.isArray(published.blocks) ||
        typeof page.hasImageEvidence !== "boolean" ||
        typeof page.hasVectorEvidence !== "boolean" ||
        typeof page.hasAnnotationEvidence !== "boolean" ||
        typeof page.hasTextEvidence !== "boolean" ||
        (page.route !== "NATIVE_TEXT" && page.route !== "OCR_REQUIRED") ||
        published.blocks.some((block: { kind: string }) => !block || typeof block.kind !== "string")) {
      throw new Error(invalid);
    }
    const imageBlocks = published.blocks.filter((block: { kind: string }) => block.kind === "IMAGE").length;
    const hasVisual = page.hasImageEvidence || page.hasVectorEvidence || page.hasAnnotationEvidence;
    const isMixed = page.hasTextEvidence && hasVisual;
    if (hasVisual) visual++;
    if (isMixed) mixed++;
    const codes: PdfVisualRiskCode[] = [];
    if (isMixed) codes.push("MIXED_TEXT_AND_VISUAL_EVIDENCE");
    if (page.hasImageEvidence) {
      if (imageBlocks === 0) {
        rasterMissing++;
        codes.push("RASTER_IMAGE_NOT_REPRESENTED_AS_CANONICAL_IMAGE_BLOCK");
      } else {
        // Presence of some image blocks does not prove all original graphics
        // are retained, rendered, anchored or correctly understood.
        codes.push("RASTER_IMAGE_BLOCK_EXISTENCE_NOT_FIDELITY_PROOF");
      }
    }
    if (page.hasVectorEvidence) codes.push("VECTOR_CONTENT_NOT_STRUCTURALLY_VERIFIED");
    if (page.hasAnnotationEvidence) codes.push("ANNOTATION_CONTENT_NOT_STRUCTURALLY_VERIFIED");
    return {
      physicalPageIndex: index,
      routedAs: page.route,
      sourceHasRasterImage: page.hasImageEvidence,
      sourceHasVector: page.hasVectorEvidence,
      sourceHasAnnotation: page.hasAnnotationEvidence,
      publishedCanonicalImageBlockCount: imageBlocks,
      requiresVisualReview: hasVisual,
      reasonCodes: codes,
      visualFidelityVerified: false,
    };
  });
  return {
    schemaVersion: PDF_VISUAL_AUDIT_SCHEMA_VERSION,
    status: visual > 0 ? "VISUAL_REVIEW_REQUIRED" : "NO_VISUAL_SOURCE_EVIDENCE",
    physicalPageCount: pages.length,
    mixedTextVisualPageCount: mixed,
    visualEvidencePageCount: visual,
    rasterPageMissingImageBlockCount: rasterMissing,
    pages,
    imageToTextAnchorsVerified: false,
    figureSemanticsVerified: false,
    independentImageReferenceAvailable: false,
  };
}
