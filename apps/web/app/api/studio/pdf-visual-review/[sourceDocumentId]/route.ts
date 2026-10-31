import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@ai-cognitive/db";
import { sourceDetail } from "@/lib/product";
import { isSameOriginPdfVisualRequest, pdfVisualRequestConsentSchema } from "@/lib/pdf-visual-request-policy";
import { resolveWebIdentity } from "@/lib/identity";

type Params = { params: Promise<{ sourceDocumentId: string }> };
const statusResponse = (data: object, status = 200) =>
  NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
const enabled = () => process.env.PDF_MIXED_GRAPH_REVIEW_REQUEST_ENABLED === "true";
const validId = (s: string) => /^[a-z0-9]{10,32}$/.test(s);

async function scopedSource(sourceDocumentId: string) {
  if (!validId(sourceDocumentId)) throw new Error("SOURCE_DOCUMENT_ACCESS_DENIED");
  const source = await sourceDetail(sourceDocumentId);
  if (source.mediaType !== "application/pdf" ||
      !source.currentExtraction?.extraction.ingestionRunId)
    throw new Error("PDF_VISUAL_SOURCE_NOT_READY");
  const run = await prisma.ingestionRun.findFirst({
    where: {
      id: source.currentExtraction.extraction.ingestionRunId,
      workspaceId: source.workspaceId,
      sourceDocumentId: source.id,
      status: "SUCCEEDED",
      sourceDocument: { sha256: source.sha256, mediaType: "application/pdf" },
    },
    select: { id: true, routingGeneration: true },
  });
  if (!run || !run.routingGeneration || run.routingGeneration < 1)
    throw new Error("PDF_VISUAL_SOURCE_NOT_READY");
  return { source, run };
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const { sourceDocumentId } = await params;
    const { source, run } = await scopedSource(sourceDocumentId);
    const record = await prisma.pdfVisualReviewRequest.findUnique({
      where: { ingestionRunId_routingGeneration: {
        ingestionRunId: run.id, routingGeneration: run.routingGeneration!,
      } },
      select: { status: true, failureCode: true, createdAt: true, completedAt: true, expiresAt: true },
    });
    const candidate = record?.status === "SUCCEEDED"
      ? await prisma.pdfVisualReviewCandidate.findFirst({
          where: {
            workspaceId: source.workspaceId, sourceDocumentId: source.id,
            ingestionRunId: run.id, routingGeneration: run.routingGeneration!,
            sourcePdfSha256: source.sha256, expiresAt: { gt: new Date() },
          },
          select: { physicalPageIndex: true },
          orderBy: { createdAt: "desc" },
        }) : null;
    return statusResponse({
      enabled: enabled(),
      candidatePhysicalPageIndex: candidate?.physicalPageIndex ?? null,
      mode: "FIRST_MIXED_PAGE",
      request: record ? {
        status: record.status === "PENDING" && record.expiresAt <= new Date() ? "EXPIRED" :
          record.status === "RUNNING" && record.expiresAt <= new Date() ? "INTERRUPTED" : record.status,
        failureCode: record.failureCode,
        createdAt: record.createdAt.toISOString(),
        completedAt: record.completedAt?.toISOString() ?? null,
      } : null,
      sourceDocumentId: source.id,
    });
  } catch {
    return statusResponse({ error: "PDF_VISUAL_REQUEST_NOT_AVAILABLE" }, 404);
  }
}

export async function POST(request: Request, { params }: Params) {
  // Same-origin POST + strict content contract; never use a cookie-only cross-site
  // request to purchase external model calls.
  const origin = request.headers.get("origin");
  if (!isSameOriginPdfVisualRequest(request.url, origin))
    return statusResponse({ error: "PDF_VISUAL_REQUEST_ORIGIN_DENIED" }, 403);
  if (!enabled()) return statusResponse({ error: "PDF_VISUAL_REQUEST_DISABLED" }, 503);
  try {
    const raw: unknown = await request.json();
    pdfVisualRequestConsentSchema.parse(raw);
    const { sourceDocumentId } = await params;
    const { source, run } = await scopedSource(sourceDocumentId);
    const identity = await resolveWebIdentity();
    // A VIEWER can inspect authorized source evidence, but cannot authorize
    // third-party image processing or incur workspace provider charges.
    if (identity.workspaceId !== source.workspaceId) {
      return statusResponse({ error: "PDF_VISUAL_REQUEST_ACCESS_DENIED" }, 403);
    }
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: {
        workspaceId: identity.workspaceId, userId: identity.userId,
      } },
      select: { role: true },
    });
    if (!member || member.role === "VIEWER") {
      return statusResponse({ error: "PDF_VISUAL_REQUEST_ACCESS_DENIED" }, 403);
    }
    const bound = await prisma.providerRouteBinding.findFirst({
      where: { workspaceId: identity.workspaceId, routeSlot: "PDF_VISUAL_STRUCTURE",
        connection: { status: "ACTIVE" } },
      select: { connectionId: true },
    });
    if (!bound) return statusResponse({ error: "PDF_VISUAL_PROVIDER_NOT_CONFIGURED" }, 409);
    // Exactly one paid attempt per durable source run, including across
    // concurrent POSTs, browser refreshes and worker/process restarts.
    const created = await prisma.pdfVisualReviewRequest.create({
      data: {
        workspaceId: identity.workspaceId, userId: identity.userId,
        sourceDocumentId: source.id, ingestionRunId: run.id,
        routingGeneration: run.routingGeneration!,
        sourcePdfSha256: source.sha256,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        status: "PENDING",
      },
      select: { id: true },
    });
    return statusResponse({ status: "PENDING", requestId: created.id }, 202);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "P2002")
      return statusResponse({ error: "PDF_VISUAL_REQUEST_ALREADY_EXISTS" }, 409);
    if (error instanceof z.ZodError)
      return statusResponse({ error: "PDF_VISUAL_EXPLICIT_CONSENT_REQUIRED" }, 400);
    return statusResponse({ error: "PDF_VISUAL_REQUEST_REJECTED" }, 403);
  }
}
