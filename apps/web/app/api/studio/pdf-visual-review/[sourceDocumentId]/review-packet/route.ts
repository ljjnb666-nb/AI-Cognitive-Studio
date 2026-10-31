import { NextResponse } from "next/server";
import { prisma } from "@ai-cognitive/db";
import { auth } from "@/lib/auth";
import { resolveWebIdentity } from "@/lib/identity";
import { sourceDetail } from "@/lib/product";
import { isAuthenticatedPdfVisualRequest } from "@/lib/pdf-visual-request-policy";
import { projectPdfPageEvidence } from "@/lib/pdf-page-review";
import { projectStoredPdfVisualCandidate } from "@/lib/pdf-visual-candidate";
import { buildPdfSourceGraphReviewPacket } from "@/lib/pdf-source-graph-packet";

export const runtime = "nodejs";
type Params = { params: Promise<{ sourceDocumentId: string }> };
const headers = { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin" };
const result = (value: object, status = 200) => NextResponse.json(value, { status, headers });

/** A private, read-only packet for a downstream independent reviewer.
 * No AI calls, receipts, approvals, publishing, or database writes.
 * A development bootstrap identity is never sufficient to read a raw page.
 */
export async function GET(request: Request, { params }: Params) {
  const session = await auth.api.getSession({
    headers: request.headers, query: { disableCookieCache: true },
  }).catch(() => null);
  if (!session?.user?.id) return result({ error: "WEB_IDENTITY_REQUIRED" }, 401);
  const identity = await resolveWebIdentity().catch(() => null);
  if (!identity || !isAuthenticatedPdfVisualRequest(session.user.id, identity.userId))
    return result({ error: "WEB_IDENTITY_REQUIRED" }, 401);
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: identity.workspaceId, userId: identity.userId } },
    select: { userId: true },
  });
  if (!member) return result({ error: "PDF_REVIEW_ACCESS_DENIED" }, 403);

  const { sourceDocumentId } = await params;
  const rawPage = new URL(request.url).searchParams.get("page") ?? "0";
  if (!/^[a-z0-9]{10,32}$/.test(sourceDocumentId) ||
      !/^(0|[1-9][0-9]{0,3})$/.test(rawPage) || Number(rawPage) > 1999)
    return result({ error: "PDF_REVIEW_PAGE_INVALID" }, 400);
  const physicalPageIndex = Number(rawPage);

  try {
    const source = await sourceDetail(sourceDocumentId, identity);
    const current = source.currentExtraction?.extraction;
    if (source.mediaType !== "application/pdf" || !current || current.status !== "SUCCEEDED")
      return result({ error: "PDF_REVIEW_SOURCE_NOT_READY" }, 404);
    const run = await prisma.ingestionRun.findFirst({
      where: {
        id: current.ingestionRunId,
        workspaceId: source.workspaceId,
        sourceDocumentId: source.id,
        status: "SUCCEEDED",
        sourceDocument: { sha256: source.sha256, mediaType: "application/pdf" },
      },
      select: { routingGeneration: true },
    });
    if (!run?.routingGeneration || run.routingGeneration < 1)
      return result({ error: "PDF_REVIEW_SOURCE_NOT_READY" }, 404);

    const sourcePage = await prisma.sourcePage.findFirst({
      where: { extractionId: current.id, physicalPageIndex },
      select: { id: true, physicalPageIndex: true },
    });
    if (!sourcePage || sourcePage.physicalPageIndex !== physicalPageIndex)
      return result({ error: "PDF_REVIEW_PAGE_UNAVAILABLE" }, 404);

    const [blockCount, blocks, candidate] = await Promise.all([
      prisma.sourceBlock.count({ where: { extractionId: current.id, sourcePageId: sourcePage.id } }),
      prisma.sourceBlock.findMany({
        where: { extractionId: current.id, sourcePageId: sourcePage.id },
        select: { id: true, ordinal: true, kind: true, text: true },
        orderBy: { ordinal: "asc" }, take: 17,
      }),
      prisma.pdfVisualReviewCandidate.findFirst({
        where: {
          workspaceId: source.workspaceId, sourceDocumentId: source.id,
          ingestionRunId: current.ingestionRunId, routingGeneration: run.routingGeneration,
          physicalPageIndex, sourcePdfSha256: source.sha256, expiresAt: { gt: new Date() },
        },
        select: {
          physicalPageIndex: true, sourcePdfSha256: true, sourcePngSha256: true,
          routingGeneration: true, candidateJson: true, candidateSha256: true, expiresAt: true,
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    const evidence = projectPdfPageEvidence({
      sourceSha256: source.sha256, physicalPageIndex,
      recordedPageIndex: sourcePage.physicalPageIndex,
      sourceBlockCount: blockCount, blocks,
    });
    const visual = projectStoredPdfVisualCandidate(candidate, {
      physicalPageIndex, sourcePdfSha256: source.sha256, routingGeneration: run.routingGeneration,
    });
    return result(buildPdfSourceGraphReviewPacket({
      workspaceId: source.workspaceId, sourceDocumentId: source.id,
      extractionId: current.id, ingestionRunId: current.ingestionRunId,
      routingGeneration: run.routingGeneration, evidence, visual,
    }));
  } catch {
    // No tenant, storage key, parser output or internal DB detail in errors.
    return result({ error: "PDF_REVIEW_PACKET_UNAVAILABLE" }, 404);
  }
}
