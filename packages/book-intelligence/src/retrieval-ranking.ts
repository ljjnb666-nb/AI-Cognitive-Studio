import { Prisma, prisma } from "@ai-cognitive/db";

/** Return only top-k IDs; vector arrays and complete evidence are never loaded for all rows. */
export async function rankedMemoryIds(input: { workspaceId: string; analysisRunId: string; embeddingIdentityHash: string; vector: number[]; query: string; limit: number }) {
  if (!input.vector.length || !input.vector.every(Number.isFinite)) throw new Error("EMBEDDING_PROVIDER_RESPONSE_INVALID");
  const limit = Math.min(100, Math.max(1, Math.trunc(input.limit)));
  return prisma.$queryRaw<Array<{ id: string; score: number }>>(Prisma.sql`
    SELECT e."id", (acs_cosine(e."vector", ${JSON.stringify(input.vector)}::jsonb) +
      CASE WHEN ${input.query.trim().length > 0} AND strpos(lower(m."content"), lower(${input.query.slice(0, 200)})) > 0 THEN 0.05 ELSE 0 END) AS score
    FROM "BookMemoryEmbedding" e JOIN "BookMemoryItem" m ON m."id"=e."memoryItemId" AND m."workspaceId"=e."workspaceId"
    WHERE e."workspaceId"=${input.workspaceId} AND e."analysisRunId"=${input.analysisRunId}
      AND e."embeddingIdentityHash"=${input.embeddingIdentityHash}
      AND acs_cosine(e."vector", ${JSON.stringify(input.vector)}::jsonb) IS NOT NULL
    ORDER BY score DESC NULLS LAST, e."memoryItemId" ASC
    LIMIT ${limit}`);
}
