import { z } from "zod";
import { prisma } from "@ai-cognitive/db";
import { pdfReviewCandidateFingerprint, validatePdfVisualStructureCandidate } from "@ai-cognitive/ingestion";

export const pdfHumanReviewActionSchema = z.strictObject({
  candidateId: z.string().cuid(),
  candidateSha256: z.string().regex(/^[0-9a-f]{64}$/),
  previousEventId: z.string().cuid().nullable(),
  action: z.enum(["CONFIRM_STRUCTURE","REJECT_STRUCTURE","WITHDRAW"]),
  comparedWithOriginalPdf: z.literal(true),
});
export type PdfHumanReviewAction = z.infer<typeof pdfHumanReviewActionSchema>;

export function assertPdfHumanReviewTransition(
  previous: { id: string; action: string } | null,
  input: Pick<PdfHumanReviewAction, "action" | "previousEventId">,
) {
  if ((previous?.id ?? null) !== input.previousEventId)
    throw new Error("PDF_HUMAN_REVIEW_CONFLICT");
  if (input.action === "WITHDRAW") {
    if (!previous || previous.action === "WITHDRAW")
      throw new Error("PDF_HUMAN_REVIEW_TRANSITION_INVALID");
  } else if (previous && previous.action !== "WITHDRAW") {
    throw new Error("PDF_HUMAN_REVIEW_WITHDRAW_FIRST");
  }
}

export async function submitPdfHumanReview(input: {
  workspaceId: string;
  sourceDocumentId: string;
  reviewerUserId: string;
  submission: PdfHumanReviewAction;
}): Promise<{ eventId: string; action: PdfHumanReviewAction["action"] }> {
  const { workspaceId, sourceDocumentId, reviewerUserId, submission } = input;
  return prisma.$transaction(async tx => {
    const member = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: reviewerUserId } },
      select: { role: true },
    });
    if (!member || member.role === "VIEWER")
      throw new Error("PDF_HUMAN_REVIEW_FORBIDDEN");
    // Parameterized advisory lock ensures simultaneous reviewers cannot
    // both commit against the same stale previousEventId.
    const lock = await tx.$queryRawUnsafe<Array<{ locked: number }>>(
      "SELECT 1::integer AS locked FROM (SELECT pg_advisory_xact_lock(hashtext($1))) AS lock_guard",
      submission.candidateId,
    );
    if (lock.length !== 1) throw new Error("PDF_HUMAN_REVIEW_LOCK_FAILED");
    const source = await tx.sourceDocument.findFirst({
      where: { id: sourceDocumentId, workspaceId, mediaType: "application/pdf" },
      select: {
        sha256: true, currentExtraction: { select: {
          extraction: { select: { ingestionRunId: true } },
        } },
      },
    });
    const currentRunId = source?.currentExtraction?.extraction.ingestionRunId;
    if (!source || !currentRunId) throw new Error("PDF_HUMAN_REVIEW_SOURCE_STALE");
    const candidate = await tx.pdfVisualReviewCandidate.findFirst({
      where: {
        id: submission.candidateId, workspaceId, sourceDocumentId,
        ingestionRunId: currentRunId, sourcePdfSha256: source.sha256,
        expiresAt: { gt: new Date() },
        ingestionRun: { status: "SUCCEEDED" },
      },
      select: {
        id: true, sourcePdfSha256: true, candidateSha256: true, candidateJson: true,
        routingGeneration: true,
      },
    });
    if (!candidate || candidate.candidateSha256 !== submission.candidateSha256)
      throw new Error("PDF_HUMAN_REVIEW_CANDIDATE_STALE");
    const run = await tx.ingestionRun.findFirst({
      where: { id: currentRunId, workspaceId, sourceDocumentId,
        routingGeneration: candidate.routingGeneration },
      select: { id: true },
    });
    if (!run) throw new Error("PDF_HUMAN_REVIEW_RUN_STALE");
    const figures = validatePdfVisualStructureCandidate(candidate.candidateJson);
    if (figures.length < 1 ||
        pdfReviewCandidateFingerprint(candidate.candidateJson) !== candidate.candidateSha256)
      throw new Error("PDF_HUMAN_REVIEW_INTEGRITY_INVALID");
    const previous = await tx.pdfVisualHumanReviewEvent.findFirst({
      where: { candidateId: candidate.id, workspaceId, sourceDocumentId },
      select: { id: true, action: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    assertPdfHumanReviewTransition(previous, submission);
    const recorded = await tx.pdfVisualHumanReviewEvent.create({
      data: {
        candidateId: candidate.id, workspaceId, sourceDocumentId,
        reviewerUserId, sourcePdfSha256: candidate.sourcePdfSha256,
        candidateSha256: candidate.candidateSha256, action: submission.action,
      },
      select: { id: true, action: true },
    });
    return { eventId: recorded.id, action: submission.action as PdfHumanReviewAction["action"] };
  });
}
