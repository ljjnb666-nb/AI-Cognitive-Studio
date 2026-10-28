import { createHash } from "node:crypto";
import type { extractNativePdf, PdfVisualStructureResult, VisualFigureCandidate } from "@ai-cognitive/ingestion";

/**
 * A bounded, source-linked review projection. Not a canonical extraction, a
 * visual-Gold approval, or a stored/released book fact. Never log its text.
 */
export const PDF_SOURCE_REVIEW_PACKET_VERSION = "pdf-source-review-packet-v1" as const;
export const PDF_SOURCE_REVIEW_TEXT_LIMIT = 4_000;
export const PDF_SOURCE_REVIEW_BLOCK_LIMIT = 16;
const HASH = /^[0-9a-f]{64}$/;

type NativeExtraction = Awaited<ReturnType<typeof extractNativePdf>>;

export type PdfSourceReviewPage = {
  physicalPageIndex: number;
  sourcePdfSha256: string;
  sourcePngSha256: string;
  nativeText: {
    status: "EXTRACTED_UNVERIFIED";
    sourceMethod: "PDFJS_NATIVE";
    sourceBlockCount: number;
    /** Character budget is fixed; a preview cannot claim complete coverage. */
    excerpt: string;
    excerptTruncated: boolean;
  };
  visual: {
    status: "CANDIDATE_UNVERIFIED" | "REVIEW_REQUIRED";
    figures: VisualFigureCandidate[];
    failureReason: "VISION_REJECTED" | "INVALID_STRUCTURE" | null;
  };
  reviewRequired: true;
  approvedForBookIntelligence: false;
  approvedForPodcast: false;
};

export type PdfSourceReviewPacket = {
  schemaVersion: typeof PDF_SOURCE_REVIEW_PACKET_VERSION;
  authority: "SOURCE_BOUND_REVIEW_ONLY";
  sourcePdfSha256: string;
  totalPhysicalPages: number;
  examinedPages: number;
  pages: PdfSourceReviewPage[];
  independentGoldApproved: false;
  canonicalTextUpdated: false;
  persistedReviewCandidate: false;
  approvedForBookIntelligence: false;
  approvedForPodcast: false;
};

function reject(): never {
  throw new Error("PDF_REVIEW_PACKET_SOURCE_OR_AUTHORITY_INVALID");
}

export function buildPdfSourceReviewPacket(
  pdfBytes: Uint8Array,
  native: NativeExtraction,
  vision: PdfVisualStructureResult,
): PdfSourceReviewPacket {
  const sourceSha256 = createHash("sha256").update(pdfBytes).digest("hex");
  if (!HASH.test(sourceSha256) || native.pageCount < 1 ||
      native.pages.length !== native.pageCount ||
      native.routingPlan.pages.length !== native.pageCount ||
      vision.pageCount !== native.pageCount ||
      vision.examinedPageCount !== vision.pages.length ||
      vision.pages.length > 2 ||
      vision.authority !== "UNVERIFIED_VISUAL_CANDIDATE" ||
      vision.goldApproved !== false ||
      vision.productionRoutingChanged !== false ||
      vision.nativeTextUnchanged !== true) reject();

  const pages: PdfSourceReviewPage[] = [];
  const seen = new Set<number>();
  for (const visual of vision.pages) {
    const i = visual.physicalPageIndex;
    if (!Number.isSafeInteger(i) || i < 0 || i >= native.pageCount || seen.has(i) ||
        visual.sourceSha256 !== sourceSha256 || !HASH.test(visual.pngSha256) ||
        visual.authority !== "UNVERIFIED_VISUAL_CANDIDATE" ||
        visual.figureSemantics !== "UNVERIFIED" ||
        (visual.status !== "CANDIDATE_AVAILABLE" && visual.status !== "REVIEW_REQUIRED")) reject();
    seen.add(i);
    const nativePage = native.pages[i];
    const routingPage = native.routingPlan.pages[i];
    if (!nativePage || nativePage.physicalPageIndex !== i ||
        !routingPage || routingPage.physicalPageIndex !== i ||
        routingPage.route !== "NATIVE_TEXT" || !nativePage.inspection.hasTextEvidence ||
        nativePage.blocks.length < 1) reject();
    const snippets: string[] = [];
    let remaining = PDF_SOURCE_REVIEW_TEXT_LIMIT;
    let nonemptyBlocks = 0;
    for (const block of nativePage.blocks) {
      if (typeof block.text !== "string") reject();
      if (!block.text.trim()) continue;
      nonemptyBlocks++;
      if (nonemptyBlocks > PDF_SOURCE_REVIEW_BLOCK_LIMIT || remaining <= 0) continue;
      if (snippets.length) {
        snippets.push("\n");
        remaining--;
      }
      if (remaining > 0) {
        const snippet = block.text.slice(0, remaining);
        snippets.push(snippet);
        remaining -= snippet.length;
      }
    }
    if (nonemptyBlocks < 1) reject();
    if (visual.status === "CANDIDATE_AVAILABLE" && visual.failureReason) reject();
    if (visual.status === "REVIEW_REQUIRED" && !visual.failureReason) reject();
    pages.push({
      physicalPageIndex: i,
      sourcePdfSha256: sourceSha256,
      sourcePngSha256: visual.pngSha256,
      nativeText: {
        status: "EXTRACTED_UNVERIFIED",
        sourceMethod: "PDFJS_NATIVE",
        sourceBlockCount: nonemptyBlocks,
        excerpt: snippets.join(""),
        // Deliberately a preview, not a representation of all PDF text:
        excerptTruncated: remaining === 0 || nonemptyBlocks > PDF_SOURCE_REVIEW_BLOCK_LIMIT,
      },
      visual: {
        status: visual.status === "CANDIDATE_AVAILABLE" ? "CANDIDATE_UNVERIFIED" : "REVIEW_REQUIRED",
        figures: visual.figures,
        failureReason: visual.failureReason ?? null,
      },
      reviewRequired: true,
      approvedForBookIntelligence: false,
      approvedForPodcast: false,
    });
  }
  return {
    schemaVersion: PDF_SOURCE_REVIEW_PACKET_VERSION,
    authority: "SOURCE_BOUND_REVIEW_ONLY",
    sourcePdfSha256: sourceSha256,
    totalPhysicalPages: native.pageCount,
    examinedPages: pages.length,
    pages,
    independentGoldApproved: false,
    canonicalTextUpdated: false,
    persistedReviewCandidate: false,
    approvedForBookIntelligence: false,
    approvedForPodcast: false,
  };
}
