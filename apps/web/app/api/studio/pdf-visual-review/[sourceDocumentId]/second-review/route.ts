import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@ai-cognitive/db";
import { auth } from "@/lib/auth";
import { resolveWebIdentity, type WebIdentityContext } from "@/lib/identity";
import { sourceDetail } from "@/lib/product";
import { isAuthenticatedPdfVisualRequest, isTrustedPdfVisualRequestOrigin } from "@/lib/pdf-visual-request-policy";
import { pdfGraphSecondReviewConsentSchema } from "@/lib/pdf-graph-second-review-policy";
import { projectStoredPdfVisualCandidate } from "@/lib/pdf-visual-candidate";

export const runtime = "nodejs";
type Params = { params: Promise<{ sourceDocumentId: string }> };
const respond = (body: object, status = 200) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
});
const enabled = () => process.env.PDF_GRAPH_SECOND_REVIEW_REQUEST_ENABLED === "true";
const validId = (id: string) => /^[a-z0-9]{10,32}$/.test(id);

/** A second billed request never trusts development/bootstrap identities. */
async function identityFromSession(request: Request): Promise<WebIdentityContext | null> {
  const session = await auth.api.getSession({
    headers: request.headers, query: { disableCookieCache: true },
  }).catch(() => null);
  if (!session?.user?.id) return null;
  const identity = await resolveWebIdentity().catch(() => null);
  return identity && isAuthenticatedPdfVisualRequest(session.user.id, identity.userId) ? identity : null;
}

async function currentSource(sourceDocumentId: string, identity: WebIdentityContext) {
  if (!validId(sourceDocumentId)) throw Error("SOURCE_DOCUMENT_ACCESS_DENIED");
  const source = await sourceDetail(sourceDocumentId, identity);
  const extraction = source.currentExtraction?.extraction;
  if (source.mediaType !== "application/pdf" || !extraction ||
      extraction.status !== "SUCCEEDED") throw Error("SECOND_REVIEW_SOURCE_NOT_READY");
  const run = await prisma.ingestionRun.findFirst({
    where: { id: extraction.ingestionRunId, workspaceId: identity.workspaceId,
      sourceDocumentId: source.id, status: "SUCCEEDED",
      sourceDocument: { sha256: source.sha256, mediaType: "application/pdf" } },
    select: { id: true, routingGeneration: true },
  });
  if (!run?.routingGeneration || run.routingGeneration < 1)
    throw Error("SECOND_REVIEW_SOURCE_NOT_READY");
  return { source, extraction, run };
}

/** Read authorization status only; no provider, storage or result consumption. */
export async function GET(request: Request, { params }: Params) {
  const identity = await identityFromSession(request);
  if (!identity) return respond({ error: "WEB_IDENTITY_REQUIRED" }, 401);
  const { sourceDocumentId } = await params;
  const page = new URL(request.url).searchParams.get("page");
  if (!validId(sourceDocumentId) || page === null ||
      !/^(0|[1-9][0-9]{0,3})$/.test(page) || Number(page) > 1999)
    return respond({ error: "PDF_GRAPH_SECOND_REVIEW_PAGE_INVALID" }, 400);
  try {
    const { source, run } = await currentSource(sourceDocumentId, identity);
    const row = await prisma.pdfGraphSecondReviewRequest.findUnique({
      where: { ingestionRunId_routingGeneration_physicalPageIndex: {
        ingestionRunId: run.id, routingGeneration: run.routingGeneration!,
        physicalPageIndex: Number(page),
      } },
      select: { id: true, status: true, failureCode: true, consentRecordedAt: true,
        expiresAt: true, completedAt: true, modelDecision: true },
    });
    return respond({ enabled: enabled(), sourceDocumentId: source.id,
      physicalPageIndex: Number(page), request: row ? {
        requestId: row.id,
        status: row.status === "AUTHORIZED_NOT_DISPATCHED" &&
          row.expiresAt <= new Date() ? "EXPIRED" : row.status,
        failureCode: row.failureCode,
        consentRecordedAt: row.consentRecordedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
        modelDecision: row.modelDecision,
        approvedForPodcast: false,
      } : null });
  } catch {
    return respond({ error: "PDF_GRAPH_SECOND_REVIEW_NOT_AVAILABLE" }, 404);
  }
}

