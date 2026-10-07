import { Prisma, prisma } from "@ai-cognitive/db";
import {
  classifyProductIdentifierForPromotion,
  isPromotableProductLanguage,
  normalizeProductIdentityTitleForComparison,
  parseProductIdentityCandidate,
} from "@ai-cognitive/domain";

export const PRODUCT_IDENTITY_PROMOTION_REASON_CODES = [
  "MISSING_TITLE_FOR_UNBOUND_SOURCE",
] as const;
export type ProductIdentityPromotionReasonCode = (typeof PRODUCT_IDENTITY_PROMOTION_REASON_CODES)[number];

export type ProductIdentityConflict = {
  field: "work.title" | "edition.language" | "edition.isbn10" | "edition.isbn13";
  existing: string;
  candidate: string;
};

export type ProductIdentityIgnoredField = {
  field: "language" | "identifier";
  reason: "INVALID_LANGUAGE" | "UNCLASSIFIED_IDENTIFIER" | "INVALID_EXPLICIT_ISBN";
};

type PersistedPromotion = {
  id: string;
  status: "APPLIED" | "NOOP" | "CONFLICT" | "BLOCKED";
  reasonCode: string | null;
  workId: string | null;
  editionId: string | null;
  appliedFields: unknown;
  conflicts: unknown;
  ignoredFields: unknown;
};

export type ProductIdentityPromotionOutcome =
  | { status: "STALE"; expectedExtractionId: string; currentExtractionId: string | null }
  | { status: "APPLIED" | "NOOP" | "CONFLICT" | "BLOCKED"; promotion: PersistedPromotion };

type PromotionInput = {
  workspaceId: string;
  sourceDocumentId: string;
  expectedExtractionId: string;
};

function jsonArray<T>(value: T[]): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function sameTitle(left: string, right: string): boolean {
  return normalizeProductIdentityTitleForComparison(left) === normalizeProductIdentityTitleForComparison(right);
}

