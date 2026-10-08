import { Prisma, prisma } from "@ai-cognitive/db";
import {
  isPromotableProductLanguage,
  normalizeIsbnForComparison,
  normalizeProductIdentityTitleForComparison,
} from "@ai-cognitive/domain";

/**
 * Human-origin identity correction. Lock order mirrors promotion:
 * membership -> SourceDocument -> current extraction -> Source -> Edition/Work.
 * Existing EPUB evidence, promotion decisions and original filename never change.
 * Only nonempty fields can be corrected, so later promotions cannot refill a
 * deliberately cleared field or overwrite a nonempty user-owned value.
 */
export type ProductIdentityManualValues = Partial<{
  title: string;
  language: string;
  isbn10: string;
  isbn13: string;
}>;

export type ProductIdentityCorrectionInput = {
  sourceDocumentId: string;
  expectedExtractionId: string;
  expectedWorkId: string;
  expectedEditionId: string;
  expectedWorkUpdatedAt: string;
  expectedEditionUpdatedAt: string;
  expectedValues: { title: string; language: string | null; isbn10: string | null; isbn13: string | null };
  values: ProductIdentityManualValues;
  reason: string;
};

export type ProductIdentityCorrectionOutcome =
  | { status: "STALE" | "SUPERSEDED" | "CONFLICT" | "NOOP" }
  | { status: "APPLIED"; auditId: string; changedFields: string[] };

const fields = ["title", "language", "isbn10", "isbn13"] as const;
type EditableField = typeof fields[number];

function canonicalValues(values: ProductIdentityManualValues): ProductIdentityManualValues {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("PRODUCT_IDENTITY_CORRECTION_INVALID");
  }
  const keys = Object.keys(values);
  if (keys.length < 1 || keys.length > 4 || keys.some((key) => !fields.includes(key as EditableField))) {
    throw new Error("PRODUCT_IDENTITY_CORRECTION_INVALID");
  }
  const canonical: ProductIdentityManualValues = {};
  for (const key of fields) {
    const value = values[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim()) throw new Error("PRODUCT_IDENTITY_CORRECTION_INVALID");
    if (key === "title") {
      const title = value.trim();
      if (title.length > 255 || !normalizeProductIdentityTitleForComparison(title)) {
        throw new Error("PRODUCT_IDENTITY_CORRECTION_INVALID");
      }
      canonical.title = title;
    } else if (key === "language") {
      if (!isPromotableProductLanguage(value)) throw new Error("PRODUCT_IDENTITY_CORRECTION_INVALID");
      canonical.language = value.trim();
    } else {
      const normalized = normalizeIsbnForComparison(value, key === "isbn10" ? "ISBN10" : "ISBN13");
      if (!normalized) throw new Error("PRODUCT_IDENTITY_CORRECTION_INVALID");
      canonical[key] = normalized;
    }
  }
  return canonical;
}