/** Save independent consent only. No Worker is attached and NO model call runs. */
export async function POST(request: Request, { params }: Params) {
  if (!isTrustedPdfVisualRequestOrigin(request.url, request.headers.get("origin"), process.env.BETTER_AUTH_URL))
    return respond({ error: "PDF_GRAPH_SECOND_REVIEW_ORIGIN_DENIED" }, 403);
  if (!enabled()) return respond({ error: "PDF_GRAPH_SECOND_REVIEW_DISABLED" }, 503);
  const identity = await identityFromSession(request);
  if (!identity) return respond({ error: "WEB_IDENTITY_REQUIRED" }, 401);
  try {
    const body: unknown = await request.json();
    const consent = pdfGraphSecondReviewConsentSchema.parse(body);
    const { sourceDocumentId } = await params;
    const { source, extraction, run } = await currentSource(sourceDocumentId, identity);
    if (source.workspaceId !== identity.workspaceId)
      return respond({ error: "PDF_GRAPH_SECOND_REVIEW_ACCESS_DENIED" }, 403);
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: identity.workspaceId, userId: identity.userId } },
      select: { role: true },
    });
    if (!member || member.role === "VIEWER")
      return respond({ error: "PDF_GRAPH_SECOND_REVIEW_ACCESS_DENIED" }, 403);
    const provider = await prisma.providerRouteBinding.findFirst({
      where: { workspaceId: identity.workspaceId, routeSlot: "PDF_VISUAL_STRUCTURE",
        connection: { status: "ACTIVE" } },
      select: { connectionId: true },
    });
    if (!provider) return respond({ error: "PDF_GRAPH_SECOND_REVIEW_PROVIDER_NOT_CONFIGURED" }, 409);
    const sourcePage = await prisma.sourcePage.findFirst({
      where: { extractionId: extraction.id, physicalPageIndex: consent.physicalPageIndex },
      select: { id: true },
    });
    if (!sourcePage) return respond({ error: "PDF_GRAPH_SECOND_REVIEW_PAGE_NOT_FOUND" }, 404);
    const now = new Date();
    const candidate = await prisma.pdfVisualReviewCandidate.findFirst({
      where: {
        workspaceId: identity.workspaceId, sourceDocumentId: source.id,
        ingestionRunId: run.id, routingGeneration: run.routingGeneration!,
        physicalPageIndex: consent.physicalPageIndex,
        sourcePdfSha256: source.sha256, sourcePngSha256: consent.sourcePngSha256,
        candidateSha256: consent.candidateSha256,
        // A newly authorized second call cannot rely on almost-expired input.
        expiresAt: { gt: new Date(now.getTime() + 60_000) },
      },
      select: { physicalPageIndex: true, sourcePdfSha256: true, sourcePngSha256: true,
        routingGeneration: true, candidateJson: true, candidateSha256: true, expiresAt: true },
    });
    if (!candidate) return respond({ error: "PDF_GRAPH_SECOND_REVIEW_CANDIDATE_NOT_AVAILABLE" }, 409);
    projectStoredPdfVisualCandidate(candidate, {
      physicalPageIndex: consent.physicalPageIndex,
      sourcePdfSha256: source.sha256, routingGeneration: run.routingGeneration!,
    }, now);
    const expiresAt = new Date(Math.min(now.getTime() + 10 * 60_000, candidate.expiresAt.getTime()));
    const row = await prisma.pdfGraphSecondReviewRequest.create({
      data: {
        workspaceId: identity.workspaceId, userId: identity.userId,
        sourceDocumentId: source.id, ingestionRunId: run.id,
        routingGeneration: run.routingGeneration!,
        physicalPageIndex: consent.physicalPageIndex, sourcePdfSha256: source.sha256,
        sourcePngSha256: candidate.sourcePngSha256,
        candidateSha256: candidate.candidateSha256,
        consentRecordedAt: now, expiresAt, status: "AUTHORIZED_NOT_DISPATCHED",
      },
      select: { id: true },
    });
    return respond({ requestId: row.id, status: "AUTHORIZED_NOT_DISPATCHED",
      modelInvoked: false, approvedForPodcast: false }, 202);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "P2002")
      return respond({ error: "PDF_GRAPH_SECOND_REVIEW_ALREADY_AUTHORIZED" }, 409);
    if (error instanceof z.ZodError)
      return respond({ error: "PDF_GRAPH_SECOND_REVIEW_NEW_EXPLICIT_CONSENT_REQUIRED" }, 400);
    return respond({ error: "PDF_GRAPH_SECOND_REVIEW_REJECTED" }, 403);
  }
}
