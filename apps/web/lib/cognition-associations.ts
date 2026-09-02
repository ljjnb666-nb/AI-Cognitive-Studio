import { Prisma, prisma } from "@ai-cognitive/db";
import type { WebIdentityContext } from "./identity";
import { currentLineageJoin, isCognitionType, type CognitionType } from "./cognitions";

export const MIN_CROSS_BOOK_SIMILARITY = 0.8;
export const MAX_CROSS_BOOK_CANDIDATES = 24;
type Identity = Pick<WebIdentityContext, "workspaceId" | "userId">;
type VectorRow = { id: string; type: CognitionType; content: string; sourceDocumentId: string; sourceTitle: string; provider: string; model: string; modelVersion: string | null; embeddingVersion: string; embeddingIdentityHash: string; dimensions: number; vector: unknown };

function vector(value: unknown, dimensions: number): number[] | null {
  if (typeof value === "string") {
    try { value = JSON.parse(value) as unknown; } catch { return null; }
  }
  if (!Array.isArray(value) || value.length !== dimensions || !value.length) return null;
  const values = value.map(Number); return values.every(Number.isFinite) && values.some(value => value !== 0) ? values : null;
}
function cosine(a: number[], b: number[]) { let dot = 0, aa = 0, bb = 0; for (let index = 0; index < a.length; index += 1) { dot += a[index]! * b[index]!; aa += a[index]! ** 2; bb += b[index]! ** 2; } return aa && bb ? dot / Math.sqrt(aa * bb) : null; }

export async function findCrossBookCognitionConnections(identity: Identity, memoryItemId: string, limit = 3) {
  const source = await prisma.$queryRaw<VectorRow[]>(Prisma.sql`SELECT memory."id", memory."type", memory."content", memory."sourceDocumentId", source."displayName" AS "sourceTitle", embedding."provider", embedding."model", embedding."modelVersion", embedding."embeddingVersion", embedding."embeddingIdentityHash", embedding."dimensions", embedding."vector" FROM "BookMemoryItem" memory ${currentLineageJoin()} JOIN "BookMemoryEmbedding" embedding ON embedding."memoryItemId"=memory."id" AND embedding."workspaceId"=memory."workspaceId" WHERE memory."workspaceId"=${identity.workspaceId} AND memory."id"=${memoryItemId} AND run."status"='SUCCEEDED'::"AnalysisRunStatus" ORDER BY embedding."embeddingVersion" ASC, embedding."provider" ASC, embedding."model" ASC, embedding."modelVersion" ASC NULLS FIRST, embedding."embeddingIdentityHash" ASC, memory."id" ASC LIMIT 12`);
  const candidates = await prisma.$queryRaw<VectorRow[]>(Prisma.sql`SELECT memory."id", memory."type", memory."content", memory."sourceDocumentId", source."displayName" AS "sourceTitle", embedding."provider", embedding."model", embedding."modelVersion", embedding."embeddingVersion", embedding."embeddingIdentityHash", embedding."dimensions", embedding."vector" FROM "BookMemoryItem" memory ${currentLineageJoin()} JOIN "BookMemoryEmbedding" embedding ON embedding."memoryItemId"=memory."id" AND embedding."workspaceId"=memory."workspaceId" WHERE memory."workspaceId"=${identity.workspaceId} AND memory."id"<>${memoryItemId} AND run."status"='SUCCEEDED'::"AnalysisRunStatus" ORDER BY embedding."embeddingVersion" ASC, embedding."provider" ASC, embedding."model" ASC, embedding."modelVersion" ASC NULLS FIRST, embedding."embeddingIdentityHash" ASC, memory."id" ASC LIMIT ${MAX_CROSS_BOOK_CANDIDATES}`);
  const results = new Map<string, { id: string; type: CognitionType; content: string; sourceDocumentId: string; sourceTitle: string; similarity: number; semantics: "SEMANTICALLY_RELATED" }>();
  for (const left of source) { if (!isCognitionType(left.type)) continue; const a = vector(left.vector, left.dimensions); if (!a) continue; for (const right of candidates) { if (!isCognitionType(right.type) || right.sourceDocumentId === left.sourceDocumentId || right.provider !== left.provider || right.model !== left.model || right.modelVersion !== left.modelVersion || right.embeddingVersion !== left.embeddingVersion || right.dimensions !== left.dimensions) continue; const b = vector(right.vector, right.dimensions); if (!b) continue; const similarity = cosine(a, b); if (similarity === null || !Number.isFinite(similarity) || similarity < MIN_CROSS_BOOK_SIMILARITY) continue; const prior = results.get(right.id); if (!prior || similarity > prior.similarity) results.set(right.id, { id: right.id, type: right.type, content: right.content, sourceDocumentId: right.sourceDocumentId, sourceTitle: right.sourceTitle, similarity, semantics: "SEMANTICALLY_RELATED" }); }
  }
  return [...results.values()].sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id)).slice(0, Math.min(Math.max(1, limit), 3));
}