function validRevision(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

export async function correctProductIdentityForUser(
  context: { userId: string; workspaceId: string },
  input: ProductIdentityCorrectionInput,
): Promise<ProductIdentityCorrectionOutcome> {
  if (typeof input.reason !== "string" || input.reason.trim().length < 3 || input.reason.trim().length > 500 ||
      !validRevision(input.expectedWorkUpdatedAt) || !validRevision(input.expectedEditionUpdatedAt)) {
    throw new Error("PRODUCT_IDENTITY_CORRECTION_INVALID");
  }
  if (!input.expectedValues || typeof input.expectedValues.title !== "string" ||
      !["language", "isbn10", "isbn13"].every((key) => {
        const v = input.expectedValues[key as "language" | "isbn10" | "isbn13"];
        return v === null || typeof v === "string";
      })) throw new Error("PRODUCT_IDENTITY_CORRECTION_INVALID");
  const desired = canonicalValues(input.values);
  return prisma.$transaction(async (tx) => {
    const members = await tx.$queryRaw<Array<{ role: string }>>`
      SELECT "role"::text AS "role" FROM "WorkspaceMember"
      WHERE "workspaceId" = ${context.workspaceId} AND "userId" = ${context.userId}
      FOR UPDATE
    `;
    if (members.length !== 1) throw new Error("WORKSPACE_ACCESS_DENIED");
    if (!["OWNER", "EDITOR"].includes(members[0]!.role)) throw new Error("WORKSPACE_WRITE_ACCESS_DENIED");

    const documents = await tx.$queryRaw<Array<{ id: string; sourceId: string; mediaType: string }>>`
      SELECT "id", "sourceId", "mediaType" FROM "SourceDocument"
      WHERE "id" = ${input.sourceDocumentId} AND "workspaceId" = ${context.workspaceId}
      FOR UPDATE
    `;
    if (documents.length !== 1) throw new Error("SOURCE_DOCUMENT_ACCESS_DENIED");
    if (documents[0]!.mediaType !== "application/epub+zip") {
      throw new Error("PRODUCT_IDENTITY_SOURCE_FORMAT_NOT_PROMOTABLE");
    }

    const current = await tx.$queryRaw<Array<{ extractionId: string }>>`
      SELECT "extractionId" FROM "CurrentDocumentExtraction"
      WHERE "sourceDocumentId" = ${input.sourceDocumentId} AND "workspaceId" = ${context.workspaceId}
      FOR UPDATE
    `;
    if (current[0]?.extractionId !== input.expectedExtractionId) return { status: "STALE" };

    const sources = await tx.$queryRaw<Array<{ id: string; editionId: string | null }>>`
      SELECT "id", "editionId" FROM "Source"
      WHERE "id" = ${documents[0]!.sourceId} AND "workspaceId" = ${context.workspaceId}
      FOR UPDATE
    `;
    if (sources.length !== 1) throw new Error("PRODUCT_IDENTITY_SOURCE_BINDING_INVALID");
    const source = sources[0]!;
    const latest = await tx.sourceDocument.findFirst({
      where: { workspaceId: context.workspaceId, sourceId: source.id },
      orderBy: [{ version: "desc" }, { createdAt: "desc" }],
      select: { id: true },
    });
    if (latest?.id !== input.sourceDocumentId) return { status: "SUPERSEDED" };
    if (!source.editionId) throw new Error("PRODUCT_IDENTITY_NO_BOUND_EDITION");
    if (source.editionId !== input.expectedEditionId) return { status: "CONFLICT" };

    const records = await tx.$queryRaw<Array<{
      editionId: string; workId: string; workUpdatedAt: Date; editionUpdatedAt: Date;
      title: string; language: string | null; isbn10: string | null; isbn13: string | null;
    }>>`
      SELECT e."id" AS "editionId", e."workId" AS "workId",
             e."updatedAt" AS "editionUpdatedAt", w."updatedAt" AS "workUpdatedAt",
             w."title" AS "title", e."language" AS "language",
             e."isbn10" AS "isbn10", e."isbn13" AS "isbn13"
      FROM "Edition" e
      JOIN "Work" w ON w."id" = e."workId" AND w."workspaceId" = e."workspaceId"
      WHERE e."id" = ${source.editionId} AND e."workspaceId" = ${context.workspaceId}
      FOR UPDATE OF e, w
    `;
    if (records.length !== 1) throw new Error("PRODUCT_IDENTITY_SOURCE_BINDING_INVALID");
    const existing = records[0]!;
    if (existing.workId !== input.expectedWorkId ||
        existing.workUpdatedAt.toISOString() !== input.expectedWorkUpdatedAt ||
        existing.editionUpdatedAt.toISOString() !== input.expectedEditionUpdatedAt ||
        fields.some((field) => existing[field] !== input.expectedValues[field])) {
      return { status: "CONFLICT" };
    }

    const changes: Record<string, { before: string | null; after: string }> = {};
    const editionUpdates: Prisma.EditionUpdateInput = {};
    for (const field of fields) {
      const after = desired[field];
      if (after === undefined || existing[field] === after) continue;
      const key = field === "title" ? "work.title" : "edition." + field;
      changes[key] = { before: existing[field], after };
      if (field !== "title") editionUpdates[field] = after;
    }
    if (!Object.keys(changes).length) return { status: "NOOP" };
    if (changes["work.title"]) {
      await tx.work.update({
        where: { id_workspaceId: { id: existing.workId, workspaceId: context.workspaceId } },
        data: { title: desired.title! },
      });
    }
    if (Object.keys(editionUpdates).length) {
      await tx.edition.update({
        where: { id_workspaceId: { id: existing.editionId, workspaceId: context.workspaceId } },
        data: editionUpdates,
      });
    }
    const audit = await tx.productIdentityManualEdit.create({
      data: {
        workspaceId: context.workspaceId,
        sourceId: source.id,
        sourceDocumentId: input.sourceDocumentId,
        extractionId: input.expectedExtractionId,
        actorUserId: context.userId,
        workId: existing.workId,
        editionId: existing.editionId,
        reason: input.reason.trim(),
        changes: changes as Prisma.InputJsonObject,
      },
      select: { id: true },
    });
    return { status: "APPLIED", auditId: audit.id, changedFields: Object.keys(changes) };
  });
}
