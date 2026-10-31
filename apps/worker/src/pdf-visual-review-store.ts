import { randomUUID } from "node:crypto";
import { pdfReviewCandidateFingerprint } from "@ai-cognitive/domain";
import { prisma } from "@ai-cognitive/db";
import { validatePdfVisualStructureCandidate, type PdfVisualStructureResult } from "@ai-cognitive/ingestion";

/** Only source-bound structured graph is retained; not source PDF, PNG, prompts or canonical text. */
export const PDF_VISUAL_CANDIDATE_TTL_MS = 24 * 60 * 60 * 1000;

export type StorePdfVisualCandidateIdentity = {
  workspaceId: string;
  sourceDocumentId: string;
  ingestionRunId: string;
  routingGeneration: number;
  sourcePdfSha256: string;
};

export function buildPdfVisualReviewStorageRows(
  identity: StorePdfVisualCandidateIdentity,
  output: PdfVisualStructureResult,
  now = new Date(),
) {
  if (!identity.workspaceId || !identity.sourceDocumentId || !identity.ingestionRunId ||
      !Number.isSafeInteger(identity.routingGeneration) || identity.routingGeneration < 1 ||
      !/^[0-9a-f]{64}$/.test(identity.sourcePdfSha256) ||
      output.schemaVersion !== "pdf-visual-structure-v1" ||
      output.authority !== "UNVERIFIED_VISUAL_CANDIDATE" ||
      output.goldApproved !== false || output.nativeTextUnchanged !== true ||
      output.productionRoutingChanged !== false ||
      !Number.isSafeInteger(output.pageCount) || output.pageCount < 1 ||
      output.examinedPageCount !== output.pages.length || output.pages.length > 2 ||
      !Number.isFinite(now.getTime())) {
    throw new Error("PDF_VISUAL_CANDIDATE_AUTHORITY_INVALID");
  }
  const expiresAt = new Date(now.getTime() + PDF_VISUAL_CANDIDATE_TTL_MS);
  const seen = new Set<number>();
  return output.pages.flatMap(page => {
    if (!Number.isSafeInteger(page.physicalPageIndex) || page.physicalPageIndex < 0 ||
        page.physicalPageIndex >= output.pageCount || seen.has(page.physicalPageIndex) ||
        page.sourceSha256 !== identity.sourcePdfSha256 ||
        !/^[0-9a-f]{64}$/.test(page.pngSha256) ||
        page.authority !== "UNVERIFIED_VISUAL_CANDIDATE" ||
        page.figureSemantics !== "UNVERIFIED") {
      throw new Error("PDF_VISUAL_CANDIDATE_AUTHORITY_INVALID");
    }
    seen.add(page.physicalPageIndex);
    if (page.status === "REVIEW_REQUIRED") {
      if (page.figures.length !== 0 || !page.failureReason)
        throw new Error("PDF_VISUAL_CANDIDATE_AUTHORITY_INVALID");
      return [];
    }
    if (page.status !== "CANDIDATE_AVAILABLE" || page.failureReason !== undefined)
      throw new Error("PDF_VISUAL_CANDIDATE_AUTHORITY_INVALID");
    const figures = validatePdfVisualStructureCandidate({ schemaVersion: 1, figures: page.figures });
    if (figures.length === 0) return [];
    const candidateJson = { schemaVersion: 1 as const, figures };
    if (Buffer.byteLength(JSON.stringify(candidateJson), "utf8") > 32_000)
      throw new Error("PDF_VISUAL_CANDIDATE_SIZE_EXCEEDED");
    return [{
      id: randomUUID(), workspaceId: identity.workspaceId,
      sourceDocumentId: identity.sourceDocumentId,
      ingestionRunId: identity.ingestionRunId,
      physicalPageIndex: page.physicalPageIndex,
      routingGeneration: identity.routingGeneration,
      sourcePdfSha256: identity.sourcePdfSha256,
      sourcePngSha256: page.pngSha256,
      candidateJson,
      candidateSha256: pdfReviewCandidateFingerprint(candidateJson),
      expiresAt,
    }];
  });
}

/** Same source/run/page/PNG is immutable. Duplicate replay never overwrites a prior graph. */
export async function persistPdfVisualReviewCandidates(
  identity: StorePdfVisualCandidateIdentity,
  output: PdfVisualStructureResult,
): Promise<number> {
  const rows = buildPdfVisualReviewStorageRows(identity, output);
  if (!rows.length) return 0;
  return prisma.$transaction(async tx => {
    const run = await tx.ingestionRun.findFirst({
      where: {
        id: identity.ingestionRunId,
        workspaceId: identity.workspaceId,
        sourceDocumentId: identity.sourceDocumentId,
        status: "SUCCEEDED",
        routingGeneration: identity.routingGeneration,
        sourceDocument: { sha256: identity.sourcePdfSha256, mediaType: "application/pdf" },
      },
      select: { id: true },
    });
    if (!run) throw new Error("PDF_VISUAL_CANDIDATE_SOURCE_STALE");
    let stored = 0;
    for (const row of rows) {
      const existing = await tx.pdfVisualReviewCandidate.upsert({
        where: {
          ingestionRunId_physicalPageIndex_routingGeneration_sourcePngSha256: {
            ingestionRunId: row.ingestionRunId,
            physicalPageIndex: row.physicalPageIndex,
            routingGeneration: row.routingGeneration,
            sourcePngSha256: row.sourcePngSha256,
          },
        },
        create: row,
        update: {},
        select: {
          workspaceId: true, sourceDocumentId: true, sourcePdfSha256: true,
          candidateSha256: true, expiresAt: true,
        },
      });
      if (existing.workspaceId !== row.workspaceId ||
          existing.sourceDocumentId !== row.sourceDocumentId ||
          existing.sourcePdfSha256 !== row.sourcePdfSha256 ||
          existing.candidateSha256 !== row.candidateSha256 ||
          existing.expiresAt <= new Date()) {
        throw new Error("PDF_VISUAL_CANDIDATE_REPLAY_CONFLICT");
      }
      stored++;
    }
    return stored;
  });
}
