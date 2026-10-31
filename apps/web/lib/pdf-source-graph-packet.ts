import type { PdfPageEvidenceView } from "./pdf-page-review";
import type { projectStoredPdfVisualCandidate } from "./pdf-visual-candidate";

export const PDF_SOURCE_GRAPH_PACKET_VERSION = "pdf-source-graph-review-packet-v1" as const;
type VerifiedVisualProjection = NonNullable<ReturnType<typeof projectStoredPdfVisualCandidate>>;

export type PdfSourceGraphPacketInput = {
  workspaceId: string;
  sourceDocumentId: string;
  extractionId: string;
  ingestionRunId: string;
  routingGeneration: number;
  evidence: PdfPageEvidenceView;
  visual: VerifiedVisualProjection | null;
};

/**
 * A *source-linked review input*, not a model verdict or an approved fact.
 * Text is a bounded existing extraction preview; graphs are checked model
 * candidates. Independent validation must still inspect the original image.
 */
export function buildPdfSourceGraphReviewPacket(input: PdfSourceGraphPacketInput) {
  const { evidence, visual } = input;
  if (!input.workspaceId || !input.sourceDocumentId || !input.extractionId ||
      !input.ingestionRunId || !Number.isSafeInteger(input.routingGeneration) ||
      input.routingGeneration < 1 ||
      evidence.authority !== "SOURCE_EXTRACTION_ONLY_NOT_GOLD" ||
      !/^[0-9a-f]{64}$/.test(evidence.sourceSha256) ||
      !Number.isSafeInteger(evidence.physicalPageIndex) || evidence.physicalPageIndex < 0 ||
      !Number.isSafeInteger(evidence.sourceBlockCount) || evidence.sourceBlockCount < 0 ||
      evidence.sourceBlockCount < evidence.parsedBlocks.length ||
      evidence.reviewStatus !== "NOT_REVIEWED" ||
      evidence.approvedForBookIntelligence !== false ||
      evidence.approvedForPodcast !== false ||
      (visual !== null && (
        visual.authority !== "UNVERIFIED_VISUAL_CANDIDATE" ||
        visual.reviewStatus !== "NOT_REVIEWED" ||
        visual.approvedForBookIntelligence !== false ||
        visual.approvedForPodcast !== false ||
        !/^[0-9a-f]{64}$/.test(visual.sourcePngSha256) ||
        !/^[0-9a-f]{64}$/.test(visual.candidateSha256) ||
        visual.figures.length < 1
      ))) {
    throw new Error("PDF_SOURCE_GRAPH_PACKET_AUTHORITY_INVALID");
  }
  const hasVisual = visual !== null;
  return {
    schemaVersion: PDF_SOURCE_GRAPH_PACKET_VERSION,
    authority: "SOURCE_BOUND_UNVERIFIED_REVIEW_INPUT" as const,
    source: {
      workspaceId: input.workspaceId,
      sourceDocumentId: input.sourceDocumentId,
      extractionId: input.extractionId,
      ingestionRunId: input.ingestionRunId,
      routingGeneration: input.routingGeneration,
      physicalPageIndex: evidence.physicalPageIndex,
      pdfSha256: evidence.sourceSha256,
      sourcePngSha256: visual?.sourcePngSha256 ?? null,
    },
    coverage: {
      state: !hasVisual ? "NO_VISUAL_CANDIDATE" as const :
        evidence.previewTruncated ? "TRUNCATED_SOURCE_PREVIEW" as const :
          "SOURCE_TEXT_AND_VISUAL_CANDIDATE" as const,
      originalPageImageRequired: true as const,
      sourceTextPreviewTruncated: evidence.previewTruncated,
      hasGraphCandidate: hasVisual,
    },
    text: {
      source: "CURRENT_DOCUMENT_EXTRACTION" as const,
      sourceBlockCount: evidence.sourceBlockCount,
      visibleCharacters: evidence.visibleCharacters,
      parsedBlocks: evidence.parsedBlocks,
    },
    visual: visual === null ? null : {
      status: "UNVERIFIED_CANDIDATE" as const,
      expiresAt: visual.expiresAt,
      candidateSha256: visual.candidateSha256,
      figures: visual.figures,
    },
    independentModelReviewStatus: "NOT_REVIEWED" as const,
    approvedForBookIntelligence: false as const,
    approvedForPodcast: false as const,
    publishable: false as const,
  };
}
