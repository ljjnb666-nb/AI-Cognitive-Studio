import { readPublishedBookRevisionForRun } from "@ai-cognitive/book-intelligence";
import { Prisma, prisma } from "@ai-cognitive/db";
import type { WebIdentityContext } from "./identity";

import { isCognitionType, supportedTypes, type CognitionType } from "./cognition-types";
export { cognitionTypeLabels, isCognitionType, type CognitionType } from "./cognition-types";

type Cursor = { createdAt: string; id: string };
type CognitionRow = {
  id: string;
  type: CognitionType;
  content: string;
  createdAt: Date;
  sourceDocumentId: string;
  sourceTitle: string;
  saved: boolean;
};

function decodeCursor(value: string | undefined): Cursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Cursor;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.createdAt !== "string" ||
      Number.isNaN(Date.parse(parsed.createdAt))
    )
      return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function encodeCursor(row: CognitionRow): string {
  return Buffer.from(
    JSON.stringify({ id: row.id, createdAt: row.createdAt.toISOString() }),
  ).toString("base64url");
}

export function currentLineageJoin() {
  return Prisma.sql`
    INNER JOIN "BookAnalysisRun" run
      ON run."id" = memory."analysisRunId" AND run."workspaceId" = memory."workspaceId"
    INNER JOIN "CurrentBookIntelligence" current_intelligence
      ON current_intelligence."analysisRunId" = memory."analysisRunId"
      AND current_intelligence."workspaceId" = memory."workspaceId"
      AND current_intelligence."sourceDocumentId" = memory."sourceDocumentId"
      AND current_intelligence."extractionId" = memory."extractionId"
    INNER JOIN "CurrentDocumentExtraction" current_extraction
      ON current_extraction."workspaceId" = current_intelligence."workspaceId"
      AND current_extraction."sourceDocumentId" = current_intelligence."sourceDocumentId"
      AND current_extraction."extractionId" = current_intelligence."extractionId"
    INNER JOIN "SourceDocument" document
      ON document."id" = memory."sourceDocumentId" AND document."workspaceId" = memory."workspaceId"
    INNER JOIN "Source" source
      ON source."id" = document."sourceId" AND source."workspaceId" = document."workspaceId"
  `;
}

function cognitionTypeList(types: readonly CognitionType[]) {
  return Prisma.join(
    types.map((type) => Prisma.sql`${type}::"BookMemoryItemType"`),
  );
}

export type CognitionListItem = Omit<CognitionRow, "createdAt"> & {
  createdAt: string;
};

export async function publishedCognitionChanges(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  analysisRunIds: string[],
) {
  const revisions = await Promise.all([...new Set(analysisRunIds)].map((analysisRunId) =>
    readPublishedBookRevisionForRun(tx, { workspaceId, analysisRunId }),
  ));
  return new Map(revisions.flatMap(({ revision }) =>
    revision?.memories.map((memory) => [memory.id, memory] as const) ?? [],
  ));
}

