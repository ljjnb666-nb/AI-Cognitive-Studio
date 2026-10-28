import { randomUUID } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import type { PdfVisualReviewWorkerTask } from "./pdf-visual-review.js";

type Execute = (task: PdfVisualReviewWorkerTask) => Promise<{
  persistedVisualContent: boolean;
  reviewPacket: { pages: Array<{ visual: { status: string; figures: unknown[] } }> };
}>;

/**
 * Durable at-most-once paid model admission.
 * A request claimed before a crash is NOT retried automatically:
 * expensive uncertain outcomes require operator reconciliation, never replay.
 */
export async function processNextPdfVisualUserRequest(execute: Execute): Promise<"IDLE" | "DONE"> {
  const now = new Date();
  await prisma.pdfVisualReviewRequest.updateMany({
    where: { status: "PENDING", expiresAt: { lte: now } },
    data: { status: "FAILED", failureCode: "PDF_VISUAL_REQUEST_EXPIRED", completedAt: now },
  });
  const candidate = await prisma.pdfVisualReviewRequest.findFirst({
    where: { status: "PENDING", expiresAt: { gt: now } },
    select: {
      id: true, workspaceId: true, userId: true, sourceDocumentId: true,
      ingestionRunId: true, routingGeneration: true, sourcePdfSha256: true,
    },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return "IDLE";
  const token = randomUUID();
  const claim = await prisma.pdfVisualReviewRequest.updateMany({
    where: { id: candidate.id, status: "PENDING", expiresAt: { gt: new Date() }, claimToken: null },
    data: { status: "RUNNING", startedAt: new Date(), claimToken: token },
  });
  if (claim.count !== 1) return "IDLE";

  let status: "SUCCEEDED" | "NO_FIGURES" | "FAILED" = "FAILED";
  let failureCode: string | null = "PDF_VISUAL_REQUEST_FAILED";
  try {
    const run = await prisma.ingestionRun.findFirst({
      where: {
        id: candidate.ingestionRunId,
        workspaceId: candidate.workspaceId,
        sourceDocumentId: candidate.sourceDocumentId,
        routingGeneration: candidate.routingGeneration,
        status: "SUCCEEDED",
        sourceDocument: {
          sha256: candidate.sourcePdfSha256, mediaType: "application/pdf",
        },
      },
      select: { id: true },
    });
    if (!run) throw new Error("PDF_VISUAL_REQUEST_STALE");
    // Recheck paid-action role at execution, not just on original browser POST.
    // A revoked member or downgraded VIEWER must never send a private book page
    // to an external model or charge this workspace.
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: {
        workspaceId: candidate.workspaceId, userId: candidate.userId,
      } },
      select: { role: true },
    });
    if (!member || member.role === "VIEWER") {
      throw new Error("PDF_VISUAL_REQUEST_ACCESS_REVOKED");
    }
    const outcome = await execute({
      enabled: true,
      allowExternalVisualModel: true,
      persistReviewCandidate: true,
      workspaceId: candidate.workspaceId,
      userId: candidate.userId,
      sourceDocumentId: candidate.sourceDocumentId,
      ingestionRunId: candidate.ingestionRunId,
      maxReviewPages: 1,
    });
    const failed = outcome.reviewPacket.pages.some(p => p.visual.status === "REVIEW_REQUIRED");
    status = failed ? "FAILED" : outcome.persistedVisualContent ? "SUCCEEDED" : "NO_FIGURES";
    failureCode = failed ? "PDF_VISUAL_MODEL_REVIEW_REQUIRED" : null;
  } catch {
    // Never expose original source text, provider credentials or remote errors.
    status = "FAILED";
    failureCode = "PDF_VISUAL_REQUEST_FAILED";
  }
  const final = await prisma.pdfVisualReviewRequest.updateMany({
    where: { id: candidate.id, status: "RUNNING", claimToken: token },
    data: { status, failureCode, completedAt: new Date(), claimToken: null },
  });
  if (final.count !== 1) throw new Error("PDF_VISUAL_REQUEST_CLAIM_LOST");
  return "DONE";
}
