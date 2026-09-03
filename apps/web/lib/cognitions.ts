import { Prisma, prisma } from "@ai-cognitive/db";
import type { WebIdentityContext } from "./identity";

const supportedTypes = [
  "SUMMARY",
  "CONCEPT",
  "ARGUMENT",
  "CLAIM",
  "QUOTE",
  "QUESTION",
  "COUNTERPOINT",
  "EXAMPLE",
  "STORY",
] as const;
export type CognitionType = (typeof supportedTypes)[number];

export const cognitionTypeLabels: Record<CognitionType, string> = {
  SUMMARY: "核心观点",
  CONCEPT: "关键概念",
  ARGUMENT: "主要论证",
  CLAIM: "重要证据",
  QUOTE: "重要证据",
  QUESTION: "值得质疑",
  COUNTERPOINT: "值得质疑",
  EXAMPLE: "案例",
  STORY: "故事",
};

export function isCognitionType(
  value: string | undefined,
): value is CognitionType {
  return Boolean(value && supportedTypes.includes(value as CognitionType));
}

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

export async function listCognitions(
  identity: Pick<WebIdentityContext, "workspaceId" | "userId">,
  input: { types?: CognitionType[]; cursor?: string; pageSize?: number } = {},
): Promise<{ items: CognitionListItem[]; nextCursor?: string }> {
  const pageSize = Math.min(Math.max(input.pageSize ?? 24, 1), 50);
  const cursor = decodeCursor(input.cursor);
  const selectedTypes = input.types?.filter(isCognitionType) ?? [];
  const typeClause = selectedTypes.length
    ? Prisma.sql`AND memory."type" IN (${cognitionTypeList(selectedTypes)})`
    : Prisma.empty;
  const cursorClause = cursor
    ? Prisma.sql`AND (memory."createdAt" < ${new Date(cursor.createdAt)} OR (memory."createdAt" = ${new Date(cursor.createdAt)} AND memory."id" < ${cursor.id}))`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<CognitionRow[]>(Prisma.sql`
    SELECT memory."id", memory."type", memory."content", memory."createdAt", memory."sourceDocumentId",
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
  return {
    items: page.map((row) => ({
      ...row,
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
): Promise<CognitionRow | null> {
  const rows = await prisma.$queryRaw<CognitionRow[]>(Prisma.sql`
    SELECT memory."id", memory."type", memory."content", memory."createdAt", memory."sourceDocumentId",
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
  const row = await currentCognitionRow(identity, cognitionId);
  if (!row) return null;
  const [evidence, relations] = await Promise.all([
    prisma.bookMemoryEvidence.findMany({
      where: { memoryItemId: row.id, workspaceId: identity.workspaceId },
      include: { sourceBlock: { select: { text: true, ordinal: true } } },
      orderBy: [
        { sourceBlock: { ordinal: "asc" } },
        { startOffset: "asc" },
        { id: "asc" },
      ],
      take: 24,
    }),
    prisma.bookMemoryRelation.findMany({
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
  const validEvidence = evidence.flatMap((item) => {
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
      ? [{ id: item.id, type: item.type, content: item.content }]
      : [];
  });
  return {
    ...row,
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
