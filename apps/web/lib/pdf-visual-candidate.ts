import { pdfReviewCandidateFingerprint, validatePdfVisualStructureCandidate } from "@ai-cognitive/ingestion";

type CandidateRow = {
  physicalPageIndex: number;
  sourcePdfSha256: string;
  sourcePngSha256: string;
  routingGeneration: number;
  candidateJson: unknown;
  candidateSha256: string;
  expiresAt: Date;
};

export function projectStoredPdfVisualCandidate(
  row: CandidateRow | null,
  expected: { physicalPageIndex: number; sourcePdfSha256: string; routingGeneration: number },
  now = new Date(),
) {
  if (!row) return null;
  if (!/^[0-9a-f]{64}$/.test(expected.sourcePdfSha256) ||
      !Number.isSafeInteger(expected.physicalPageIndex) || expected.physicalPageIndex < 0 ||
      !Number.isSafeInteger(expected.routingGeneration) || expected.routingGeneration < 1 ||
      row.sourcePdfSha256 !== expected.sourcePdfSha256 ||
      row.physicalPageIndex !== expected.physicalPageIndex ||
      row.routingGeneration !== expected.routingGeneration ||
      !/^[0-9a-f]{64}$/.test(row.sourcePngSha256) ||
      !/^[0-9a-f]{64}$/.test(row.candidateSha256) ||
      !(row.expiresAt instanceof Date) || !Number.isFinite(now.getTime()) ||
      row.expiresAt <= now) throw new Error("PDF_VISUAL_READ_SOURCE_OR_EXPIRY_INVALID");
  const figures = validatePdfVisualStructureCandidate(row.candidateJson);
  if (figures.length === 0 ||
      pdfReviewCandidateFingerprint(row.candidateJson) !== row.candidateSha256)
    throw new Error("PDF_VISUAL_READ_CANDIDATE_INTEGRITY_INVALID");
  return {
    authority: "UNVERIFIED_VISUAL_CANDIDATE" as const,
    reviewStatus: "NOT_REVIEWED" as const,
    approvedForPodcast: false as const,
    approvedForBookIntelligence: false as const,
    sourcePngSha256: row.sourcePngSha256,
    candidateSha256: row.candidateSha256,
    expiresAt: row.expiresAt.toISOString(),
    figures,
  };
}