export async function listCognitions(
  identity: Pick<WebIdentityContext, "workspaceId" | "userId">,
  input: { types?: CognitionType[]; cursor?: string; pageSize?: number } = {},
): Promise<{ items: CognitionListItem[]; nextCursor?: string }> {
  return prisma.$transaction(
    (tx) => readCognitions(tx, identity, input),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

async function readCognitions(
  tx: Prisma.TransactionClient,
  identity: Pick<WebIdentityContext, "workspaceId" | "userId">,
  input: { types?: CognitionType[]; cursor?: string; pageSize?: number },
) {
  const pageSize = Math.min(Math.max(input.pageSize ?? 24, 1), 50);
  const cursor = decodeCursor(input.cursor);
  const selectedTypes = input.types?.filter(isCognitionType) ?? [];
  const typeClause = selectedTypes.length
    ? Prisma.sql`AND memory."type" IN (${cognitionTypeList(selectedTypes)})`
    : Prisma.empty;
  const cursorClause = cursor
    ? Prisma.sql`AND (memory."createdAt" < ${new Date(cursor.createdAt)} OR (memory."createdAt" = ${new Date(cursor.createdAt)} AND memory."id" < ${cursor.id}))`
    : Prisma.empty;
  const rows = await tx.$queryRaw<Array<CognitionRow & { analysisRunId: string }>>(Prisma.sql`
    SELECT memory."id", memory."type", memory."content", memory."createdAt", memory."sourceDocumentId",
      memory."analysisRunId",
      source."displayName" AS "sourceTitle", (state."id" IS NOT NULL AND state."state" = 'SAVED'::"UserCognitionStateKind") AS "saved"
    FROM "BookMemoryItem" memory
    ${currentLineageJoin()}
    LEFT JOIN "UserCognitionState" state
      ON state."memoryItemId" = memory."id" AND state."workspaceId" = memory."workspaceId" AND state."userId" = ${identity.userId}
    WHERE memory."workspaceId" = ${identity.workspaceId}
      AND run."status" = 'SUCCEEDED'::"AnalysisRunStatus"
      AND memory."type" IN (${cognitionTypeList(supportedTypes)})
      ${typeClause}
      ${cursorClause}
    ORDER BY memory."createdAt" DESC, memory."id" DESC
    LIMIT ${pageSize + 1}
  `);
  const page = rows.slice(0, pageSize);
  const changes = await publishedCognitionChanges(tx, identity.workspaceId, page.map((row) => row.analysisRunId));
  return {
    items: page.map(({ analysisRunId: _analysisRunId, ...row }) => ({
      ...row,
      content: changes.get(row.id)?.after ?? row.content,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor:
      rows.length > pageSize && page.length
        ? encodeCursor(page[page.length - 1]!)
        : undefined,
  };
}

export type CognitionDetail = CognitionListItem & {
  evidence: Array<{
    id: string;
    excerpt: string;
    blockOrdinal: number;
    startOffset: number;
    endOffset: number;
  }>;
  related: Array<{ id: string; type: CognitionType; content: string }>;
};

async function currentCognitionRow(
  identity: Pick<WebIdentityContext, "workspaceId" | "userId">,
  cognitionId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<(CognitionRow & { analysisRunId: string; extractionId: string }) | null> {
  const rows = await tx.$queryRaw<Array<CognitionRow & { analysisRunId: string; extractionId: string }>>(Prisma.sql`
    SELECT memory."id", memory."type", memory."content", memory."createdAt", memory."sourceDocumentId",
      memory."analysisRunId", memory."extractionId",
      source."displayName" AS "sourceTitle", (state."id" IS NOT NULL AND state."state" = 'SAVED'::"UserCognitionStateKind") AS "saved"
    FROM "BookMemoryItem" memory
    ${currentLineageJoin()}
    LEFT JOIN "UserCognitionState" state
      ON state."memoryItemId" = memory."id" AND state."workspaceId" = memory."workspaceId" AND state."userId" = ${identity.userId}
    WHERE memory."id" = ${cognitionId} AND memory."workspaceId" = ${identity.workspaceId}
      AND run."status" = 'SUCCEEDED'::"AnalysisRunStatus"
      AND memory."type" IN (${cognitionTypeList(supportedTypes)})
    LIMIT 1
  `);
  return rows[0] ?? null;
}

export async function cognitionDetail(
  identity: Pick<WebIdentityContext, "workspaceId" | "userId">,
  cognitionId: string,
): Promise<CognitionDetail | null> {
  return prisma.$transaction(
    (tx) => readCognitionDetail(tx, identity, cognitionId),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

async function readCognitionDetail(
  tx: Prisma.TransactionClient,
  identity: Pick<WebIdentityContext, "workspaceId" | "userId">,
  cognitionId: string,
): Promise<CognitionDetail | null> {
  const row = await currentCognitionRow(identity, cognitionId, tx);
  if (!row) return null;
  const { analysisRunId, extractionId, ...displayRow } = row;
  const [{ revision }, evidence, relations] = await Promise.all([
    readPublishedBookRevisionForRun(tx, { workspaceId: identity.workspaceId, analysisRunId }),
    tx.bookMemoryEvidence.findMany({
      where: { memoryItemId: row.id, workspaceId: identity.workspaceId },
      include: { sourceBlock: { select: { text: true, ordinal: true } } },
      orderBy: [
        { sourceBlock: { ordinal: "asc" } },
        { startOffset: "asc" },
        { id: "asc" },
      ],
      take: 24,
    }),
    tx.bookMemoryRelation.findMany({
      where: {
        workspaceId: identity.workspaceId,
        OR: [{ fromMemoryItemId: row.id }, { toMemoryItemId: row.id }],
      },
      include: {
        fromMemoryItem: { select: { id: true, type: true, content: true } },
        toMemoryItem: { select: { id: true, type: true, content: true } },
      },
      orderBy: { createdAt: "asc" },
      take: 12,
    }),
  ]);
  const changes = new Map(revision?.memories.map((memory) => [memory.id, memory]));
  const change = changes.get(row.id);
  const spans = change?.addedEvidence ?? [];
  const blocks = spans.length ? await tx.sourceBlock.findMany({
    where: { extractionId, id: { in: spans.map((span) => span.sourceBlockId) } },
    select: { id: true, ordinal: true, text: true },
  }) : [];
  const byBlockId = new Map(blocks.map((block) => [block.id, block]));
  const supplements = spans.flatMap((span) => {
    const sourceBlock = byBlockId.get(span.sourceBlockId);
    if (!sourceBlock) throw new Error("BOOK_REVISION_EVIDENCE_INVALID");
    if (evidence.some((item) => item.sourceBlockId === span.sourceBlockId &&
      item.startOffset === span.startOffset && item.endOffset === span.endOffset)) return [];
    return [{ ...span, sourceBlock, id: `revision:${span.sourceBlockId}:${span.startOffset}:${span.endOffset}` }];
  });
  const validEvidence = [...supplements, ...evidence].slice(0, 24).flatMap((item) => {
    const { text } = item.sourceBlock;
    if (
      item.startOffset < 0 ||
      item.endOffset < item.startOffset ||
      item.endOffset > text.length
    )
      return [];
    return [
      {
        id: item.id,
        excerpt: text.slice(item.startOffset, item.endOffset),
        blockOrdinal: item.sourceBlock.ordinal,
        startOffset: item.startOffset,
        endOffset: item.endOffset,
      },
    ];
  });
  const related = relations.flatMap((relation) => {
    const item =
      relation.fromMemoryItemId === row.id
        ? relation.toMemoryItem
        : relation.fromMemoryItem;
    return isCognitionType(item.type)
      ? [{ id: item.id, type: item.type, content: changes.get(item.id)?.after ?? item.content }]
      : [];
  });
  return {
    ...displayRow,
    content: change?.after ?? row.content,
    createdAt: row.createdAt.toISOString(),
    evidence: validEvidence,
    related,
  };
}

export async function updateCognitionUserState(
  identity: Pick<WebIdentityContext, "workspaceId" | "userId">,
  input: { cognitionId: string; saved: boolean },
) {
  const membership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: identity.workspaceId,
        userId: identity.userId,
      },
    },
    select: { userId: true },
  });
  if (!membership || !(await currentCognitionRow(identity, input.cognitionId)))
    throw new Error("COGNITION_NOT_FOUND");
  if (!input.saved) {
    await prisma.userCognitionState.upsert({
      where: {
        workspaceId_userId_memoryItemId: {
          workspaceId: identity.workspaceId,
          userId: identity.userId,
          memoryItemId: input.cognitionId,
        },
      },
      create: {
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        memoryItemId: input.cognitionId,
        state: "ARCHIVED",
      },
      update: { state: "ARCHIVED" },
    });
    return { saved: false };
  }
  await prisma.userCognitionState.upsert({
    where: {
      workspaceId_userId_memoryItemId: {
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        memoryItemId: input.cognitionId,
      },
    },
    create: {
      workspaceId: identity.workspaceId,
      userId: identity.userId,
      memoryItemId: input.cognitionId,
      state: "SAVED",
    },
    update: { state: "SAVED" },
  });
  return { saved: true };
}