function sameLanguage(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

async function createPromotion(
  tx: Prisma.TransactionClient,
  input: PromotionInput & {
    status: "APPLIED" | "NOOP" | "CONFLICT" | "BLOCKED";
    reasonCode?: ProductIdentityPromotionReasonCode;
    workId?: string | null;
    editionId?: string | null;
    appliedFields?: string[];
    conflicts?: ProductIdentityConflict[];
    ignoredFields?: ProductIdentityIgnoredField[];
  },
): Promise<ProductIdentityPromotionOutcome> {
  const promotion = await tx.productIdentityPromotion.create({
    data: {
      workspaceId: input.workspaceId,
      sourceDocumentId: input.sourceDocumentId,
      extractionId: input.expectedExtractionId,
      status: input.status,
      reasonCode: input.reasonCode,
      workId: input.workId ?? null,
      editionId: input.editionId ?? null,
      appliedFields: jsonArray(input.appliedFields ?? []),
      conflicts: jsonArray(input.conflicts ?? []),
      ignoredFields: jsonArray(input.ignoredFields ?? []),
    },
  });
  return { status: input.status, promotion };
}

async function promoteInTransaction(tx: Prisma.TransactionClient, input: PromotionInput): Promise<ProductIdentityPromotionOutcome> {
  const locked = await tx.$queryRaw<Array<{ id: string; sourceId: string; mediaType: string }>>`
    SELECT "id", "sourceId", "mediaType"
    FROM "SourceDocument"
    WHERE "id" = ${input.sourceDocumentId} AND "workspaceId" = ${input.workspaceId}
    FOR UPDATE
  `;
  if (locked.length !== 1) throw new Error("SOURCE_DOCUMENT_ACCESS_DENIED");
  if (locked[0]!.mediaType !== "application/epub+zip") throw new Error("PRODUCT_IDENTITY_SOURCE_FORMAT_NOT_PROMOTABLE");

  const current = await tx.currentDocumentExtraction.findUnique({
    where: { sourceDocumentId_workspaceId: { sourceDocumentId: input.sourceDocumentId, workspaceId: input.workspaceId } },
    select: { extractionId: true },
  });
  if (current?.extractionId !== input.expectedExtractionId) {
    return { status: "STALE", expectedExtractionId: input.expectedExtractionId, currentExtractionId: current?.extractionId ?? null };
  }

  const extraction = await tx.documentExtraction.findUnique({
    where: { id: input.expectedExtractionId },
    select: {
      id: true,
      sourceDocumentId: true,
      workspaceId: true,
      qualityStatus: true,
      productIdentityCandidate: true,
    },
  });
  if (!extraction ||
      extraction.sourceDocumentId !== input.sourceDocumentId ||
      extraction.workspaceId !== input.workspaceId ||
      !["ACCEPTED", "DEGRADED"].includes(extraction.qualityStatus ?? "")) {
    throw new Error("PRODUCT_IDENTITY_EXTRACTION_NOT_PROMOTABLE");
  }

  let candidate: ReturnType<typeof parseProductIdentityCandidate>;
  try {
    candidate = parseProductIdentityCandidate(extraction.productIdentityCandidate);
  } catch {
    throw new Error("PRODUCT_IDENTITY_CANDIDATE_INVALID");
  }
  const existingPromotion = await tx.productIdentityPromotion.findUnique({ where: { extractionId: extraction.id } });
  if (existingPromotion) return { status: existingPromotion.status, promotion: existingPromotion };

  // Product identity is Source-scoped, while SourceDocument is version-scoped.
  // Lock the Source row so concurrent promotions from two document versions
  // cannot both observe editionId = NULL and create competing identities.
  const sourceRows = await tx.$queryRaw<Array<{ id: string; editionId: string | null }>>`
    SELECT "id", "editionId"
    FROM "Source"
    WHERE "id" = ${locked[0]!.sourceId} AND "workspaceId" = ${input.workspaceId}
    FOR UPDATE
  `;
  if (sourceRows.length !== 1) throw new Error("PRODUCT_IDENTITY_SOURCE_BINDING_INVALID");
  const source = sourceRows[0]!;

  const ignoredFields: ProductIdentityIgnoredField[] = [];
  const language = candidate.language && isPromotableProductLanguage(candidate.language.value)
    ? candidate.language.value.trim()
    : null;
  if (candidate.language && !language) ignoredFields.push({ field: "language", reason: "INVALID_LANGUAGE" });

  const identifier = candidate.identifier
    ? classifyProductIdentifierForPromotion(candidate.identifier.value)
    : { kind: "UNCLASSIFIED" as const };
  let isbn10: string | null = null;
  let isbn13: string | null = null;
  if (candidate.identifier) {
    if (identifier.kind === "ISBN10") isbn10 = identifier.value;
    else if (identifier.kind === "ISBN13") isbn13 = identifier.value;
    else if (identifier.kind === "INVALID_EXPLICIT_ISBN") ignoredFields.push({ field: "identifier", reason: "INVALID_EXPLICIT_ISBN" });
    else ignoredFields.push({ field: "identifier", reason: "UNCLASSIFIED_IDENTIFIER" });
  }

  if (!source.editionId) {
    if (!candidate.title) {
      return createPromotion(tx, {
        ...input,
        status: "BLOCKED",
        reasonCode: "MISSING_TITLE_FOR_UNBOUND_SOURCE",
        ignoredFields,
      });
    }

    const work = await tx.work.create({
      data: { workspaceId: input.workspaceId, title: candidate.title.value },
      select: { id: true },
    });
    const edition = await tx.edition.create({
      data: {
        workspaceId: input.workspaceId,
        workId: work.id,
        language: language ?? undefined,
        isbn10: isbn10 ?? undefined,
        isbn13: isbn13 ?? undefined,
      },
      select: { id: true },
    });
    await tx.source.update({
      where: { id_workspaceId: { id: source.id, workspaceId: input.workspaceId } },
      data: { editionId: edition.editionId },
    });

    const appliedFields = ["source.editionId", "work.title"];
    if (language) appliedFields.push("edition.language");
    if (isbn10) appliedFields.push("edition.isbn10");
    if (isbn13) appliedFields.push("edition.isbn13");
    return createPromotion(tx, {
      ...input,
      status: "APPLIED",
      workId: work.id,
      editionId: edition.editionId,
      appliedFields,
      ignoredFields,
    });
  }

  // Lock both Edition and Work before comparing or filling fields. This makes
  // the read/decision/write sequence safe against concurrent user edits too.
  const identities = await tx.$queryRaw<Array<{
    editionId: string;
    workId: string;
    title: string;
    language: string | null;
    isbn10: string | null;
    isbn13: string | null;
  }>>`
    SELECT e."id" AS "editionId", e."workId" AS "workId", w."title" AS "title",
           e."language" AS "language", e."isbn10" AS "isbn10", e."isbn13" AS "isbn13"
    FROM "Edition" e
    JOIN "Work" w ON w."id" = e."workId" AND w."workspaceId" = e."workspaceId"
    WHERE e."id" = ${source.editionId} AND e."workspaceId" = ${input.workspaceId}
    FOR UPDATE OF e, w
  `;
  if (identities.length !== 1) throw new Error("PRODUCT_IDENTITY_SOURCE_BINDING_INVALID");
  const edition = identities[0]!;

  const conflicts: ProductIdentityConflict[] = [];
  if (candidate.title && !sameTitle(edition.title, candidate.title.value)) {
    conflicts.push({ field: "work.title", existing: edition.title, candidate: candidate.title.value });
  }
  if (language && edition.language && !sameLanguage(edition.language, language)) {
    conflicts.push({ field: "edition.language", existing: edition.language, candidate: language });
  }
  if (isbn10 && edition.isbn10 && edition.isbn10 !== isbn10) {
    conflicts.push({ field: "edition.isbn10", existing: edition.isbn10, candidate: isbn10 });
  }
  if (isbn13 && edition.isbn13 && edition.isbn13 !== isbn13) {
    conflicts.push({ field: "edition.isbn13", existing: edition.isbn13, candidate: isbn13 });
  }

  if (conflicts.length) {
    return createPromotion(tx, {
      ...input,
      status: "CONFLICT",
      workId: edition.workId,
      editionId: edition.editionId,
      conflicts,
      ignoredFields,
    });
  }

  const editionData: Prisma.EditionUpdateInput = {};
  const appliedFields: string[] = [];
  if (language && !edition.language) {
    editionData.language = language;
    appliedFields.push("edition.language");
  }
  if (isbn10 && !edition.isbn10) {
    editionData.isbn10 = isbn10;
    appliedFields.push("edition.isbn10");
  }
  if (isbn13 && !edition.isbn13) {
    editionData.isbn13 = isbn13;
    appliedFields.push("edition.isbn13");
  }
  if (appliedFields.length) {
    await tx.edition.update({ where: { id_workspaceId: { id: edition.editionId, workspaceId: input.workspaceId } }, data: editionData });
  }

  return createPromotion(tx, {
    ...input,
    status: appliedFields.length ? "APPLIED" : "NOOP",
    workId: edition.workId,
    editionId: edition.editionId,
    appliedFields,
    ignoredFields,
  });
}

/**
 * Trusted boundary for controlled product identity promotion.
 *
 * The caller MUST pass the extraction it observed. The transaction locks the
 * SourceDocument and refuses promotion if CurrentDocumentExtraction moved,
 * preventing an old page/worker from promoting stale extraction metadata.
 */
export async function promoteCurrentProductIdentityForUser(
  context: { userId: string; workspaceId: string },
  input: { sourceDocumentId: string; expectedExtractionId: string },
): Promise<ProductIdentityPromotionOutcome> {
  return prisma.$transaction(async (tx) => {
    const membership = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: context.workspaceId, userId: context.userId } },
      select: { userId: true },
    });
    if (!membership) throw new Error("WORKSPACE_ACCESS_DENIED");
    return promoteInTransaction(tx, { workspaceId: context.workspaceId, ...input });
  });
}
