import { prisma } from "@ai-cognitive/db";
import { tryParseProductIdentityCandidate, type ProductIdentityCandidate } from "@ai-cognitive/domain";

/**
 * Advisory, workspace-scoped product identity preview.
 *
 * This read is NOT an authority to mutate Work/Edition. Every POST must pass
 * expectedExtractionId and recheck the durable current/version/role fences
 * inside promoteCurrentProductIdentityForUser's transaction.
 */
export type ProductIdentityPreviewState =
  | "UNSUPPORTED_FORMAT"
  | "NO_CURRENT_EXTRACTION"
  | "QUALITY_NOT_PROMOTABLE"
  | "SUPERSEDED"
  | "CANDIDATE_UNAVAILABLE"
  | "ALREADY_RECORDED"
  | "MISSING_TITLE"
  | "READY";

export type ProductIdentityPreview = {
  sourceDocumentId: string;
  latestSourceDocumentId: string;
  currentExtractionId: string | null;
  qualityStatus: string | null;
  state: ProductIdentityPreviewState;
  canWrite: boolean;
  canPromote: boolean;
  candidate: ProductIdentityCandidate | null;
  product: {
    workId: string;
    editionId: string;
    title: string;
    workUpdatedAt: string;
    editionUpdatedAt: string;
    language: string | null;
    isbn10: string | null;
    isbn13: string | null;
  } | null;
  recentCorrections: Array<{
    id: string;
    actorUserId: string;
    reason: string;
    changes: unknown;
    createdAt: string;
  }>;
  promotion: {
    status: "APPLIED" | "NOOP" | "CONFLICT" | "BLOCKED";
    reasonCode: string | null;
    appliedFields: unknown;
    conflicts: unknown;
    ignoredFields: unknown;
  } | null;
};

export async function readProductIdentityPreviewForUser(
  context: { userId: string; workspaceId: string },
  sourceDocumentId: string,
): Promise<ProductIdentityPreview> {
  const [member, document] = await Promise.all([
    prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: context.workspaceId, userId: context.userId } },
      select: { role: true },
    }),
    prisma.sourceDocument.findFirst({
      where: { id: sourceDocumentId, workspaceId: context.workspaceId },
      select: {
        id: true, sourceId: true, mediaType: true,
        source: {
          select: {
            edition: {
              select: {
                id: true, workId: true, language: true, isbn10: true, isbn13: true, updatedAt: true,
                work: { select: { title: true, updatedAt: true } },
              },
            },
          },
        },
      },
    }),
  ]);
  // Uniform denial prevents a caller from distinguishing cross-tenant IDs
  // from documents that do not exist in the requested workspace.
  if (!member || !document) throw new Error("SOURCE_DOCUMENT_ACCESS_DENIED");

  const [latestDocument, current, edits] = await Promise.all([
    prisma.sourceDocument.findFirst({
      where: { sourceId: document.sourceId, workspaceId: context.workspaceId },
      orderBy: { version: "desc" },
      select: { id: true },
    }),
    prisma.currentDocumentExtraction.findUnique({
      where: { sourceDocumentId_workspaceId: { sourceDocumentId, workspaceId: context.workspaceId } },
      select: {
        extractionId: true,
        extraction: {
          select: {
            qualityStatus: true, productIdentityCandidate: true,
            productIdentityPromotion: {
              select: { status: true, reasonCode: true, appliedFields: true, conflicts: true, ignoredFields: true },
            },
          },
        },
      },
    }),
    prisma.productIdentityManualEdit.findMany({
      where: { workspaceId: context.workspaceId, sourceId: document.sourceId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 10,
      select: { id: true, actorUserId: true, reason: true, changes: true, createdAt: true },
    }),
  ]);
  if (!latestDocument) throw new Error("PRODUCT_IDENTITY_SOURCE_BINDING_INVALID");

  const canWrite = member.role === "OWNER" || member.role === "EDITOR";
  const evidence = current?.extraction.productIdentityCandidate;
  const candidate = evidence == null ? null : tryParseProductIdentityCandidate(evidence);
  const qualityStatus = current?.extraction.qualityStatus ?? null;
  const promotion = current?.extraction.productIdentityPromotion ?? null;
  const edition = document.source.edition;
  const product = edition ? {
    workId: edition.workId,
    editionId: edition.id,
    title: edition.work.title,
    workUpdatedAt: edition.work.updatedAt.toISOString(),
    editionUpdatedAt: edition.updatedAt.toISOString(),
    language: edition.language,
    isbn10: edition.isbn10,
    isbn13: edition.isbn13,
  } : null;

  let state: ProductIdentityPreviewState;
  if (document.mediaType !== "application/epub+zip") state = "UNSUPPORTED_FORMAT";
  else if (!current) state = "NO_CURRENT_EXTRACTION";
  else if (latestDocument.id !== document.id) state = "SUPERSEDED";
  else if (qualityStatus !== "ACCEPTED" && qualityStatus !== "DEGRADED") state = "QUALITY_NOT_PROMOTABLE";
  else if (promotion) state = "ALREADY_RECORDED";
  else if (!candidate) state = "CANDIDATE_UNAVAILABLE";
  else if (!product && (!candidate.title || !candidate.title.value.trim())) state = "MISSING_TITLE";
  else state = "READY";

  return {
    sourceDocumentId: document.id,
    latestSourceDocumentId: latestDocument.id,
    currentExtractionId: current?.extractionId ?? null,
    qualityStatus,
    state,
    canWrite,
    canPromote: canWrite && state === "READY",
    candidate,
    product,
    promotion,
    recentCorrections: edits.map((edit) => ({ ...edit, createdAt: edit.createdAt.toISOString() })),
  };
}