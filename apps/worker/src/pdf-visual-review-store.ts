import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import { validatePdfVisualStructureCandidate } from "@ai-cognitive/ingestion";
import type { PdfSourceReviewPacket } from "./pdf-source-review-packet.js";

/** No original page PNG, source text excerpt, prompt or credential is persisted. */
export const PDF_VISUAL_CANDIDATE_TTL_MS = 24 * 60 * 60 * 1000;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export type StorePdfVisualCandidateIdentity = {
  workspaceId: string;
  sourceDocumentId: string;
  ingestionRunId: string;
  routingGeneration: number;
  sourcePdfSha256: string;
};

export function buildPdfVisualReviewStorageRows(
  identity: StorePdfVisualCandidateIdentity,
  packet: PdfSourceReviewPacket,
  now = new Date(),
) {
  if (!identity.workspaceId || !identity.sourceDocumentId || !identity.ingestionRunId ||
      !Number.isSafeInteger(identity.routingGeneration) || identity.routingGeneration < 1 ||
      !/^[0-9a-f]{64}$/.test(identity.sourcePdfSha256) ||
      packet.authority !== "SOURCE_BOUND_REVIEW_ONLY" ||
      packet.independentGoldApproved !== false ||
      packet.approvedForBookIntelligence !== false ||
      packet.approvedForPodcast !== false ||
      packet.canonicalTextUpdated !== false ||
      packet.sourcePdfSha256 !== identity.sourcePdfSha256 ||
      packet.examinedPages !== packet.pages.length ||
      packet.pages.length > 2 ||
      !Number.isFinite(now.getTime())) {
    throw new Error("PDF_VISUAL_CANDIDATE_AUTHORITY_INVALID");
  }
  const expiry = new Date(now.getTime() + PDF_VISUAL_CANDIDATE_TTL_MS);
  const seen = new Set<number>();
  return packet.pages.flatMap((page) => {
    if (page.sourcePdfSha256 !== identity.sourcePdfSha256 ||
        !Number.isSafeInteger(page.physicalPageIndex) || page.physicalPageIndex < 0 ||
        page.physicalPageIndex >= packet.totalPhysicalPages ||
        !/^[0-9a-f]{64}$/.test(page.sourcePngSha256) ||
        seen.has(page.physicalPageIndex) ||
        page.reviewRequired !== true || page.approvedForPodcast !== false ||
        page.approvedForBookIntelligence !== false) {
      throw new Error("PDF_VISUAL_CANDIDATE_AUTHORITY_INVALID");
    }
    seen.add(page.physicalPageIndex);
    if (page.visual.status === "REVIEW_REQUIRED") {
      if (page.visual.failureReason === null || page.visual.figures.length !== 0)
        throw new Error("PDF_VISUAL_CANDIDATE_AUTHORITY_INVALID");
      return [];
    }
    if (page.visual.status !== "CANDIDATE_UNVERIFIED" || page.visual.failureReason !== null)
      throw new Error("PDF_VISUAL_CANDIDATE_AUTHORITY_INVALID");
    const figures = validatePdfVisualStructureCandidate({
      schemaVersion: 1, figures: page.visual.figures,
    });
    if (figures.length === 0) return [];
    const candidateJson = { schemaVersion: 1 as const, figures };
    const serialized = JSON.stringify(candidateJson);
    if (Buffer.byteLength(serialized, "utf8") > 32_000)
      throw new Error("PDF_VISUAL_CANDIDATE_SIZE_EXCEEDED");
    return [{
      id: randomUUID(), workspaceId: identity.workspaceId,
      sourceDocumentId: identity.sourceDocumentId,
      ingestionRunId: identity.ingestionRunId,
      physicalPageIndex: page.physicalPageIndex,
      routingGeneration: identity.routingGeneration,
      sourcePdfSha256: identity.sourcePdfSha256,
      sourcePngSha256: page.sourcePngSha256,
      candidateJson,
      candidateSha256: hash(serialized),
      expiresAt: expiry,
    }];
  });
}

export async function persistPdfVisualReviewCandidates(
  identity: StorePdfVisualCandidateIdentity,
  packet: PdfSourceReviewPacket,
): Promise<number> {
  const rows = buildPdfVisualReviewStorageRows(identity, packet);
  if (!rows.length) return 0;
  return prisma.$transaction(async tx => {
    const run = await tx.ingestionRun.findFirst({
      where: {
        id: identity.ingestionRunId,
        workspaceId: identity.workspaceId,
        sourceDocumentId: identity.sourceDocumentId,
        status: "SUCCEEDED",
        routingGeneration: identity.routingGeneration,
        sourceDocument: {
          sha256: identity.sourcePdfSha256, mediaType: "application/pdf",
        },
      }, select: { id: true },
    });
    if (!run) throw new Error("PDF_VISUAL_CANDIDATE_SOURCE_STALE");
    let stored = 0;
    for (const row of rows) {
      const key = {
        ingestionRunId_physicalPageIndex_routingGeneration_sourcePngSha256: {
          ingestionRunId: row.ingestionRunId,
          physicalPageIndex: row.physicalPageIndex,
          routingGeneration: row.routingGeneration,
          sourcePngSha256: row.sourcePngSha256,
        },
      };
      const existing = await tx.pdfVisualReviewCandidate.findUnique({
        where: key,
        select: { workspaceId: true, sourceDocumentId: true, sourcePdfSha256: true, candidateSha256: true, expiresAt: true },
      });
      if (existing) {
        // Replaying the same paid invocation must never rewrite first-seen evidence.
        if (existing.workspaceId !== row.workspaceId ||
            existing.sourceDocumentId !== row.sourceDocumentId ||
            existing.sourcePdfSha256 !== row.sourcePdfSha256 ||
            existing.candidateSha256 !== row.candidateSha256 ||
            existing.expiresAt <= new Date())
          throw new Error("PDF_VISUAL_CANDIDATE_REPLAY_CONFLICT");
        stored++;
        continue;
      }
      await tx.pdfVisualReviewCandidate.create({ data: row });
      stored++;
    }
    return stored;
  });
}
