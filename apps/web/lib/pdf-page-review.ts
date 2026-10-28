/**
 * Server-side view policy for a PDF's *existing* canonical source blocks.
 * These are parsing evidence, NOT independently approved Gold or the output
 * of the opt-in visual-review Worker. No model/DB writes occur here.
 */
export const PDF_REVIEW_PREVIEW_MAX_BLOCKS = 16;
export const PDF_REVIEW_PREVIEW_MAX_CHARS = 6_000;

export type PdfReviewInputBlock = {
  id: string;
  ordinal: number;
  kind: string;
  text: string;
};
export type PdfReviewVisibleBlock = {
  id: string;
  ordinal: number;
  kind: string;
  excerpt: string;
  originalCharacters: number;
  excerptTruncated: boolean;
};
export type PdfPageEvidenceView = {
  authority: "SOURCE_EXTRACTION_ONLY_NOT_GOLD";
  physicalPageIndex: number;
  sourceSha256: string;
  parsedBlocks: PdfReviewVisibleBlock[];
  previewTruncated: boolean;
  sourceBlockCount: number;
  visibleCharacters: number;
  visualStatus: "NO_DURABLE_REVIEW_CANDIDATE";
  reviewStatus: "NOT_REVIEWED";
  approvedForPodcast: false;
  approvedForBookIntelligence: false;
};

export function projectPdfPageEvidence(input: {
  sourceSha256: string;
  physicalPageIndex: number;
  recordedPageIndex: number;
  sourceBlockCount: number;
  blocks: PdfReviewInputBlock[];
}): PdfPageEvidenceView {
  if (!/^[a-f0-9]{64}$/.test(input.sourceSha256) ||
      !Number.isSafeInteger(input.physicalPageIndex) || input.physicalPageIndex < 0 ||
      input.recordedPageIndex !== input.physicalPageIndex ||
      !Number.isSafeInteger(input.sourceBlockCount) || input.sourceBlockCount < 0 ||
      !Array.isArray(input.blocks) || input.blocks.length > PDF_REVIEW_PREVIEW_MAX_BLOCKS + 1 ||
      input.sourceBlockCount < input.blocks.length) {
    throw new Error("PDF_REVIEW_SOURCE_IDENTITY_INVALID");
  }
  const parsedBlocks: PdfReviewVisibleBlock[] = [];
  let remaining = PDF_REVIEW_PREVIEW_MAX_CHARS;
  for (const block of input.blocks.slice(0, PDF_REVIEW_PREVIEW_MAX_BLOCKS)) {
    if (typeof block.id !== "string" || !block.id ||
        !Number.isSafeInteger(block.ordinal) || block.ordinal < 0 ||
        typeof block.kind !== "string" ||
        typeof block.text !== "string") throw new Error("PDF_REVIEW_BLOCK_INVALID");
    const excerpt = block.text.slice(0, remaining);
    parsedBlocks.push({
      id: block.id,
      ordinal: block.ordinal,
      kind: block.kind,
      excerpt,
      originalCharacters: block.text.length,
      excerptTruncated: excerpt.length < block.text.length,
    });
    remaining -= excerpt.length;
  }
  return {
    authority: "SOURCE_EXTRACTION_ONLY_NOT_GOLD",
    physicalPageIndex: input.physicalPageIndex,
    sourceSha256: input.sourceSha256,
    parsedBlocks,
    previewTruncated: remaining === 0 || input.sourceBlockCount > parsedBlocks.length ||
      parsedBlocks.some((block) => block.excerptTruncated),
    sourceBlockCount: input.sourceBlockCount,
    visibleCharacters: PDF_REVIEW_PREVIEW_MAX_CHARS - remaining,
    visualStatus: "NO_DURABLE_REVIEW_CANDIDATE",
    reviewStatus: "NOT_REVIEWED",
    approvedForPodcast: false,
    approvedForBookIntelligence: false,
  };
}
